import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { NativeCloudTestStore as NativeStore } from './native-sql-test-helper.mjs';

const { NativeHealthStore } = await import('./native-health-store.mjs').catch(() => ({}));
const cutoff = Date.parse('2026-10-26T00:00:00+08:00');
const now = cutoff + 12 * 3600000;
const sample = (type, id, value, unit, at = now - 60000) => ({ op: 'upsert', typeIdentifier: 'HKQuantityTypeIdentifier'+type,
  recordId: id, start: new Date(at).toISOString(), end: new Date(at).toISOString(),
  source: { id: 'com.apple.health', name: 'Apple Watch', device: 'Watch' }, payload: { value, unit } });
const batch = (id, records) => JSON.stringify({ schemaVersion: 1, batchId: id, records });
function fixture(t, extra = {}) {
  assert.equal(typeof NativeHealthStore, 'function', 'native durable storage is not implemented');
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let alarm = null, clock = now, fail = false, title = null, fields = null, sends = 0, beforeWrite = null;
  const storage = {
    sql: { exec(sql, ...params) { const rows = db.prepare(sql).all(...params); return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() }; } },
    transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch(e) { db.exec('ROLLBACK'); throw e; } },
    async transaction(fn) { db.exec('BEGIN'); try { const r = await fn(storage); db.exec('COMMIT'); return r; } catch(e) { db.exec('ROLLBACK'); throw e; } },
    async setAlarm(at) { alarm = Number(at); }, async getAlarm() { return alarm; }, async deleteAlarm() { alarm = null; },
  };
  const env = { NATIVE_MIN_START: new Date(cutoff).toISOString(), SIGNATURE_ENABLED: 'true',
    FEISHU_APP_ID: 'fixture', FEISHU_APP_SECRET: 'fixture', SIGNATURE_BASE_TOKEN: 'fixture-private',
    SIGNATURE_TABLE_ID: 'signature', SIGNATURE_RECORD_ID: 'record', DASHBOARD_CACHE_BASE_TOKEN: 'fixture-display',
    DASHBOARD_CACHE_TABLE_ID: 'dashboard', DASHBOARD_CACHE_RECORD_ID: 'view', ...extra };
  const send = async request => {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'fixture', expire: 7200 });
    if (fail) return new Response('unavailable', { status: 503 });
    const sig = path.includes('/tables/signature/');
    if (request.method === 'PUT') {
      if (beforeWrite) await beforeWrite();
      const body = await request.json(); sends++;
      if (sig) title = body.fields.title; else fields = body.fields;
    }
    return Response.json({ code: 0, data: { record: { record_id: sig ? 'record' : 'view', fields: sig ? { title } : fields } } });
  };
  const make = () => new NativeHealthStore({ storage }, env, send, () => clock);
  let store = make();
  return { db, get store() { return store; }, env, get alarm() { return alarm; }, get title() { return title; },
    get fields() { return fields; }, get sends() { return sends; }, setClock: v => { clock = v; },
    setFailure: v => { fail = v; }, restart: () => { store = make(); },
    beforeWrite: fn => { beforeWrite = fn; },
    async ingest(id, records, body = batch(id, records)) {
      return store.fetch(new Request('https://native/ingest', { method: 'POST', headers: { 'Idempotency-Key': id }, body }));
    }, async status() { return (await store.fetch(new Request('https://native/status'))).json(); },
  };
}

test('cloud commits native records and immutable receipts, including deletes and restart replay', async t => {
  const f = fixture(t), rows = [sample('HeartRate', 'heart', 72, 'count/min')];
  const response = await f.ingest('one', rows), receipt = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(receipt, { batchId: 'one', committed: true, accepted: 1, duplicates: 0 });
  assert.equal((await f.status()).recordCount, 1);
  assert.ok(f.alarm >= now + 30000);
  f.restart();
  assert.deepEqual(await (await f.ingest('one', rows)).json(), receipt);
  assert.equal((await f.status()).batchCount, 1);
  assert.equal((await f.ingest('one', [sample('HeartRate', 'heart', 73, 'count/min')])).status, 409);
  assert.equal((await f.ingest('delete', [{ op: 'delete', typeIdentifier: rows[0].typeIdentifier, recordId: 'heart' }])).status, 200);
  assert.equal((await f.status()).recordCount, 0);
});

