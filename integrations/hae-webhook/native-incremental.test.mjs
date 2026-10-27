import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeCloudTestStore as NativeStore } from './native-sql-test-helper.mjs';
import { nativeSeries, nativeSnapshot, nativeIdentity } from './native-domain.mjs';
const DAY = 86400000, now = Date.parse('2026-10-27T04:00:00Z');
const sample = (id, value = 72, type = 'HeartRate', at = now-60000, unit = 'count/min') => ({
  op: 'upsert', typeIdentifier: 'HKQuantityTypeIdentifier'+type, recordId: id,
  start: new Date(at).toISOString(), end: new Date(at).toISOString(),
  source: { id: 'fixture', name: 'Synthetic source '.repeat(50), device: 'Watch' }, payload: { value, unit },
});
const batch = (id, records) => JSON.stringify({ schemaVersion: 1, batchId: id, records });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'native-incremental-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return () => {
    const store = new NativeStore(join(directory, 'health.sqlite')), reads = { rawRows: 0 };
    const all = store.sql.all;
    store.sql.all = (sql, ...args) => {
      const rows = all(sql, ...args);
      if (/SELECT (?:key,)?body FROM native_records/.test(sql)) reads.rawRows += rows.length;
      return rows;
    };
    return { store, reads };
  };
}

test('one new sample after a cached large day survives restart without rereading that day', t => {
  const open = fixture(t); let { store } = open();
  const rows = Array.from({ length: 1600 }, (_, i) => sample('seed-'+i));
  store.ingest(batch('seed', rows), 'seed', now); store.recentRecords(now);
  store.ingest(batch('new', [sample('new', 81)]), 'new', now); store.close();
  const reopened = open(); store = reopened.store; t.after(() => store.close());
  const actual = store.recentRecords(now);
  assert.equal(actual.length, 1601); assert.equal(actual.find(r => r.recordId === 'new').payload.value, 81);
  assert.equal(reopened.reads.rawRows, 0, 'a small durable delta must not invalidate the whole cached day');
});

test('daily-only changes update totals without repeatedly evaluating the unchanged HRV evidence', t => {
  const { store } = fixture(t)(); t.after(() => store.close());
  const baseline = [0,1,2,3].flatMap(day => [sample('h-'+day, 60, 'HeartRate', now-day*DAY-60000),
    sample('v-'+day, 50, 'HeartRateVariabilitySDNN', now-day*DAY-60000, 'ms')]);
  store.ingest(batch('baseline', baseline), 'baseline', now);
  assert.equal(store.status(now).indices.pressure.score, 50);
  assert.equal(store.readStats.scoringEvaluations, 1);
  for (let i = 0; i < 20; i++) {
    const at = now+i*1000;
    store.ingest(batch('steps-'+i, [sample('s-'+i, 2, 'StepCount', at, 'count')]), 'steps-'+i, at);
    const status = store.status(at);
    assert.equal(status.activity.steps.value, (i+1)*2);
    assert.equal(status.indices.pressure.score, 50);
  }
  assert.equal(store.readStats.scoringEvaluations, 1, 'step updates do not change the HRV scoring inputs');
  store.ingest(batch('revise', [sample('v-0', 20, 'HeartRateVariabilitySDNN', now-60000, 'ms')]), 'revise', now+30000);
  assert.ok(store.status(now+30000).indices.pressure.score > 50);
  assert.equal(store.readStats.scoringEvaluations, 2);
});

test('a 24-hour graph uses recent heart detail while preserving the older scoring baseline', t => {
  const { store } = fixture(t)(); t.after(() => store.close());
  const rows = [0,1,2,3].flatMap(day => [sample('h-'+day, 60, 'HeartRate', now-day*DAY-60000),
    sample('v-'+day, 50, 'HeartRateVariabilitySDNN', now-day*DAY-60000, 'ms')]);
  store.ingest(batch('seed', rows), 'seed', now);
  const view = store.view(now, { range: '24h' });
  assert.equal(view.status.indices.pressure.score, 50);
  assert.equal(view.series.heart.length, 1, 'historical baseline samples are not chart detail');
  assert.equal(view.series.heart[0].id, 'h-0');
});

test('incremental daily means remain sample-weighted after cross-day corrections and deletions', t => {
  const { store } = fixture(t)(); t.after(() => store.close());
  const rows = [sample('a', 60, 'RespiratoryRate', now-60000), sample('b', 12, 'RespiratoryRate', now-30000),
    sample('c', 18, 'RespiratoryRate', now-10000)];
  store.ingest(batch('seed', rows), 'seed', now); store.status(now);
  const daily = () => store.view(now).series.daily.find(r => r.metric === 'respiratory_rate' && r.start > now-DAY);
  assert.equal(daily().value, 30);
  const moved = { ...rows[0], start: new Date(now-DAY).toISOString(), end: new Date(now-DAY).toISOString() };
  store.ingest(batch('move', [moved]), 'move', now);
  assert.equal(daily().value, 15);
  store.ingest(batch('delete', [{ op: 'delete', typeIdentifier: rows[1].typeIdentifier, recordId: 'b' }]), 'delete', now);
  assert.equal(daily().value, 18);
});

