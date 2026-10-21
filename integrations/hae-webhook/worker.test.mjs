import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './worker.mjs';

const env = {
  HAE_API_KEY: 'fixture-ingest-key',
  FEISHU_WEBHOOK_URL: 'https://open.larkoffice.com/open-apis/bot/v2/hook/fixture',
  FEISHU_SIGN_SECRET: 'fixture-sign-secret',
  HEALTH_STORE: { idFromName: () => 'personal', get: () => ({ fetch: async () => Response.json({ ok: true, sent: false, stored: true }) }) },
};
const payload = { data: { metrics: [
  { name: 'resting_heart_rate', units: 'count/min', data: [
    { date: '2026-09-23 09:00:00 +0800', qty: 60 },
    { date: '2026-09-22 09:00:00 +0800', qty: 70 },
  ] },
  { name: 'heart_rate_variability', units: 'ms', data: [{ date: '2026-09-23T01:00:00Z', qty: 45.5 }] },
  { name: 'heart_rate', units: 'bpm', data: [{ date: '2026-09-23T01:00:00Z', Avg: 72, Min: 60, Max: 90 }] },
] } };
const request = (body = payload, key = env.HAE_API_KEY) => new Request('https://demo.test/ingest', {
  method: 'POST', headers: { 'X-API-Key': key }, body: JSON.stringify(body),
});
const neverSend = () => { throw new Error('Should not send'); };

test('missing or incorrect authentication cannot send group messages', async () => {
  for (const key of ['', 'incorrect', `${env.HAE_API_KEY}-extra`, 'fixture-ingest-ke']) {
    assert.equal((await handleRequest(request(payload, key), env, neverSend)).status, 401);
  }
  assert.equal((await handleRequest(request(payload, null), env, neverSend)).status, 401);
});

test('missing server secrets fails closed', async () => {
  assert.equal((await handleRequest(request(), {}, neverSend)).status, 503);
});


test('empty health batch succeeds without sending a notification', async () => {
  const response = await handleRequest(request({ data: { metrics: [] } }), env, neverSend);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sent, false);
});

test('invalid schema and unusable samples are rejected, not treated as delivered', async () => {
  for (const body of [{}, { data: { metrics: 'invalid' } }, { data: { metrics: [null] } },
    { data: { metrics: [{ name: 'resting_heart_rate', units: 'bpm', data: [{ qty: 60, date: 'bad-date' }] }] } }]) {
    assert.equal((await handleRequest(request(body), env, neverSend)).status, 422);
  }
});

test('bad JSON and bodies above one MiB cannot send', async () => {
  for (const [body, status] of [['{', 400], ['x'.repeat(1024 * 1024 + 1), 413]]) {
    const req = new Request('https://demo.test/ingest', {
      method: 'POST', headers: { 'X-API-Key': env.HAE_API_KEY }, body,
    });
    assert.equal((await handleRequest(req, env, neverSend)).status, status);
  }
});



test('health endpoint does not expose data or secrets; other routes do not send', async () => {
  const response = await handleRequest(new Request('https://demo.test/healthz'), env, neverSend);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal((await handleRequest(new Request('https://demo.test/unknown'), env, neverSend)).status, 404);
});

test('new stream and read routes require auth and route to durable storage', async () => {
  let calls = 0;
  const durableEnv = { ...env, HEALTH_STORE: { idFromName: () => 'personal', get: () => ({ fetch: async () => {
    calls++; return Response.json({ ok: true, stored: true });
  } }) } };
  for (const path of ['/status', '/card', '/ingest/health', '/ingest/sleep', '/ingest/workouts']) {
    const response = await handleRequest(new Request(`https://demo.test${path}`, {
      method: path.startsWith('/ingest') ? 'POST' : 'GET',
    }), durableEnv, neverSend);
    assert.equal(response.status, 401);
  }
  const response = await handleRequest(new Request('https://demo.test/ingest/health', {
    method: 'POST', headers: { 'X-API-Key': env.HAE_API_KEY, 'X-HAE-Aggregation': 'days' }, body: JSON.stringify(payload),
  }), durableEnv, neverSend);
  assert.equal((await response.json()).stored, true);
  assert.equal(calls, 1);
});