test('a batch arriving during a signature write remains scheduled after the older write completes', async t => {
  const f = fixture(t);
  await f.ingest('one', [sample('HeartRate', 'heart', 72, 'count/min')]);
  let entered, release;
  const writing = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let first = true;
  f.beforeWrite(async () => { if (first) { first = false; entered(); await gate; } });
  f.setClock(f.alarm);
  const pending = f.store.alarm();
  await writing;
  await f.ingest('two', [sample('HeartRate', 'heart', 80, 'count/min')]);
  release(); await pending;
  assert.ok((await f.status()).signatureDelivery.dueAt > now, 'newer facts must stay pending');
  assert.ok((await f.status()).dashboardCache.dueAt > now, 'the dashboard must also keep newer facts pending');
  f.setClock(f.alarm); await f.store.alarm();
  assert.match(f.title, /心率80/);
});

test('cloud refuses pre-cutoff and malformed batches without committing any rows', async t => {
  const f = fixture(t);
  assert.equal((await f.ingest('old', [sample('HeartRate', 'old', 70, 'count/min', cutoff-1)])).status, 422);
  assert.equal((await f.ingest('mixed', [sample('HeartRate', 'good', 70, 'count/min'), sample('HeartRate', 'bad', -1, 'count/min')])).status, 422);
  assert.equal((await f.status()).recordCount, 0);
  assert.equal((await f.status()).batchCount, 0);
  assert.equal(f.alarm, null);
});

test('alarm publishes SDNN title and matching display facts, deduplicates unchanged refresh and survives failure', async t => {
  const f = fixture(t), rows = [sample('HeartRate', 'heart', 72, 'count/min'), sample('StepCount', 'steps', 1234, 'count')];
  await f.ingest('one', rows);
  f.setClock(f.alarm); f.setFailure(true); await f.store.alarm();
  assert.equal((await f.status()).published, null);
  assert.ok(f.alarm > now + 30000);
  f.restart(); f.setFailure(false); f.setClock(f.alarm); await f.store.alarm();
  assert.match(f.title, /心率72.*今日1234步/);
  const status = await f.status();
  assert.equal(status.indices.ruleVersion, 'health-indices-v4-nightly');
  assert.equal(status.published.title, f.title);
  assert.equal(status.signatureDelivery.error, null);
  const dto = JSON.parse(f.fields.payload_24h);
  assert.equal(dto.schemaVersion, 'dashboard-v1');
  assert.equal(dto.publication.sentTitle, f.title);
  assert.equal(dto.daily.at(-1).metrics.step_count.v, 1234);
  assert.equal(dto.heart.latest.v, 72);
  assert.equal(dto.healthIndices.pressure.score, null);
  assert.ok(!JSON.stringify(f.fields).includes('fixture'));
  const sends = f.sends;
  await f.store.alarm();
  assert.equal(f.sends, sends, 'same data and time must not rewrite either Base');
});

test('cloud and the Node SQLite test adapter produce identical SDNN results', async t => {
  const f = fixture(t, { NATIVE_MIN_START: '2026-10-01T00:00:00+08:00' });
  const local = new NativeStore(':memory:'); t.after(() => local.close());
  const rows = [1,2,3,0].flatMap(day => [sample('HeartRateVariabilitySDNN', 'v'+day, 50, 'ms', now-day*86400000-60000),
    sample('HeartRate', 'h'+day, 60, 'count/min', now-day*86400000-60000)]);
  local.ingest(batch('same', rows), 'same', now); await f.ingest('same', rows);
  const expected = local.status(now), actual = await f.status();
  assert.equal(actual.indices.pressure.score, 50);
  assert.deepEqual(actual.indices, expected.indices);
  assert.equal(actual.title, expected.title);
});

