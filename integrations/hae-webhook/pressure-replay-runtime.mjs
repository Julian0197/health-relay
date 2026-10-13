// Run with the Miniflare module bundled with pinned Wrangler. Synthetic data only;
// every outbound request is intercepted, including signature publication.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(process.argv[2]).href);
const storagePath = await mkdtemp(join(tmpdir(), 'hae-pressure-replay-'));
const modules = ['worker', 'health-card', 'health-state', 'health-store', 'sql-usage', 'workouts', 'delivery', 'series', 'analysis',
  'signature', 'physiology', 'health-indices', 'health-profile', 'health-signature', 'dashboard',
  'pressure-history', 'dashboard-auth', 'dashboard-cache', 'signature-phrases', 'signature-holidays', 'miaobi'];
const options = { cf: false, resourcePersistencePath: storagePath, workers: [{
  name: 'hae-replay-test', modules: modules.map(name => ({ type: 'ESModule',
    path: fileURLToPath(new URL(`./${name}.mjs`, import.meta.url)) })), compatibilityDate: '2026-09-01',
  durableObjects: { HEALTH_STORE: { className: 'HealthStore', useSQLite: true } },
  bindings: { HAE_API_KEY: 'fixture', FEISHU_SIGN_SECRET: 'fixture',
    FEISHU_WEBHOOK_URL: 'https://open.larkoffice.com/open-apis/bot/v2/hook/fixture',
    SIGNATURE_ENABLED: 'true', SIGNATURE_MODE: 'health-indices-v1',
    FEISHU_APP_ID: 'fixture', FEISHU_APP_SECRET: 'fixture', SIGNATURE_BASE_TOKEN: 'base',
    SIGNATURE_TABLE_ID: 'table', SIGNATURE_RECORD_ID: 'record' },
  outboundService: async request => {
    const path = new URL(request.url).pathname;
    if (path === '/open-apis/auth/v3/tenant_access_token/internal') {
      return Response.json({ code: 0, tenant_access_token: 'fixture', expire: 7200 });
    }
    assert.equal(path, '/open-apis/bitable/v1/apps/base/tables/table/records/record');
    assert.equal(request.method, 'PUT');
    const { fields } = await request.json();
    assert.match(fields.title, /压力暂无|状态正常/);
    return Response.json({ code: 0, data: { record: { record_id: 'record', fields } } });
  },
}] };
let mf = new Miniflare(convertV4MiniflareOptions(options));
const headers = { 'X-API-Key': 'fixture' };
const request = async (path, init = {}) => {
  const response = await mf.dispatchFetch(`http://local${path}`, { ...init, headers: { ...headers, ...init.headers } });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
};
const HOUR = 3600000, DAY = 24 * HOUR, MINUTE = 60000;
const today = Math.floor((Date.now() + 8 * HOUR) / DAY) * DAY - 8 * HOUR;
const heart = [], hrv = [];
for (let day = 14; day > 0; day--) for (let minute = 0; minute < 480; minute++) {
  const t = today - day * DAY + 8 * HOUR + minute * MINUTE;
  heart.push({ date: new Date(t).toISOString(), Avg: 60, Min: 55, Max: 65, source: 'Watch' });
  if (minute % 5 === 0) hrv.push({ date: new Date(t).toISOString(), qty: 40, source: 'Watch' });
}
const upload = (stream, name, units, data) => request(`/ingest/${stream}`, { method: 'POST',
  headers: { 'X-HAE-Aggregation': 'minutes', 'X-HAE-Mode': 'backfill' },
  body: JSON.stringify({ data: { metrics: [{ name, units, data }] } }) });
try {
  await upload('heart', 'heart_rate', 'bpm', heart);
  await upload('hrv', 'heart_rate_variability_rmssd', 'ms', hrv);
  assert.equal((await request('/status')).pressureReplay, null);
  assert.equal((await request('/dashboard?range=7d')).pressureHistory.points.length, 0);
  const queued = (await request('/signature/refresh?rebuildPressure=1', { method: 'POST' })).pressureReplay;
  const expectedAnchors = hrv.filter(p => Date.parse(p.date) >= queued.since && Date.parse(p.date) <= queued.until).length;
  const began = Date.now(), deadline = began + 180000;
  let status, firstBatch;
  do {
    await new Promise(resolve => setTimeout(resolve, 1000));
    status = await request('/status');
    if (status.pressureReplay.processed && !firstBatch) {
      firstBatch = { processed: status.pressureReplay.processed, elapsedMs: Date.now() - began };
      assert.equal(firstBatch.processed, 24, 'real alarm must respect the batch bound');
      console.log(`First alarm: ${JSON.stringify(firstBatch)}; heart=${heart.length}, RMSSD=${hrv.length}.`);
      await mf.dispose();
      mf = new Miniflare(convertV4MiniflareOptions(options));
    }
  } while (status.pressureReplay.pending && Date.now() < deadline);
  assert.ok(firstBatch, 'real alarm must execute');
  assert.equal(status.pressureReplay.pending, false, JSON.stringify(status.pressureReplay));
  assert.equal(status.pressureReplay.processed, expectedAnchors);
  const dashboard = await request('/dashboard?range=7d');
  assert.ok(dashboard.pressureHistory.points.length > 500);
  assert.equal(dashboard.pressureHistory.points.length, status.pressureReplay.valid);
  assert.ok(dashboard.pressureHistory.points.every(p => p.basis === 'received_records_replay'));
  assert.equal(new Set(dashboard.pressureHistory.points.map(p => p.t)).size, dashboard.pressureHistory.points.length);
  assert.equal(dashboard.healthIndices.pressure.retained, true, 'dashboard may display a retained observation');
  assert.ok(dashboard.healthIndices.pressure.evidenceAt < today, 'replay must preserve historical measurement time');
  const snapshot = await request('/snapshot');
  assert.equal(snapshot.healthIndices.pressure.score, null, 'expired measurements cannot become current pressure');
  assert.equal(snapshot.healthIndices.pressure.reason, 'expired_hrv');
  assert.equal(snapshot.healthIndices.lastValidPressure.score, 50);
  assert.match(snapshot.healthIndices.title, /^🔵 状态正常 睡眠 - ｜/);
  assert.equal(status.series.heart, heart.length);
  assert.equal(status.series.hrv, hrv.length);
  console.log(`Runtime PASS: ${JSON.stringify({ elapsedMs: Date.now() - began,
    job: status.pressureReplay, points: dashboard.pressureHistory.points.length })}`);
} finally {
  await mf.dispose();
  await rm(storagePath, { recursive: true, force: true });
}