test('daily routes reject hourly grouping, partial ranges and mixed data types', async () => {
  const cases = [
    ['/ingest/health', payload, {}, 'daily_aggregation_required'],
    ['/ingest/health', payload, { 'X-HAE-Aggregation': 'days', 'automation-aggregation': 'hours' }, 'daily_aggregation_required'],
    ['/ingest/health', payload, { 'X-HAE-Aggregation': 'days', 'automation-period': 'sinceLastSync' }, 'full_day_range_required'],
    ['/ingest/sleep', payload, { 'X-HAE-Aggregation': 'days' }, 'wrong_data_type_for_stream'],
    ['/ingest/workouts', payload, {}, 'wrong_data_type_for_stream'],
  ];
  for (const [path, data, headers, error] of cases) {
    const response = await handleRequest(new Request(`https://demo.test${path}`, {
      method: 'POST', headers: { 'X-API-Key': env.HAE_API_KEY, ...headers }, body: JSON.stringify(data),
    }), env);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, error);
  }
});

test('failed durable write returns retryable 503', async () => {
  const response = await handleRequest(request(), { ...env, HEALTH_STORE: { idFromName: () => 'personal', get: () => ({ fetch: async () => { throw new Error('private storage detail'); } }) } });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'storage_unavailable', retryable: true });
});

test('request validation persists only safe metadata without changing the 422 response', async () => {
  const calls = [];
  const target = { ...env, HEALTH_STORE: { idFromName: () => 'personal', get: () => ({ fetch: async r => {
    calls.push({ path: new URL(r.url).pathname, body: await r.json() });
    return Response.json({ ok: true });
  } }) } };
  const body = { data: { metrics: [{ name: 'heart_rate', units: 'bpm',
    data: [{ date: '2026-09-24T01:00:09Z', Avg: 72, Min: 90, source: 'private-device' }] }] } };
  const response = await handleRequest(new Request('https://demo.test/ingest/heart', {
    method: 'POST', headers: { 'X-API-Key': env.HAE_API_KEY, 'X-HAE-Aggregation': 'minutes',
      'automation-aggregation': 'minutes' }, body: JSON.stringify(body),
  }), target);
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: 'invalid_heart_window' });
  assert.deepEqual(calls, [{ path: '/ingest-error', body: { stream: 'heart',
    aggregation: 'minutes', nativeAggregation: 'minutes', error: 'invalid_heart_window' } }]);
  assert.doesNotMatch(JSON.stringify(calls), /private-device|fixture-ingest-key|2026|72/);
  assert.equal((await handleRequest(new Request('https://demo.test/ingest-error', {
    method: 'POST', headers: { 'X-API-Key': env.HAE_API_KEY }, body: '{}',
  }), target)).status, 404, 'the diagnostic route is internal only');
});

test('failed diagnostic persistence preserves the original validation error', async () => {
  const target = { ...env, HEALTH_STORE: { idFromName: () => 'personal', get: () => ({ fetch: async () => {
    throw new Error('storage unavailable');
  } }) } };
  const response = await handleRequest(request({}), target);
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: 'invalid_or_unsupported_health_metrics' });
});

test('second-offset heart windows still require minute grouping and valid extrema', async () => {
  const post = (headers, point = {}) => handleRequest(new Request('https://demo.test/ingest/heart', {
    method: 'POST', headers: { 'X-API-Key': env.HAE_API_KEY, 'X-HAE-Aggregation': 'minutes', ...headers },
    body: JSON.stringify({ data: { metrics: [{ name: 'heart_rate', units: 'bpm',
      data: [{ date: '2026-09-24T01:00:09Z', Avg: 65, Min: 60, Max: 70, ...point }] }] } }),
  }), env);
  assert.equal((await post({ 'automation-aggregation': 'minutes' })).status, 200);
  for (const headers of [{ 'X-HAE-Aggregation': 'raw' }, { 'automation-aggregation': 'seconds' },
    { 'X-HAE-Aggregation': 'hours' }]) {
    const response = await post(headers);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, 'stream_aggregation_mismatch');
  }
  const invalid = await post({}, { Max: 55 });
  assert.equal(invalid.status, 422);
  assert.equal((await invalid.json()).error, 'invalid_heart_window');
});

