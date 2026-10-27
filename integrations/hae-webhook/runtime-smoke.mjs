// Run with the path to the Miniflare module bundled with pinned Wrangler.
// Uses synthetic data and intercepts ALL outbound HTTP; never contacts Feishu.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(process.argv[2]).href);
const signatureMode = process.argv[3] ?? 'sync-status-v1';
const storagePath = await mkdtemp(join(tmpdir(), 'hae-runtime-'));
let sends = 0, sentCard, signatureWrites = 0, cacheWrites = 0, cacheFields = null;
const options = { cf: false, resourcePersistencePath: storagePath, workers: [{
  name: 'hae-runtime-test',
  modules: ['worker', 'health-card', 'overview-card', 'health-state', 'health-store', 'delivery', 'series', 'sql-usage', 'workouts', 'analysis', 'signature', 'physiology', 'health-indices', 'health-profile', 'health-signature', 'dashboard', 'pressure-history', 'dashboard-auth', 'dashboard-cache', 'signature-phrases', 'signature-holidays', 'miaobi'].map(name => ({ type: 'ESModule', path: fileURLToPath(new URL(`./${name}.mjs`, import.meta.url)) })),
  compatibilityDate: '2026-09-01',
  durableObjects: { HEALTH_STORE: { className: 'HealthStore', useSQLite: true } },
  bindings: { HAE_API_KEY: 'fixture', FEISHU_SIGN_SECRET: 'fixture', FEISHU_WEBHOOK_URL: 'https://open.larkoffice.com/open-apis/bot/v2/hook/fixture',
    SIGNATURE_ENABLED: 'true', SIGNATURE_MODE: signatureMode, FEISHU_APP_ID: 'fixture', FEISHU_APP_SECRET: 'fixture',
    SIGNATURE_BASE_TOKEN: 'base', SIGNATURE_TABLE_ID: 'table', SIGNATURE_RECORD_ID: 'record',
    DASHBOARD_CACHE_TABLE_ID: 'cachtable', DASHBOARD_CACHE_RECORD_ID: 'cachrec' },
  outboundService: async request => {
    const path = new URL(request.url).pathname;
    if (path === '/open-apis/auth/v3/tenant_access_token/internal') return Response.json({ code: 0, tenant_access_token: 'fixture', expire: 7200 });
    if (path === '/open-apis/bitable/v1/apps/base/tables/cachtable/records/cachrec') {
      if (request.method === 'GET') return Response.json({ code: 0, data: { record: { record_id: 'cachrec', fields: cacheFields } } });
      assert.equal(request.method, 'PUT');
      const body = await request.json();
      assert.deepEqual(Object.keys(body.fields), ['payload_24h', 'payload_7d', 'generated_at']);
      for (const key of ['payload_24h', 'payload_7d']) {
        const dto = JSON.parse(body.fields[key]);
        assert.equal(dto.schemaVersion, 'dashboard-v1');
        assert.ok(dto.heart.points.length > 0);
      }
      cacheWrites++; cacheFields = body.fields;
      return Response.json({ code: 0, data: { record: { record_id: 'cachrec', fields: body.fields } } });
    }
    if (path === '/open-apis/bitable/v1/apps/base/tables/table/records/record') {
      assert.equal(request.method, 'PUT');
      const body = await request.json();
      assert.deepEqual(Object.keys(body.fields), ['title']);
      assert.match(body.fields.title, signatureMode === 'health-indices-v1' ? /(?:状态优秀|状态正常|注意压力|压力过载|压力暂无|压力积累中).*HRV.*心率/ : signatureMode === 'physiology-v2' ? /🔵 状态正常/ : /健康数据已同步/);
      signatureWrites++;
      return Response.json({ code: 0, data: { record: { record_id: 'record' } } });
    }
    assert.equal(new URL(request.url).pathname, '/open-apis/bot/v2/hook/fixture');
    sentCard = (await request.json()).card; sends++;
    return Response.json({ code: 0 });
  },
}] };
let mf = new Miniflare(convertV4MiniflareOptions(options));
const headers = { 'X-API-Key': 'fixture', 'X-HAE-Aggregation': 'days' };
const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const upload = async (path, data, extraHeaders = {}) => {
  const response = await mf.dispatchFetch(`http://local${path}`, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify({ data }) });
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
};
const health = { metrics: [{ name: 'step_count', units: 'count', data: [{ date, qty: 1234.56 }] }] };
try {
  assert.equal((await mf.dispatchFetch('http://local/status')).status, 401);
  const history = { metrics: [{ name: 'heart_rate_variability', units: 'ms', data: Array.from({ length: 30 }, (_, i) => [10, 50].map(min => ({
    date: new Date(Date.now() - (i + 1) * 86400000 - min * 60000).toISOString(), qty: 50 + i % 3, source: 'Watch',
  }))).flat() }] };
  assert.equal((await upload('/ingest/hrv', history, { 'X-HAE-Aggregation': 'raw', 'X-HAE-Mode': 'backfill' })).notification, 'backfill_silent');
  const before = await (await mf.dispatchFetch('http://local/status', { headers })).json();
  assert.equal(before.delivery.pending, false); assert.equal(before.series.hrv, 60);
  const rejected = await mf.dispatchFetch('http://local/ingest/health', { method: 'POST', headers,
    body: JSON.stringify({ data: { metrics: [{ name: 'step_count', units: 'count', data: [{ date, qty: -1 }] }] } }) });
  assert.equal(rejected.status, 422);
  assert.equal((await rejected.json()).details.reason, 'negative_steps');
  const rejectedStatus = await (await mf.dispatchFetch('http://local/status', { headers })).json();
  assert.equal(rejectedStatus.lastIngestError.reason, 'negative_steps');
  assert.equal(rejectedStatus.series.daily ?? 0, 0, 'rejected transaction must not persist daily rows');
  assert.equal(rejectedStatus.series.hrv, 60, 'rejection must preserve accepted history');
  assert.equal(rejectedStatus.delivery.pending, false);
  await upload('/ingest/health', { metrics: [{ name: 'resting_heart_rate', units: 'count/min', data: Array.from({ length: 31 }, (_, i) => ({ date: new Date(Date.now() + 8 * 3600000 - i * 86400000).toISOString().slice(0, 10), qty: 55 + (i % 3 - 1), source: 'Watch' })) }] }, { 'X-HAE-Mode': 'backfill' });
  assert.equal((await upload('/ingest/health', health)).stored, true);
  assert.equal((await (await mf.dispatchFetch('http://local/status', { headers })).json()).lastIngestError, null);
  await upload('/ingest/hrv', { metrics: [{ name: 'heart_rate_variability', units: 'ms', data: [
    { date: new Date(Date.now() - 600000).toISOString(), qty: 51, source: 'Watch' },
    { date: new Date(Date.now() - 3000000).toISOString(), qty: 51, source: 'Watch' },
  ] }] }, { 'X-HAE-Aggregation': 'raw' });
  const minutes = { metrics: [{ name: 'heart_rate', units: 'bpm', data: Array.from({ length: 1440 }, (_, i) => ({
    date: new Date(Math.floor(Date.now() / 60000) * 60000 - (i + 1) * 60000).toISOString(), Avg: 65, Min: 60, Max: 70, source: 'Watch',
  })) }] };
  const began = Date.now();
  assert.equal((await upload('/ingest/heart', minutes, { 'X-HAE-Aggregation': 'minutes' })).stats.inserted, 1440);
  assert.equal((await upload('/ingest/heart', minutes, { 'X-HAE-Aggregation': 'minutes' })).stats.unchanged, 1440);
  console.log(`Runtime: 1440 minute windows + duplicate request persisted in ${Date.now() - began} ms; ${JSON.stringify({ data: minutes }).length} bytes/request.`);
  await upload('/ingest/sleep-segments', { metrics: [{ name: 'sleep_analysis', units: 'hr', data: [
    { id: 'sleep', startDate: new Date(Date.now() - 9 * 3600000).toISOString(), endDate: new Date(Date.now() - 2 * 3600000).toISOString(), value: 'Core', source: 'Watch' },
  ] }] }, { 'X-HAE-Aggregation': 'raw' });
  await upload('/ingest/sleep', { metrics: [{ name: 'sleep_analysis', units: 'hr', data: [{ date, totalSleep: 7 }] }] });
  await upload('/ingest/workouts', { workouts: [{ id: 'smoke', name: 'Running', start: new Date(Date.now() - 4 * 3600000).toISOString(), end: new Date(Date.now() - 3.5 * 3600000).toISOString(), duration: 1800 }] });
  assert.equal(sends, 0);
  console.log('Runtime: all five streams persisted; waiting for the real alarm.');
  const deadline = Date.now() + 75000;
  while ((!sends || !cacheWrites) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(signatureWrites, 1, 'real alarm must update Miaobi exactly once');
  assert.equal(sends, 1, 'alarm must deliver exactly one merged card in normal operation');
  assert.equal(cacheWrites, 1, 'alarm must publish the dashboard cache exactly once');
  const cached7d = JSON.parse(cacheFields.payload_7d);
  assert.equal(cached7d.heart.bucketMinutes, 10, '7d cache must bucket at build time');
  assert.equal(cached7d.heart.truncated, false);
  assert.ok(cached7d.heart.points.length <= 145, '1440 minutes bucket into ~144 ten-minute buckets');
  if (signatureMode === 'health-indices-v1') {
    assert.equal(sentCard.header.title.content, '健康速览');
    assert.match(JSON.stringify(sentCard), /跑步/);
    assert.match(JSON.stringify(sentCard), /"tag":"chart"/);
    assert.match(JSON.stringify(sentCard), /恢复 HRV/);
  } else {
    assert.match(JSON.stringify(sentCard), /1235/);
    assert.match(JSON.stringify(sentCard), /Running/);
  }
  assert.match(JSON.stringify(sentCard), /7 小时/);
  await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options));
  assert.equal((await upload('/ingest/health', health)).notification, 'unchanged');
  const status = await (await mf.dispatchFetch('http://local/status', { headers })).json();
  assert.equal(status.metrics, 5);
  assert.equal(status.signature.pending, false);
  assert.equal(status.signature.mode, signatureMode);
  assert.equal(status.signature.sentTitle, status.signature.desiredTitle);
  if (signatureMode === 'health-indices-v1') {
    assert.deepEqual(status.signature.policy, { coalesceMs: 30000, minWriteIntervalMs: 120000 });
    assert.equal(status.signature.publicationTiming.ok, true);
    assert.ok(status.signature.publicationTiming.writeMs >= 0);
    assert.ok(status.signature.publicationTiming.candidateBuiltAt <= status.signature.publicationTiming.startedAt);
  }
  assert.equal(status.series.hrv, 62); assert.equal(status.series.heart, 1440); assert.equal(status.series.sleep, 1); assert.equal(status.workouts, 1); assert.equal(status.delivery.pending, false);
  assert.ok(status.seriesReadStats.rowsRead > 0, 'workerd must expose real SQL rowsRead after a cold start');
  assert.ok(status.sqlReadUsage.days.some(row => row.category === 'raw_history' && row.rowsRead > 0));
  const analysis = await (await mf.dispatchFetch('http://local/analysis', { headers })).json();
  assert.equal(analysis.version, 'descriptive-v1');
  assert.equal(analysis.daytime.baseline.days, 30);
  assert.equal(analysis.daytime.status, 'comparable');
  const reused = await (await mf.dispatchFetch('http://local/status', { headers })).json();
  assert.equal(reused.seriesReadStats.rowsRead, status.seriesReadStats.rowsRead,
    'unchanged narrower history reads must reuse cached facts in real workerd');
  assert.ok(reused.seriesReadStats.cacheHits > status.seriesReadStats.cacheHits);
  const snapshot = await (await mf.dispatchFetch('http://local/snapshot', { headers })).json();
  assert.equal(snapshot.schemaVersion, 'signature-v1');
  assert.match(snapshot.evidenceVersion, /^[0-9a-f]{16}$/);
  assert.ok(['pending', 'post_workout', 'baseline_building', 'steady', 'drift'].includes(snapshot.state));
  assert.equal(typeof snapshot.title, 'string');
  assert.equal(snapshot.physiology.state, 'balanced');
  assert.ok(snapshot.validUntil > Date.now());
  const dashNoAuth = await mf.dispatchFetch('http://local/dashboard?range=24h');
  assert.equal(dashNoAuth.status, 401);
  const dashBadRange = await mf.dispatchFetch('http://local/dashboard?range=30d', { headers });
  assert.equal(dashBadRange.status, 400);
  const dashboard = await (await mf.dispatchFetch('http://local/dashboard?range=7d', { headers })).json();
  assert.equal(dashboard.schemaVersion, 'dashboard-v1');
  assert.equal(dashboard.range, '7d');
  assert.ok(dashboard.heart.points.length > 0);
  assert.equal(dashboard.heart.truncated, false);
  assert.ok(dashboard.sleep.length >= 1);
  assert.doesNotMatch(JSON.stringify(dashboard), /payload|originalTime/);
  const manualRefresh = await mf.dispatchFetch('http://local/dashboard-cache/refresh', { method: 'POST', headers });
  const refreshBody = await manualRefresh.json();
  assert.equal(manualRefresh.status, 200, JSON.stringify(refreshBody));
  assert.equal(cacheWrites, 2, 'manual refresh must force one more cache publish');
  assert.equal(refreshBody.dashboardCache.error, null, JSON.stringify(refreshBody.dashboardCache));
  const idleDueIn = refreshBody.dashboardCache.dueAt - Date.now();
  assert.ok(idleDueIn > 10 * 60000,
    `successful publish must wait for the next evidence/calendar boundary, got ${idleDueIn}ms`);
  console.log('Runtime PASS: authenticated routes, real SQLite storage, alarm, five-stream card and silent 30-day backfill, restart and duplicate suppression.');
} finally { await mf.dispose(); await rm(storagePath, { recursive: true, force: true }); }
