// Offline fixture server: all service data is synthetic, and every Worker HTTP
// request is handled by outboundService below. No production credentials are read.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const modulePath = process.argv[2] ?? fileURLToPath(new URL('./node_modules/miniflare/dist/src/index.js', import.meta.url));
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(modulePath).href);
const modules = ['worker', 'health-card', 'overview-card', 'health-state', 'health-store', 'delivery', 'series', 'sql-usage',
  'workouts', 'analysis', 'signature', 'physiology', 'health-indices', 'health-profile', 'health-signature', 'dashboard',
  'pressure-history', 'dashboard-auth', 'dashboard-cache', 'signature-phrases', 'signature-holidays', 'miaobi', 'badge', 'badge-cache-publisher'];
const directory = await mkdtemp(join(tmpdir(), 'health-badge-local-'));
const options = { host: '127.0.0.1', port: 8788, cf: false, resourcePersistencePath: directory, workers: [{
  name: 'synthetic-health-badge', modulesRoot: fileURLToPath(new URL('.', import.meta.url)),
  modules: modules.map(name => ({ type: 'ESModule', path: fileURLToPath(new URL(`./${name}.mjs`, import.meta.url)) })),
  compatibilityDate: '2026-09-01', durableObjects: { HEALTH_STORE: { className: 'HealthStore', useSQLite: true } },
  bindings: { HAE_API_KEY: 'synthetic-owner-key', BADGE_API_KEY: 'synthetic-device-key',
    FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-local-only',
    FEISHU_SIGN_SECRET: 'synthetic-signature-secret', FEISHU_APP_ID: 'synthetic-app', FEISHU_APP_SECRET: 'synthetic-app-secret',
    SIGNATURE_ENABLED: 'false', SIGNATURE_MODE: 'health-indices-v1', SIGNATURE_MIN_HISTORY_SAMPLES: '1',
    BADGE_CACHE_BASE_TOKEN: 'synthetic-private-base', BADGE_CACHE_TABLE_ID: 'synthetic-private-table', BADGE_CACHE_RECORD_ID: 'synthetic-private-record' },
  outboundService: async request => {
    const url = new URL(request.url);
    if (url.hostname === 'open.feishu.cn' && url.pathname.endsWith('/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 'synthetic-tenant-token', expire: 7200 });
    }
    if (url.hostname === 'open.feishu.cn' && url.pathname.endsWith('/tables/synthetic-private-table/records/synthetic-private-record') && request.method === 'PUT') {
      const { fields } = await request.json();
      return Response.json({ code: 0, data: { record: { record_id: 'synthetic-private-record', fields } } });
    }
    if (url.hostname === 'open.feishu.cn' && url.pathname.endsWith('/bot/v2/hook/synthetic-local-only')) return Response.json({ code: 0 });
    return Response.json({ error: 'local_outbound_blocked' }, { status: 503 });
  },
}] };
const runtime = new Miniflare(convertV4MiniflareOptions(options));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await runtime.dispose();
  await rm(directory, { recursive: true, force: true });
}
try {
  const now = Date.now(), dayMs = 86400000, hour = 3600000;
  const date = time => new Date(time + 8 * hour).toISOString().slice(0, 10);
  const iso = time => new Date(time).toISOString();
  const metric = (name, units, data) => ({ name, units, data });
  const post = async (path, data, aggregation) => {
    const response = await runtime.dispatchFetch(`http://local${path}`, { method: 'POST', headers: {
      'X-API-Key': 'synthetic-owner-key', 'X-HAE-Aggregation': aggregation, 'X-HAE-Mode': 'backfill',
    }, body: JSON.stringify({ data }) });
    assert.equal(response.status, 200, await response.text());
  };
  const anchor = Math.floor((now - 3 * hour) / 60000) * 60000;
  await post('/ingest/hrv', { metrics: [metric('heart_rate_variability', 'ms',
    Array.from({ length: 30 }, (_, i) => [0, 40].map(minute => ({ date: iso(anchor - (i + 1) * dayMs - minute * 60000), qty: 50 + i % 3, source: 'Synthetic Watch' }))).flat()
      .concat({ date: iso(anchor), qty: 48, source: 'Synthetic Watch' }))] }, 'raw');
  await post('/ingest/heart', { metrics: [metric('heart_rate', 'bpm', [...Array.from({ length: 7 }, (_, i) => anchor - (i + 1) * dayMs), anchor, now - 60000].map(time => ({
    date: iso(time), Avg: 66, Min: 61, Max: 72, source: 'Synthetic Watch' }))) ] }, 'minutes');
  await post('/ingest/health', { metrics: [
    metric('step_count', 'count', [{ date: date(now), qty: 6543 }]),
    metric('active_energy', 'kcal', [{ date: date(now), qty: 340 }]),
    metric('apple_exercise_time', 'min', [{ date: date(now), qty: 35 }]),
    metric('walk_run_distance', 'km', [{ date: date(now), qty: 4.6 }]),
    metric('resting_heart_rate', 'count/min', Array.from({ length: 30 }, (_, i) => ({ date: date(now - i * dayMs), qty: 57 + i % 3, source: 'Synthetic Watch' }))),
  ] }, 'days');
  const todayMidnight = Date.parse(`${date(now)}T00:00:00+08:00`);
  const sleepEnd = Math.min(now - 60000, todayMidnight + 7 * hour);
  const sleep = Array.from({ length: 7 }, (_, i) => {
    const end = sleepEnd - i * dayMs;
    return [
      { startDate: iso(end - 7 * hour), endDate: iso(end - 5.5 * hour), value: 'Deep' },
      { startDate: iso(end - 5.5 * hour), endDate: iso(end - 1.5 * hour), value: 'Core' },
      { startDate: iso(end - 1.5 * hour), endDate: iso(end), value: 'REM' },
    ].map((row, stage) => ({ ...row, id: `synthetic-sleep-${i}-${stage}`, source: 'Synthetic Watch' }));
  }).flat();
  await post('/ingest/sleep-segments', { metrics: [metric('sleep_analysis', 'hr', sleep)] }, 'raw');
  await post('/ingest/sleep', { metrics: [metric('sleep_analysis', 'hr', [{ date: date(sleepEnd), totalSleep: 7 }])] }, 'days');
  await post('/ingest/workouts', { workouts: [{ id: 'synthetic-running', name: 'Running',
    start: iso(now - hour), end: iso(now - 0.5 * hour), duration: 1800, activeEnergyBurned: { qty: 180, units: 'kcal' } }] }, 'raw');
  const refresh = await runtime.dispatchFetch('http://local/dashboard-cache/refresh', {
    method: 'POST', headers: { 'X-API-Key': 'synthetic-owner-key' } });
  assert.equal(refresh.status, 200, await refresh.text());
  await runtime.ready;
  console.log('Synthetic badge service ready: http://127.0.0.1:8788/healthz');
  console.log("curl -H 'X-API-Key: synthetic-device-key' http://127.0.0.1:8788/badge");
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
} catch (error) { await stop(); throw error; }