test('heart uploads containing floating point noise forward the complete batch', async () => {
  const calls = [], target = { ...env, HEALTH_STORE: { idFromName: () => 'personal', get: () => ({
    fetch: async req => { calls.push({ path: new URL(req.url).pathname, body: await req.json() }); return Response.json({ ok: true }); },
  }) } };
  const points = [
    { date: '2026-09-24T03:00:00Z', Avg: 72, Min: 60, Max: 90 },
    { date: '2026-09-24T03:01:00Z', Avg: 70.00000000000001, Min: 70, Max: 70 },
  ];
  const response = await handleRequest(new Request('https://demo.test/ingest/heart', {
    method: 'POST', headers: { 'X-API-Key': env.HAE_API_KEY, 'X-HAE-Aggregation': 'minutes', 'automation-aggregation': 'minutes' },
    body: JSON.stringify({ data: { metrics: [{ name: 'heart_rate', units: 'count/min', data: points }] } }),
  }), target);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/ingest');
  assert.deepEqual(calls[0].body.records.map(row => row.value), points.map(row => row.Avg));
});

test('detail routes validate grain and forward records/backfill; analysis is authenticated', async () => {
  let received;
  const target = { ...env, HEALTH_STORE: { idFromName: () => 'personal', get: () => ({ fetch: async r => {
    received = r.method === 'POST' ? await r.json() : new URL(r.url).pathname;
    return Response.json({ ok: true });
  } }) } };
  const data = { data: { metrics: [{ name: 'heart_rate_variability', units: 'ms', data: [{ date: '2026-09-24T01:00:00Z', qty: 50, source: 'Watch' }] }] } };
  const post = headers => handleRequest(new Request('https://demo.test/ingest/hrv', { method: 'POST', headers: { 'X-API-Key': env.HAE_API_KEY, ...headers }, body: JSON.stringify(data) }), target);
  assert.equal((await post({ 'X-HAE-Aggregation': 'days' })).status, 422);
  assert.equal((await post({ 'X-HAE-Aggregation': 'raw', 'X-HAE-Mode': 'backfill' })).status, 200);
  assert.equal(received.records.length, 1); assert.equal(received.mode, 'backfill');
  assert.equal((await post({ 'X-HAE-Aggregation': 'raw', 'X-HAE-Mode': 'bogus' })).status, 422);
  assert.equal((await handleRequest(new Request('https://demo.test/analysis'), target)).status, 401);
  assert.equal((await handleRequest(new Request('https://demo.test/analysis', { headers: { 'X-API-Key': env.HAE_API_KEY } }), target)).status, 200);
  assert.equal(received, '/analysis');
});

test('analysis token can read facts but cannot upload health data', async () => {
  const target = { ...env, ANALYSIS_API_KEY: 'readonly-fixture' };
  assert.equal((await handleRequest(new Request('https://demo.test/analysis', { headers: { 'X-API-Key': target.ANALYSIS_API_KEY } }), target)).status, 200);
  assert.equal((await handleRequest(request(payload, target.ANALYSIS_API_KEY), target)).status, 401);
});

test('HRV route accepts both HRV methods with explicit minute aggregation', async () => {
  let received;
  const target = { ...env, HEALTH_STORE: { idFromName: () => 'personal', get: () => ({ fetch: async r => {
    received = await r.json(); return Response.json({ ok: true });
  } }) } };
  const body = { data: { metrics: [
    { name: 'heart_rate_variability', units: 'ms', data: [{ date: '2026-09-24T01:00:00Z', qty: 50 }] },
    { name: 'heart_rate_variability_rmssd', units: 'ms', data: [{ date: '2026-09-24T01:00:00Z', qty: 35 }] },
  ] } };
  const post = headers => handleRequest(new Request('https://demo.test/ingest/hrv', {
    method: 'POST', headers: { 'X-API-Key': env.HAE_API_KEY, 'X-HAE-Aggregation': 'minutes',
      'automation-aggregation': 'minutes', ...headers }, body: JSON.stringify(body),
  }), target);
  assert.equal((await post({})).status, 200);
  assert.equal(received.aggregation, 'minutes');
  assert.deepEqual(received.records.map(r => r.method), ['SDNN', 'RMSSD']);
  assert.equal(received.summary.samples, 2);
  const mismatch = await post({ 'automation-aggregation': 'hours' });
  assert.equal(mismatch.status, 422);
  assert.equal((await mismatch.json()).error, 'stream_aggregation_mismatch');
});

