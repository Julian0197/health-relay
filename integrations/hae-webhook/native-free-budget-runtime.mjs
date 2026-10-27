// Real SQLite billing counters, synthetic health facts, intercepted publication only.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(process.argv[2]).href);
const root = await mkdtemp(join(tmpdir(), 'native-free-budget-'));
const bundle = fileURLToPath(new URL('./dist/native-free-budget-worker.mjs', import.meta.url));
const built = await build({ entryPoints: [fileURLToPath(new URL('../../tests/native-free-budget-harness.mjs', import.meta.url))],
  outfile: bundle, write: false, bundle: true, format: 'esm', platform: 'browser' });
const DAY = 86400000, MINUTE = 60000;
const start = Math.floor((Date.now()+8*3600000)/DAY)*DAY-8*3600000;
let title, fields, signatureWrites = 0, cacheWrites = 0;
const options = { cf: false, resourcePersistencePath: join(root, 'data'), workers: [{
  name: 'native-free-budget', modules: [{ type: 'ESModule', path: bundle, contents: built.outputFiles[0].text }],
  compatibilityDate: '2026-09-01', durableObjects: { NATIVE_STORE: { className: 'NativeBudgetStore', useSQLite: true } },
  bindings: { NATIVE_API_KEY: 'fixture-only', NATIVE_MIN_START: new Date(start-DAY).toISOString(), SIGNATURE_ENABLED: 'true',
    FEISHU_APP_ID: 'fixture', FEISHU_APP_SECRET: 'fixture', SIGNATURE_BASE_TOKEN: 'fixture-private',
    SIGNATURE_TABLE_ID: 'signature', SIGNATURE_RECORD_ID: 'record', DASHBOARD_CACHE_BASE_TOKEN: 'fixture-display',
    DASHBOARD_CACHE_TABLE_ID: 'dashboard', DASHBOARD_CACHE_RECORD_ID: 'view' },
  outboundService: async request => {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'fixture', expire: 7200 });
    const signature = path === '/open-apis/bitable/v1/apps/fixture-private/tables/signature/records/record';
    assert.ok(signature || path === '/open-apis/bitable/v1/apps/fixture-display/tables/dashboard/records/view');
    if (request.method === 'PUT') {
      const body = await request.json();
      if (signature) { title = body.fields.title; signatureWrites++; } else { fields = body.fields; cacheWrites++; }
    }
    return Response.json({ code: 0, data: { record: { record_id: signature ? 'record' : 'view', fields: signature ? { title } : fields } } });
  },
}] };
let mf = new Miniflare(convertV4MiniflareOptions(options));
const headers = { 'X-Acceptance-Key': 'fixture-only', 'Content-Type': 'application/json' };
const post = async (path, body, more = {}) => {
  const response = await mf.dispatchFetch('https://fixture'+path, { method: 'POST', headers: { ...headers, ...more }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};
const upload = (id, records) => post('/ingest', { schemaVersion: 1, batchId: id, records }, { 'Idempotency-Key': id });
const status = async () => {
  const response = await mf.dispatchFetch('https://fixture/status', { headers });
  assert.equal(response.status, 200); return response.json();
};
const stats = async () => (await mf.dispatchFetch('https://fixture/__stats')).json();
const sample = (id, at, n) => {
  const [type, value, unit] = n%1200 === 0 ? ['HeartRateVariabilitySDNN', 50, 'ms']
    : n%3 === 0 ? ['HeartRate', 72, 'count/min'] : n%3 === 1 ? ['StepCount', 2, 'count'] : ['ActiveEnergyBurned', 0.1, 'kcal'];
  return { op: 'upsert', typeIdentifier: 'HKQuantityTypeIdentifier'+type,
    recordId: id.padStart(36, '0'), start: new Date(at).toISOString(), end: new Date(at).toISOString(),
    source: { id: 'com.apple.health.synthetic.watch.source.for.budget', name: 'Synthetic Apple Watch source for mixed-metric regression', device: 'Watch', version: '27.0.1' },
    payload: { value, unit } };
};
try {
  let seeded = 0, largestDayBytes = 0, maxSeedWrites = 0;
  for (let day = 0; day < 35; day++) {
    const at = start+day*DAY, count = day >= 28 ? 8500 : 500;
    await post('/__time', { now: at+DAY-1 });
    const before = await stats();
    const records = Array.from({ length: count }, (_, i) => sample(`history-${day}-${i}`, at+Math.floor(i*DAY/count), i));
    largestDayBytes = Math.max(largestDayBytes, Buffer.byteLength(JSON.stringify(records)));
    for (let i = 0; i < records.length; i += 500) await upload(`seed-${day}-${i}`, records.slice(i, i+500));
    const after = await stats();
    maxSeedWrites = Math.max(maxSeedWrites, after.sqlUsage.rowsWritten-before.sqlUsage.rowsWritten);
    seeded += count;
  }
  assert.equal(seeded, 73500);
  assert.ok(largestDayBytes > 1000000, 'the incident requires genuinely oversized mixed-metric days');
  assert.ok(maxSeedWrites < 50000, 'historical data is seeded as separate days, not an unbounded one-day backfill');
  const first = await status(); assert.equal(first.recordCount, 73500);
  const warmBefore = await stats(); await status(); const warmAfter = await stats();
  assert.equal(warmAfter.readStats.rowsReturned, warmBefore.readStats.rowsReturned, 'warm views must reuse unchanged day facts');
  await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options));
  const coldBefore = await stats(), restarted = await status(), coldAfter = await stats();
  assert.equal(restarted.recordCount, 73500);
  const restartedReads = coldAfter.sqlUsage.rowsRead-coldBefore.sqlUsage.rowsRead;
  assert.ok(restartedReads < 300, `a cold process reread ${restartedReads} rows instead of cached chunks`);
  console.log('Oversized-day restart:', JSON.stringify({ records: seeded, largestDayBytes, restartedReads, maxSeedWrites }));

  // A small edit followed immediately by process eviction must reuse the day base.
  const revised = sample('history-34-8497', start+34*DAY+Math.floor(8497*DAY/8500), 8497);
  revised.payload.value = 3;
  await upload('late-correction', [revised]);
  await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options));
  const editBefore = await stats(), corrected = await status(), editAfter = await stats();
  assert.equal(corrected.recordCount, 73500);
  const correctedRestartReads = editAfter.sqlUsage.rowsRead-editBefore.sqlUsage.rowsRead;
  assert.ok(correctedRestartReads < 300, 'a one-record correction must not rescan the large cached day after eviction');
  console.log('Incremental correction restart:', JSON.stringify({ rowsRead: correctedRestartReads }));

  const today = start+35*DAY, before = await stats(), writesBefore = signatureWrites+cacheWrites;
  let alarms = 0;
  for (let minute = 0; minute < 1440; minute++) {
    const at = today+minute*MINUTE;
    let current = await post('/__time', { now: at });
    if (current.alarmAt !== null && current.alarmAt <= at) { await post('/__alarm', {}); alarms++; }
    if (minute%10 === 0) {
      const rows = Array.from({ length: 50 }, (_, i) => sample(`today-${minute}-${i}`, at-i*1000, minute*50+i));
      await upload('today-'+minute, rows);
    }
  }
  await post('/__time', { now: today+DAY }); await post('/__alarm', {}); alarms++;
  const after = await stats(), result = {
    historyRecords: seeded, newRecords: 7200, alarms,
    rowsRead: after.sqlUsage.rowsRead-before.sqlUsage.rowsRead,
    rowsWritten: after.sqlUsage.rowsWritten-before.sqlUsage.rowsWritten,
    evaluations: after.evaluations-before.evaluations,
    publicationWrites: signatureWrites+cacheWrites-writesBefore,
  };
  assert.equal(after.reception.recordCount, 80700);
  assert.ok(result.rowsRead < 50000, 'incremental reads must stay below 1% of the shared daily Free allowance in this fixture');
  assert.ok(result.rowsWritten < 50000, 'cache rebuilding must not turn the read fix into write exhaustion');
  assert.ok(result.evaluations < 400, 'rolling windows must not create a sample-by-sample alarm storm');
  assert.ok(fields && title);
  console.log('24-hour mixed-data Free budget:', JSON.stringify(result));
  console.log('Native Free budget PASS: 73,500 historical records, >1 MB days, durable restart cache, 7,200 daily records, and every automatic review over 24 hours.');
} finally { await mf.dispose(); await rm(root, { recursive: true, force: true }); }
