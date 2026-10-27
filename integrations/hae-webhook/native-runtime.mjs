// Synthetic data only. Every outbound request is intercepted; never contacts Feishu.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(process.argv[2]).href);
const root = await mkdtemp(join(tmpdir(), 'healthrelay-native-'));
// workerd resolves module names relative to its module root, not the OS temp directory.
const bundle = fileURLToPath(new URL('./dist/native-runtime-worker.mjs', import.meta.url));
const built = await build({ entryPoints: [fileURLToPath(new URL('../../tests/native-cloudflare-harness.mjs', import.meta.url))], outfile: bundle, write: false, bundle: true, format: 'esm', platform: 'browser' });
const now = Date.now(), DAY = 86400000;
let title, cache, signatureWrites = 0, cacheWrites = 0;
const options = { cf: false, resourcePersistencePath: join(root, 'data'), workers: [{
  name: 'native-runtime', modules: [{ type: 'ESModule', path: bundle, contents: built.outputFiles[0].text }], compatibilityDate: '2026-09-01',
  durableObjects: { NATIVE_STORE: { className: 'NativeRuntimeStore', useSQLite: true } },
  bindings: { NATIVE_API_KEY: 'fixture-only', NATIVE_MIN_START: new Date(now-40*DAY).toISOString(), SIGNATURE_ENABLED: 'true',
    FEISHU_APP_ID: 'fixture', FEISHU_APP_SECRET: 'fixture', SIGNATURE_BASE_TOKEN: 'fixture-private', SIGNATURE_TABLE_ID: 'signature', SIGNATURE_RECORD_ID: 'record',
    DASHBOARD_CACHE_BASE_TOKEN: 'fixture-display', DASHBOARD_CACHE_TABLE_ID: 'dashboard', DASHBOARD_CACHE_RECORD_ID: 'view' },
  outboundService: async request => {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'fixture', expire: 7200 });
    const sig = path === '/open-apis/bitable/v1/apps/fixture-private/tables/signature/records/record';
    assert.ok(sig || path === '/open-apis/bitable/v1/apps/fixture-display/tables/dashboard/records/view', 'unexpected outbound request');
    if (request.method === 'PUT') {
      const { fields } = await request.json();
      if (sig) { title = fields.title; signatureWrites++; } else { cache = fields; cacheWrites++; }
    }
    return Response.json({ code: 0, data: { record: { record_id: sig ? 'record' : 'view', fields: sig ? { title } : cache } } });
  },
}] };
let mf = new Miniflare(convertV4MiniflareOptions(options));
const headers = { 'X-Acceptance-Key': 'fixture-only', 'Content-Type': 'application/json' };
const sample = (id, at, type = 'HeartRate', value = 72, unit = 'count/min') => ({ op: 'upsert',
  typeIdentifier: 'HKQuantityTypeIdentifier'+type, recordId: id, start: new Date(at).toISOString(), end: new Date(at).toISOString(),
  source: { id: 'com.apple.health', name: 'Apple Watch', device: 'Watch' }, payload: { value, unit } });
const post = (path, body, more = {}) => mf.dispatchFetch('https://fixture'+path, { method: 'POST', headers: { ...headers, ...more }, body: JSON.stringify(body) });
const upload = (id, records) => post('/ingest', { schemaVersion: 1, batchId: id, records }, { 'Idempotency-Key': id });
const status = async () => (await mf.dispatchFetch('https://fixture/status', { headers })).json();
try {
  assert.equal((await mf.dispatchFetch('https://fixture/status')).status, 401);
  const rows = [sample('heart', now-60000), sample('steps', now-60000, 'StepCount', 1234, 'count')];
  const first = await upload('one', rows), receipt = await first.json();
  assert.equal(first.status, 200, JSON.stringify(receipt));
  assert.deepEqual(receipt, { batchId: 'one', committed: true, accepted: 2, duplicates: 0 });
  await post('/__storage-failure', {});
  assert.equal((await upload('rollback', [sample('rejected', now)])).status, 500);
  assert.equal((await status()).recordCount, 2);
  await post('/__recover-storage', {});
  console.log('Native runtime: committed receipt and rollback verified; waiting for the real Alarm.');
  const deadline = Date.now()+45000;
  while ((!signatureWrites || !cacheWrites) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(signatureWrites, 1); assert.equal(cacheWrites, 1);
  assert.match(title, /心率72.*今日1234步/);
  assert.equal(JSON.parse(cache.payload_24h).publication.sentTitle, title);
  await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options));
  assert.deepEqual(await (await upload('one', rows)).json(), receipt);
  assert.equal((await status()).batchCount, 1);
  assert.equal((await upload('one', [sample('changed', now)])).status, 409);
  assert.equal((await upload('old', [sample('old', now-41*DAY)])).status, 422);
  assert.equal((await upload('delete', [{ op: 'delete', typeIdentifier: rows[0].typeIdentifier, recordId: 'heart' }])).status, 200);
  assert.equal((await status()).recordCount, 1);
  // Accumulate a day at a time, including publication and cross-day expiry work.
  const dailyBudgets = [], baseDay = Math.floor((now+8*3600000)/DAY)*DAY-8*3600000;
  for (let day = 0; day < 35; day++) {
    const dayStart = baseDay+day*DAY, end = dayStart+DAY-1;
    await post('/__advance', { now: end });
    const before = await status(), started = Date.now();
    const records = Array.from({ length: 1440 }, (_, minute) => sample('day-'+day+'-'+minute, dayStart+minute*60000));
    for (let i = 0; i < records.length; i += 500) {
      const response = await upload('day-'+day+'-'+i, records.slice(i, i+500));
      assert.equal(response.status, 200, await response.text());
    }
    const after = await (await post('/__advance', { now: end+31000 })).json();
    const budget = { day: day+1, rowsRead: after.sqlUsage.rowsRead-before.sqlUsage.rowsRead,
      rowsWritten: after.sqlUsage.rowsWritten-before.sqlUsage.rowsWritten, elapsedMs: Date.now()-started };
    assert.ok(budget.rowsRead < 5000000 && budget.rowsWritten < 100000, 'daily SQLite work must fit the Free plan');
    dailyBudgets.push(budget);
  }
  const warm = await status(), reused = await status();
  assert.ok(reused.sqlUsage.rowsRead-warm.sqlUsage.rowsRead < 150, 'unchanged reads must use persisted daily caches');
  assert.ok(reused.seriesReadStats.dayCacheHits > warm.seriesReadStats.dayCacheHits);
  console.log('35-day budget:', JSON.stringify({ days: dailyBudgets.length,
    maxRowsRead: Math.max(...dailyBudgets.map(d => d.rowsRead)), maxRowsWritten: Math.max(...dailyBudgets.map(d => d.rowsWritten)),
    maxElapsedMs: Math.max(...dailyBudgets.map(d => d.elapsedMs)), cachedReadRows: reused.sqlUsage.rowsRead-warm.sqlUsage.rowsRead }));
  console.log('Native runtime PASS: real SQLite transaction rollback, automatic Alarm, immutable receipts after restart, deletion and 35-day cached reads.');
} finally { await mf.dispose(); await rm(root, { recursive: true, force: true }); }