test('scoped graph queries preserve global channel metadata and 30-day workout details', async t => {
  const f = fixture(t, { NATIVE_MIN_START: new Date(now-35*86400000).toISOString() });
  const at = now-4*86400000;
  const rows = [sample('HeartRate', 'old-heart', 100, 'count/min', at), sample('HeartRate', 'recent-heart', 70, 'count/min'),
    { op: 'upsert', typeIdentifier: 'HKWorkoutType', recordId: 'workout',
      start: new Date(at-30*60000).toISOString(), end: new Date(at+60000).toISOString(),
      source: { id: 'com.apple.health', device: 'Watch' }, payload: { activityType: 'Run', durationSeconds: 1800 } }];
  assert.equal((await f.ingest('seed', rows)).status, 200);
  const expected = f.store.buildView('24h', f.store.repo.view(now), now);
  const actual = await (await f.store.fetch(new Request('https://native/dashboard?range=24h'))).json();
  assert.deepEqual(actual, expected, 'changing the graph query must not change historical workout facts or channel metadata');
  assert.equal(actual.workoutHistory.records[0].heart.avg, 100);
});

test('an early alarm does not read health history before any publication is due', async t => {
  const f = fixture(t);
  await f.ingest('one', [sample('HeartRate', 'heart', 72, 'count/min')]);
  const before = f.store.repo.readStats.rowsReturned;
  await f.store.alarm();
  assert.equal(f.store.repo.readStats.rowsReturned, before);
  assert.equal(f.sends, 0);
});

test('new uploads do not postpone an overdue publication alarm', async t => {
  const f = fixture(t);
  await f.ingest('first', [sample('HeartRate', 'heart', 72, 'count/min')]);
  const deadline = f.alarm;
  f.setClock(deadline+100);
  await f.ingest('second', [sample('HeartRate', 'heart', 80, 'count/min', deadline)]);
  assert.equal(f.alarm, deadline, 'a busy upload queue must not keep moving its publication deadline');
  await f.store.alarm();
  assert.match(f.title, /心率80/);
});

test('a minute-by-minute upload burst coalesces publication while retaining the newest facts', async t => {
  const f = fixture(t);
  for (let minute = 0; minute < 60; minute++) {
    const at = now+minute*60000;
    while (f.alarm !== null && f.alarm <= at) { f.setClock(f.alarm); await f.store.alarm(); }
    f.setClock(at);
    await f.ingest('burst-'+minute, [sample('HeartRate', 'heart', 60+minute, 'count/min', at)]);
  }
  while (f.alarm !== null && f.alarm <= now+65*60000) { f.setClock(f.alarm); await f.store.alarm(); }
  assert.match(f.title, /心率119/);
  assert.ok(f.sends <= 26, `one hour produced ${f.sends} Base writes instead of coalescing updates`);
});

test('dense sample expiry times are grouped without waking once per sample', async t => {
  const f = fixture(t, { NATIVE_MIN_START: '2026-09-01T00:00:00Z' });
  const old = Array.from({ length: 120 }, (_, i) => sample('HeartRate', 'old-'+i, 70, 'count/min', now-86400000+10*60000+i*1000));
  await f.ingest('history', [...old, sample('HeartRate', 'current', 72, 'count/min')]);
  let reviews = 0;
  while (f.alarm !== null && f.alarm < now+3600000 && reviews < 25) {
    f.setClock(f.alarm); await f.store.alarm(); reviews++;
  }
  assert.ok(reviews <= 6, `dense sample expiries triggered ${reviews} separate reviews in an hour`);
  assert.match(f.title, /心率72/);
});

test('grouping rolling windows preserves exact heart freshness expiry', async t => {
  const f = fixture(t);
  await f.ingest('heart', [sample('HeartRate', 'heart', 72, 'count/min', now-89*60000-20000)]);
  await f.store.fetch(new Request('https://native/signature/refresh', { method: 'POST' }));
  assert.match(f.title, /❤️ 心率72/);
  assert.equal(f.alarm, now+40000);
  f.setClock(now+40001); await f.store.alarm();
  assert.match(f.title, /❤️ 上次心率72/);
});

test("Beijing midnight rolls today's activity over without waiting for the review interval", async t => {
  const f = fixture(t);
  await f.ingest('steps', [sample('StepCount', 'steps', 1234, 'count')]);
  f.setClock(cutoff+86400000-60000);
  await f.store.fetch(new Request('https://native/signature/refresh', { method: 'POST' }));
  assert.match(f.title, /今日1234步/);
  assert.equal(f.alarm, cutoff+86400000);
  f.setClock(f.alarm); await f.store.alarm();
  assert.match(f.title, /今日步数暂无/);
});
