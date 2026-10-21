import { parseSeries, parseArchive } from './series.mjs';
import { summarizeHealth } from './health-card.mjs';
import { timingSafeEqual, verifyViewerToken } from './dashboard-auth.mjs';
export { HealthStore } from './health-store.mjs';

const MAX_BODY_BYTES = 1024 * 1024;
// Workout batches include GPS routes the service does not store; a long ride can be several MiB.
// Cloudflare accepts up to 100 MiB on the free plan; 25 MiB covers roughly 6 h of 1 Hz routes.
const MAX_WORKOUT_BODY_BYTES = 25 * 1024 * 1024;

function reply(status, data) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function readBody(request, maxBytes = MAX_BODY_BYTES) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new RangeError('body too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function configured(env) {
  if (!env.HAE_API_KEY || !env.FEISHU_WEBHOOK_URL || !env.FEISHU_SIGN_SECRET) return false;
  try {
    const url = new URL(env.FEISHU_WEBHOOK_URL);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      ['open.feishu.cn', 'open.larkoffice.com', 'open.larksuite.com'].includes(url.hostname) &&
      /^\/open-apis\/bot\/v2\/hook\/[^/]+$/.test(url.pathname);
  } catch { return false; }
}

// The HTML box is served from inside Feishu docs; its real Origin is unknown
// until observed in the iPhone client, so there is deliberately NO default
// allowlist: an unconfigured deployment answers preflights with 403 instead of
// guessing a platform domain. Configure DASHBOARD_VIEWER_ORIGINS only with
// origins actually seen on real document requests.
function dashboardCorsHeaders(env, request) {
  const origin = request.headers.get('Origin');
  const allowed = (env.DASHBOARD_VIEWER_ORIGINS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-None-Match',
    'Access-Control-Expose-Headers': 'ETag',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function withCors(response, headers) {
  if (!headers) return response;
  const merged = new Headers(response.headers);
  for (const [k, v] of Object.entries(headers)) merged.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
}

export async function handleRequest(request, env) {
  const path = new URL(request.url).pathname;
  if (path === '/healthz' && request.method === 'GET') return reply(200, { ok: true });
  const stream = ({ '/ingest': 'legacy', '/ingest/health': 'health', '/ingest/sleep': 'sleep', '/ingest/workouts': 'workouts', '/ingest/hrv': 'hrv', '/ingest/heart': 'heart', '/ingest/sleep-segments': 'sleep-segments' })[path];
  const read = ['/status', '/card', '/analysis', '/snapshot', '/dashboard', '/badge'].includes(path);
  const refresh = path === '/signature/refresh' || path === '/dashboard-cache/refresh';
  if (!stream && !read && !refresh) return reply(404, { error: 'not_found' });
  // Browser preflight carries no credentials; answer it before auth checks.
  if (path === '/dashboard' && request.method === 'OPTIONS') {
    const cors = dashboardCorsHeaders(env, request);
    return new Response(null, { status: cors ? 204 : 403, headers: cors ?? undefined });
  }
  if (request.method !== (read ? 'GET' : 'POST')) return reply(405, { error: 'method_not_allowed' });
  if (!configured(env) || !env.HEALTH_STORE) return reply(503, { error: 'not_configured' });
  const cors = path === '/dashboard' ? dashboardCorsHeaders(env, request) : null;
  const apiKey = request.headers.get('X-API-Key');
  let authorized = timingSafeEqual(apiKey, env.HAE_API_KEY) ||
    (read && Boolean(env.ANALYSIS_API_KEY) && timingSafeEqual(apiKey, env.ANALYSIS_API_KEY)) ||
    (path === '/badge' && Boolean(env.BADGE_API_KEY) && timingSafeEqual(apiKey, env.BADGE_API_KEY));
  // The dashboard additionally accepts short-lived HMAC viewer assertions minted by the Miaobi FaaS.
  if (!authorized && path === '/dashboard') {
    const authHeader = request.headers.get('Authorization') ?? '';
    const match = /^Bearer (.+)$/.exec(authHeader);
    if (match) {
      const result = await verifyViewerToken(match[1], env);
      if (!result.ok) return withCors(reply(401, { error: 'unauthorized', reason: result.reason }), cors);
      authorized = true;
    }
  }
  // The dashboard cache refresh only regenerates the owner's private Base view,
  // so the read-only analysis key may trigger it in addition to the upload key.
  if (!authorized && path === '/dashboard-cache/refresh') {
    authorized = Boolean(env.ANALYSIS_API_KEY) && timingSafeEqual(apiKey, env.ANALYSIS_API_KEY);
  }
  if (!authorized) return withCors(reply(401, { error: 'unauthorized' }), cors);
  const store = env.HEALTH_STORE.get(env.HEALTH_STORE.idFromName('personal'));
  if (read || refresh) {
    // Preserve the query string (e.g. /dashboard?range=7d) across the service-style forward.
    const forwardPath = `${path}${new URL(request.url).search}`;
    // Forward only the conditional header the DO understands, for dashboard 304s.
    const forwardHeaders = {};
    if (path === '/dashboard') {
      const ifNoneMatch = request.headers.get('If-None-Match');
      if (ifNoneMatch) forwardHeaders['If-None-Match'] = ifNoneMatch;
    }
    try {
      const response = await store.fetch(new Request(`https://store${forwardPath}`,
        { method: request.method, headers: forwardHeaders }));
      return withCors(response, cors);
    } catch { return withCors(reply(503, { error: 'storage_unavailable', retryable: true }), cors); }
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(request, stream === 'workouts' ? MAX_WORKOUT_BODY_BYTES : MAX_BODY_BYTES));
  } catch (error) {
    return reply(error instanceof RangeError ? 413 : 400, { error: error instanceof RangeError ? 'body_too_large' : 'invalid_json' });
  }
  const mode = request.headers.get('X-HAE-Mode') ?? 'live';
  const native = (request.headers.get('automation-aggregation') ?? '').toLowerCase();
  const custom = (request.headers.get('X-HAE-Aggregation') ?? '').toLowerCase();
  const normalize = value => ({ raw: 'raw', minute: 'minutes', day: 'days', days: 'days', hour: 'hours', hours: 'hours', minutes: 'minutes', seconds: 'seconds' })[value];
  const aggregation = normalize(custom || native) ?? 'unknown';
  const reject = async data => {
    // Keep only error codes and normalized grain; never persist the rejected payload or headers.
    try {
      await store.fetch(new Request('https://store/ingest-error', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stream, aggregation, nativeAggregation: normalize(native) ?? 'unknown',
          error: /^[a-z][a-z0-9_]{0,79}$/.test(data.error) ? data.error : 'invalid_health_payload' }),
      }));
    } catch { /* Diagnostics are best effort; preserve the original rejection. */ }
    return reply(422, data);
  };
  if (!['live', 'backfill'].includes(mode)) return reject({ error: 'invalid_ingest_mode' });
  const detailed = ['hrv', 'heart', 'sleep-segments'].includes(stream);
  let summary, records;
  try {
    records = detailed ? parseSeries(payload, stream, aggregation) : [];
    summary = stream === 'sleep-segments' ? { samples: records.length, skipped: 0, metrics: [], workouts: [], workoutReceived: null } : summarizeHealth(payload);
  } catch (error) {
    return reject({ error: detailed ? error.message : 'invalid_or_unsupported_health_metrics',
      ...(detailed && error.details ? { details: error.details } : {}) });
  }
  if (detailed) {
    const expected = stream === 'heart' || (stream === 'hrv' && aggregation === 'minutes') ? 'minutes' : 'raw';
    // HAE may send the inactive grouping selection when summarization is off.
    // Raw streams require an explicit assertion plus per-record shape validation.
    if (aggregation !== expected || (expected === 'raw' && custom !== 'raw') ||
        (expected === 'minutes' && normalize(native) && normalize(native) !== expected)) {
      return reject({ error: 'stream_aggregation_mismatch', expected });
    }
  }
  if (['health', 'sleep'].includes(stream)) {
    if (aggregation !== 'days' || (normalize(native) && normalize(native) !== aggregation)) {
      return reject({ error: 'daily_aggregation_required', hint: 'Set HAE Summarize Data ON, Time Grouping Days, and X-HAE-Aggregation: days' });
    }
    if (/since/i.test(request.headers.get('automation-period') ?? '')) {
      return reject({ error: 'full_day_range_required', hint: 'Use HAE Default or Today, not Since Last Sync' });
    }
    if (!Array.isArray(payload.data.metrics) || payload.data.workouts?.length || summary.metrics.some(m =>
      stream === 'sleep' ? m.name !== 'sleep_analysis' : m.name === 'sleep_analysis')) {
      return reject({ error: 'wrong_data_type_for_stream' });
    }
  }
  if (stream === 'workouts' && (!Array.isArray(payload.data.workouts) || summary.metrics.length)) {
    return reject({ error: 'wrong_data_type_for_stream' });
  }
  if (!detailed) {
    try { records = parseArchive(payload, summary, stream, aggregation); }
    catch (error) { return reject({ error: error.message }); }
  }
  try {
    return await store.fetch(new Request('https://store/ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary, stream, aggregation, records, mode }),
    }));
  } catch {
    return reply(503, { error: 'storage_unavailable', retryable: true });
  }
}

export default { fetch: (request, env) => handleRequest(request, env) };