test('daily aggregates normalize only changed facts after a warm view', t => {
  const { store } = fixture(t)(); t.after(() => store.close());
  const rows = Array.from({ length: 1200 }, (_, i) => sample('steps-'+i, 2, 'StepCount', now-60000, 'count'));
  store.ingest(batch('seed', rows), 'seed', now); store.status(now);
  const before = store.readStats.normalizedRecords;
  for (let i = 0; i < 10; i++) {
    store.ingest(batch('change-'+i, [sample('steps-'+i, 3, 'StepCount', now-60000, 'count')]), 'change-'+i, now);
    assert.equal(store.status(now).activity.steps.value, 2400+i+1);
  }
  assert.ok(store.readStats.normalizedRecords-before <= 20, 'unchanged daily samples must not be normalized again');
});

test('a view keeps its original activity facts when a later upload changes the cache', t => {
  const { store } = fixture(t)(); t.after(() => store.close());
  store.ingest(batch('seed', [sample('s', 2, 'StepCount', now-60000, 'count')]), 'seed', now);
  const view = store.view(now);
  store.ingest(batch('later', [sample('s', 9, 'StepCount', now-60000, 'count')]), 'later', now);
  assert.equal(view.activityAt(now).steps.value, 2, 'publication must use one consistent received snapshot');
  assert.equal(store.status(now).activity.steps.value, 9);
});

test('projections match the original converter through extrema removal, source changes and rolling cutoff', t => {
  const { store } = fixture(t)(); t.after(() => store.close());
  const seed = [sample('a', 2, 'StepCount', now-60000, 'count'), sample('b', 3, 'StepCount', now-20000, 'count'),
    sample('r1', 12, 'RespiratoryRate', now-DAY), sample('r2', 18, 'RespiratoryRate', now-10000),
    sample('edge-old', 100, 'RespiratoryRate', now-35*DAY-1), sample('edge-valid', 20, 'RespiratoryRate', now-35*DAY+1)];
  const parity = at => {
    const records = store.recentRecords(at), expected = nativeSeries(records, at);
    assert.deepEqual(store.view(at).series, expected);
    assert.deepEqual(store.status(at).activity, nativeSnapshot(records, expected, at, null, at).activity);
  };
  store.ingest(batch('seed', seed), 'seed', now); parity(now);
  const revised = { ...seed[0], source: { ...seed[0].source, device: 'iPhone' }, end: seed[1].end };
  store.ingest(batch('revise', [revised]), 'revise', now); parity(now);
  store.ingest(batch('delete-max', [{ op: 'delete', typeIdentifier: seed[1].typeIdentifier, recordId: 'b' }]), 'delete-max', now); parity(now);
  store.ingest(batch('delete-first', [{ op: 'delete', typeIdentifier: seed[0].typeIdentifier, recordId: 'a' }]), 'delete-first', now); parity(now+2);
});

test('cached scoring respects future measurements, exact expiry and persisted reuse after restart', t => {
  const open = fixture(t); let { store } = open();
  const rows = [0,1,2,3].flatMap(day => [sample('h-'+day, 60, 'HeartRate', now-day*DAY-60000),
    sample('v-'+day, 50, 'HeartRateVariabilitySDNN', now-day*DAY-60000, 'ms')]);
  rows.push(sample('future', 90, 'HeartRate', now+30000));
  store.ingest(batch('seed', rows), 'seed', now); store.status(now); store.close();
  ({ store } = open()); t.after(() => store.close());
  assert.equal(store.status(now+1000).indices.displayedHeart.value, 60);
  assert.equal(store.readStats.scoringEvaluations, 0, 'a restart can reuse valid durable scoring evidence');
  for (const at of [now+30000, now+90*60000, now+6*3600000, now+DAY]) {
    const records = store.recentRecords(at), expected = nativeSnapshot(records, nativeSeries(records, at), at, null, now);
    const actual = store.status(at);
    assert.deepEqual(actual.indices.pressure, expected.indices.pressure);
    assert.deepEqual(actual.indices.displayedHeart, expected.indices.displayedHeart);
    assert.equal(actual.title, expected.title);
  }
});

test('a previous-version writer invalidates only derived caches when the new worker resumes', t => {
  const open = fixture(t); let { store } = open();
  const original = sample('same', 60);
  store.ingest(batch('seed', [original]), 'seed', now); store.status(now);
  const revised = sample('same', 90), reception = store.state('reception');
  store.db.prepare('UPDATE native_records SET body=? WHERE key=?').run(JSON.stringify(revised), nativeIdentity(revised));
  store.saveState('reception', { ...reception, batchCount: reception.batchCount+1 });
  store.close(); ({ store } = open()); t.after(() => store.close());
  assert.equal(store.status(now).indices.displayedHeart.value, 90);
  assert.equal(store.rawRecords().length, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM native_batches').get().n, 1, 'existing receipts survive cache recovery');
});