test('sleep validation explains incompatible shape without returning measurements or source', async () => {
  const segment = { startDate: '2026-09-24T01:00:00Z', endDate: '2026-09-24T02:00:00Z', value: 'Core', source: 'private-device', qty: 1 };
  for (const [units, changes, reason] of [
    ['seconds', {}, 'unit'],
    ['hr', { endDate: undefined }, 'end_time'],
    ['hr', { endDate: segment.startDate }, 'duration'],
    ['hr', { value: 'Other' }, 'stage'],
  ]) {
    const response = await handleRequest(new Request('https://demo.test/ingest/sleep-segments', {
      method: 'POST', headers: { 'X-API-Key': env.HAE_API_KEY, 'X-HAE-Aggregation': 'raw' },
      body: JSON.stringify({ data: { metrics: [{ name: 'sleep_analysis', units, data: [{ ...segment, ...changes }] }] } }),
    }), env);
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.error, 'sleep_segments_required');
    assert.equal(body.details?.reason, reason);
    assert.ok(!JSON.stringify(body).includes('2026-09'));
    assert.ok(!JSON.stringify(body).includes('private-device'));
    assert.ok(!JSON.stringify(body).includes('qty'));
  }
});

test('dashboard route requires auth and forwards its range query', async () => {  let received;
  const target = { ...env, HEALTH_STORE: { idFromName: () => 'personal', get: () => ({ fetch: async r => {
    received = r.url; return Response.json({ schemaVersion: 'dashboard-v1' });
  } }) } };
  assert.equal((await handleRequest(new Request('https://demo.test/dashboard?range=7d'), target)).status, 401);
  const response = await handleRequest(new Request('https://demo.test/dashboard?range=7d', {
    headers: { 'X-API-Key': env.HAE_API_KEY },
  }), target);
  assert.equal(response.status, 200);
  assert.equal(received, 'https://store/dashboard?range=7d');
});

test('signature refresh is an authenticated mutation; analysis key and GET cannot invoke it', async () => {
  const target = { ...env, ANALYSIS_API_KEY: 'readonly' };
  for (const key of ['', 'readonly']) {
    assert.equal((await handleRequest(new Request('https://demo.test/signature/refresh', {
      method: 'POST', headers: { 'X-API-Key': key },
    }), target)).status, 401);
  }
  assert.equal((await handleRequest(new Request('https://demo.test/signature/refresh'), target)).status, 405);
  assert.equal((await handleRequest(new Request('https://demo.test/signature/refresh', {
    method: 'POST', headers: { 'X-API-Key': env.HAE_API_KEY },
  }), target)).status, 200);
});

const enc = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
async function viewerToken(envAuth, payload) {
  const now = Date.now();
  payload ??= { sub: 'ou_owner', iat: now, exp: now + 300000 };
  const part = b64url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey('raw', enc.encode(envAuth.DASHBOARD_VIEWER_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `${part}.${b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(part))))}`;
}

test('dashboard accepts an HMAC viewer assertion without exposing API keys', async () => {
  let called = false;
  const authEnv = {
    ...env, DASHBOARD_VIEWER_SECRET: 'shared-secret', DASHBOARD_VIEWER_OPENIDS: 'ou_owner,ou_friend',
    HEALTH_STORE: { idFromName: () => 'personal', get: () => ({ fetch: async () => { called = true; return Response.json({ schemaVersion: 'dashboard-v1' }); } }) },
  };
  // No credentials at all -> 401.
  assert.equal((await handleRequest(new Request('https://demo.test/dashboard'), authEnv)).status, 401);
  // Signed assertion from an allowlisted viewer -> forwarded.
  const ok = await handleRequest(new Request('https://demo.test/dashboard', {
    headers: { Authorization: `Bearer ${await viewerToken(authEnv)}` },
  }), authEnv);
  assert.equal(ok.status, 200);
  assert.equal(called, true);
  // Signed assertion from a non-allowlisted open_id -> 401, never reaches storage.
  const bad = await handleRequest(new Request('https://demo.test/dashboard', {
    headers: { Authorization: `Bearer ${await viewerToken(authEnv, { sub: 'ou_stranger', iat: Date.now(), exp: Date.now() + 300000 })}` },
  }), authEnv);
  assert.equal(bad.status, 401);
  assert.match(await bad.text(), /viewer_not_allowed/);
});

test('dashboard preflight and CORS headers are origin-scoped', async () => {
  const authEnv = { ...env, DASHBOARD_VIEWER_SECRET: 's', DASHBOARD_VIEWER_OPENIDS: 'ou_owner',
    DASHBOARD_VIEWER_ORIGINS: 'https://magic.solutionsuite.cn' };
  const preflight = await handleRequest(new Request('https://demo.test/dashboard', {
    method: 'OPTIONS', headers: { Origin: 'https://magic.solutionsuite.cn' },
  }), authEnv);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://magic.solutionsuite.cn');
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /If-None-Match/i);
  assert.match(preflight.headers.get('Access-Control-Expose-Headers'), /ETag/i);
  const foreign = await handleRequest(new Request('https://demo.test/dashboard', {
    method: 'OPTIONS', headers: { Origin: 'https://evil.example' },
  }), authEnv);
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null);
});

test('CORS is fail-closed with no configured origin, never a guessed platform default', async () => {
  const authEnv = { ...env, DASHBOARD_VIEWER_SECRET: 's', DASHBOARD_VIEWER_OPENIDS: 'ou_owner' };
  // Even the former hard-coded default must not pass before it is observed and configured.
  const preflight = await handleRequest(new Request('https://demo.test/dashboard', {
    method: 'OPTIONS', headers: { Origin: 'https://magic.solutionsuite.cn' },
  }), authEnv);
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), null);
});

test('dashboard forwards If-None-Match so identical content can answer 304', async () => {
  let received;
  const authEnv = { ...env, DASHBOARD_VIEWER_SECRET: 's', DASHBOARD_VIEWER_OPENIDS: 'ou_owner',
    HEALTH_STORE: { idFromName: () => 'personal', get: () => ({ fetch: async r => { received = r; return Response.json({ schemaVersion: 'dashboard-v1' }); } }) } };
  await handleRequest(new Request('https://demo.test/dashboard?range=7d', {
    headers: { 'X-API-Key': env.HAE_API_KEY, 'If-None-Match': '"abc123"' },
  }), authEnv);
  assert.equal(received.headers.get('If-None-Match'), '"abc123"');
});

test('workout batches may exceed the one-MiB general limit; other streams may not', async () => {
  const env2 = { ...env, FEISHU_WEBHOOK_URL: 'https://open.larkoffice.com/open-apis/bot/v2/hook/fixture',
    HEALTH_STORE: { idFromName: () => 'personal', get: () => ({ fetch: async () => Response.json({ ok: true }) }) } };
  const json = workouts => ({ data: { workouts } });
  const small = { id: 'w', name: 'Running', start: new Date().toISOString(), end: new Date(Date.now() + 600000).toISOString(), duration: 600 };
  // ~1.2 MiB body, accepted for workouts and rejected for the other streams.
  const big = { ...small, routeLocations: [] };
  let oversized;
  do {
    big.routeLocations.push({ lat: 31.2, lon: 121.5, t: big.routeLocations.length });
    oversized = JSON.stringify(json([big]));
  } while (oversized.length < 1.2 * 1024 * 1024);
  assert.ok(oversized.length < 2 * 1024 * 1024);
  const req = (path, body) => new Request(`https://store${path}`, { method: 'POST',
    headers: { 'X-API-Key': 'fixture-ingest-key', 'X-HAE-Aggregation': 'days' }, body });
  const accepted = await handleRequest(req('/ingest/workouts', oversized), env2);
  assert.equal(accepted.status, 200, (await accepted.text()).slice(0, 200));
  // A metric stream carrying the same size must still be rejected at the one-MiB gate.
  const metrics = JSON.stringify({ data: { metrics: [{ name: 'step_count', units: 'count',
    data: [{ date: '2026-10-17', qty: oversized.length }], filler: 'x'.repeat(oversized.length) }] } });
  const rejected = await handleRequest(req('/ingest/health', metrics), env);
  assert.equal(rejected.status, 413);
  assert.equal((await rejected.json()).error, 'body_too_large');
});
