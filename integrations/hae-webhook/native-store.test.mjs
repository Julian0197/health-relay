import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeStore } from './native-store.mjs';
const now = Date.parse('2026-10-20T08:00:00Z');
const sample = (type, id, value, unit = 'count/min', start = now - 60000, end = start) => ({
  op: 'upsert', typeIdentifier: type.startsWith('HK') ? type : `HKQuantityTypeIdentifier${type}`, recordId: id,
  start: new Date(start).toISOString(), end: new Date(end).toISOString(),
  source: { id: 'watch-source', name: 'Watch' }, payload: { value, unit },
});
const batch = (id, records) => JSON.stringify({ schemaVersion: 1, batchId: id, taskId: 'task', configRevision: 1, records });
const heartParent = (id, start, values, spacing = 60000) => ({
  ...sample('HeartRate', id, 180, 'count/min', start, start + values.length * spacing),
  payload: { value: 180, unit: 'count/min', quantityCount: values.length,
    series: values.map((value, i) => ({ start: new Date(start + i * spacing).toISOString(),
      end: new Date(start + i * spacing).toISOString(), value })) },
});
function fixture(t) {
  assert.equal(typeof NativeStore, 'function', 'durable native HealthRelay store must exist');
  const dir = mkdtempSync(join(tmpdir(), 'healthrelay-native-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { file: join(dir, 'health.sqlite'), open: () => new NativeStore(join(dir, 'health.sqlite')) };
}
test('acknowledges only committed records and replays the same receipt after restart', t => {
  const f = fixture(t), body = batch('b1', [sample('HeartRate', 'h1', 72)]);
  let store = f.open();
  const receipt = store.ingest(body, 'b1', now);
  assert.deepEqual(receipt, { batchId: 'b1', committed: true, accepted: 1, duplicates: 0 });
  store.close(); store = f.open(); t.after(() => store.close());
  assert.deepEqual(store.ingest(body, 'b1', now), receipt);
  assert.equal(store.rawRecords()[0].payload.value, 72);
  assert.throws(() => store.ingest(batch('b1', [sample('HeartRate', 'h1', 80)]), 'b1', now), e => e.status === 409);
  assert.deepEqual(store.ingest(batch('b2', [sample('HeartRate', 'h1', 72)]), 'b2', now),
    { batchId: 'b2', committed: true, accepted: 0, duplicates: 1 });
});
test('validates the complete batch before committing any raw or derived facts', t => {
  const store = fixture(t).open(); t.after(() => store.close());
  const invalid = sample('HeartRate', 'bad', -1);
  assert.throws(() => store.ingest(batch('b', [sample('HeartRate', 'h', 72), invalid]), 'b', now), e => e.status === 422);
  assert.equal(store.rawRecords().length, 0);
  assert.deepEqual(store.series(now), { hrv: [], heart: [], sleep: [], daily: [], workout: [] });
  assert.throws(() => store.ingest(batch('b', [sample('HeartRate', 'h', 72)]), 'wrong', now), e => e.status === 422);
});
test('maps native HealthKit units and sleep stages into the existing scorer without inventing RMSSD', t => {
  const store = fixture(t).open(); t.after(() => store.close());
  store.ingest(batch('b', [sample('HeartRateVariabilitySDNN', 'v', .069, 's'), sample('HeartRate', 'h', 76),
    sample('HKCategoryTypeIdentifierSleepAnalysis', 's', 4, undefined, now-8*3600000, now-7*3600000),
    sample('RestingHeartRate', 'r', 56), sample('StepCount', 'a', 100, 'count'), sample('StepCount', 'a2', 50, 'count'),
  ]), 'b', now);
  const series = store.series(now);
  assert.equal(series.hrv[0].value, 69); assert.equal(series.hrv[0].method, 'SDNN');
  assert.equal(series.heart[0].value, 76); assert.equal(series.heart[0].end, now-60000);
  assert.equal(series.sleep[0].stage, 'deep');
  assert.equal(series.daily.find(r => r.metric === 'step_count').value, 150);
  assert.equal(series.daily.find(r => r.metric === 'resting_heart_rate').value, 56);
  const state = store.status(now);
  assert.equal(state.title, '❔ 状态暂无｜🛏️ 睡眠暂无｜❤️ 心率76｜🪑 今日150步｜同步时间: 10/20 16:00｜详情 ↗');
  assert.doesNotMatch(state.title, /HRV|69/);
});
test('keeps native RMSSD and SDNN separate and converts recovery HRV seconds to milliseconds', t => {
  const store = fixture(t).open(); t.after(() => store.close());
  store.ingest(batch('recovery', [sample('HeartRateVariabilityRMSSD', 'r', .0456, 's'),
    sample('HeartRateVariabilityRMSSD', 'r-ms', 51, 'ms'),
    sample('HeartRateVariabilitySDNN', 's', 99, 'ms')]), 'recovery', now);
  assert.deepEqual(store.series(now).hrv.map(({ id, value, unit, method }) => ({ id, value, unit, method })), [
    { id: 'r', value: 45.6, unit: 'ms', method: 'RMSSD' },
    { id: 'r-ms', value: 51, unit: 'ms', method: 'RMSSD' },
    { id: 's', value: 99, unit: 'ms', method: 'SDNN' },
  ]);
});
test('rejects invalid recovery HRV before committing the batch', t => {
  const store = fixture(t).open(); t.after(() => store.close());
  for (const [value, unit] of [[0, 'ms'], [-1, 'ms'], [null, 'ms'], [45, 'bpm']]) {
    assert.throws(() => store.ingest(batch('invalid', [sample('HeartRate', 'h', 70),
      sample('HeartRateVariabilityRMSSD', 'r', value, unit)]), 'invalid', now), e => e.status === 422);
    assert.equal(store.rawRecords().length, 0);
  }
});
test('uses recovery HRV on cold start and never reuses the old SDNN score or baseline', async t => {
  const f = fixture(t), store = f.open(); t.after(() => store.close());
  const records = [0, 1, 2, 3].flatMap(day => [
    sample('HeartRateVariabilitySDNN', `v-${day}`, 50, 'ms', now - 60000 - day * 86400000),
    sample('HeartRate', `h-${day}`, 60, 'count/min', now - 60000 - day * 86400000),
  ]);
  store.ingest(batch('old', records), 'old', now);
  store.saveState('publishedDecision', { ruleVersion: 'health-indices-v4-nightly',
    features: { hrv: { method: 'SDNN' } }, pressure: { score: 50, source: 'watch-source',
      evidenceAt: now - 60000, context: 'awake_sample', evidence: { hrv: 50 } } });
  let title;
  await store.publish(async value => { title = value; }, now);
  assert.match(title, /^❔ 状态暂无｜/);
  assert.doesNotMatch(title, /状态正常|HRV 50/);
  const restarted = f.open(); t.after(() => restarted.close());
  const indices = restarted.status(now).indices;
  assert.equal(indices.features.hrv.method, 'RMSSD');
  assert.equal(indices.pressure.hrvMethod, 'RMSSD');
  assert.equal(indices.pressure.score, null);
  assert.equal(indices.pressure.reason, 'missing_hrv');
  assert.equal(indices.pressure.hrvBaseline.days, 0);
});
test('RMSSD needs ten distinct heart minutes rather than ten dense native samples', t => {
  const store = fixture(t).open(); t.after(() => store.close());
  store.ingest(batch('dense-heart', [
    ...[1, 6, 11].map(minute => sample('HeartRateVariabilityRMSSD', `r-${minute}`, 45, 'ms', now-minute*60000)),
    ...Array.from({ length: 10 }, (_, i) => sample('HeartRate', `h-${i}`, 60, 'count/min', now-2*60000+i*1000)),
  ]), 'dense-heart', now);
  const pressure = store.status(now).indices.pressure;
  assert.equal(pressure.reason, 'missing_or_conflicting_aligned_hr');
  assert.equal(pressure.evidence.heartWindows, 1);
});
test('native heart series supplies real minute evidence and the latest point instead of the parent summary', t => {
  const store = fixture(t).open(); t.after(() => store.close());
  const evidence = now - 60000;
  const window = (id, at) => [
    ...[0, 10, 19].map(minute => sample('HeartRateVariabilityRMSSD', `r-${id}-${minute}`, 50, 'ms', at-minute*60000)),
    ...Array.from({ length: 4 }, (_, i) => heartParent(`h-${id}-${i}`, at-(19-i*5)*60000,
      id === 'current' && i === 3 ? [60, 60, 60, 60, 72] : [60, 60, 60, 60, 60])),
  ];
  store.ingest(batch('series', [...[1, 2, 3, 4, 5, 6, 7].flatMap(day => window(day, evidence-day*86400000)),
    ...window('current', evidence)]), 'series', now);
  const current = store.series(now).heart.filter(row => row.start >= evidence-19*60000);
  assert.equal(current.length, 20);
  assert.ok(current.every(row => row.source === 'watch-source' && row.unit === 'bpm' && row.value !== 180));
  const state = store.status(now);
  assert.equal(state.indices.pressure.evidence.heartWindows, 20);
  assert.equal(state.indices.pressure.score, 50);
  assert.equal(state.indices.displayedHeart.value, 72);
  assert.equal(state.indices.displayedHeart.measuredAt, evidence);
  assert.equal(store.rawRecords().filter(row => row.typeIdentifier.endsWith('HeartRate')).length, 32);
});
test('native heart series does not turn a long scalar interval or dense points into missing minute evidence', t => {
  const store = fixture(t).open(); t.after(() => store.close());
  const evidence = now-90000;
  const hrv = [0, 10, 19].map(minute => sample('HeartRateVariabilityRMSSD', `r-${minute}`, 50, 'ms', evidence-minute*60000));
  const scalar = Array.from({ length: 4 }, (_, i) => {
    const start = evidence-(19.5-i*5)*60000;
    return sample('HeartRate', `scalar-${i}`, 60, 'count/min', start, start+5*60000);
  });
  store.ingest(batch('scalar', [...hrv, ...scalar]), 'scalar', now);
  assert.equal(store.series(now).heart.length, 4);
  assert.equal(store.status(now).indices.pressure.evidence.heartWindows, 4);
  assert.equal(store.status(now).indices.pressure.reason, 'missing_or_conflicting_aligned_hr');
  const deletes = scalar.map(row => ({ op: 'delete', typeIdentifier: row.typeIdentifier, recordId: row.recordId }));
  const dense = heartParent('dense', now-2*60000, Array(10).fill(60), 1000);
  store.ingest(batch('dense', [...deletes, dense]), 'dense', now);
  assert.equal(store.series(now).heart.length, 10);
  assert.equal(store.status(now).indices.pressure.evidence.heartWindows, 1);
  assert.equal(store.status(now).indices.pressure.reason, 'missing_or_conflicting_aligned_hr');
});
test('native heart series rejects invalid or incomplete points before committing any batch records', t => {
  const store = fixture(t).open(); t.after(() => store.close());
  store.ingest(batch('existing', [sample('HeartRate', 'existing', 55)]), 'existing', now);
  const valid = heartParent('parent', now-4*60000, [60, 65]);
  const variants = [
    { series: null }, { series: {} }, { series: [] },
    { quantityCount: undefined }, { quantityCount: 1 }, { quantityCount: 2.5 },
    { series: undefined }, { series: [null, valid.payload.series[1]] },
    ...[
      { start: '2026-10-20T07:56:00' },
      { start: new Date(now-5*60000).toISOString() },
      { end: new Date(now-5*60000).toISOString() },
      { end: new Date(now).toISOString() },
      { value: 0 }, { value: -1 }, { value: null },
    ].map(changes => ({ series: [{ ...valid.payload.series[0], ...changes }, valid.payload.series[1]] })),
  ];
  for (const [i, changes] of variants.entries()) {
    const invalid = { ...valid, payload: { ...valid.payload, ...changes } };
    assert.throws(() => store.ingest(batch(`invalid-${i}`, [sample('HeartRate', 'new', 70), invalid]), `invalid-${i}`, now),
      e => e.status === 422, `Invalid series variant ${i}`);
    assert.deepEqual(store.rawRecords().map(row => row.recordId), ['existing']);
    assert.equal(store.status(now).batchCount, 1);
  }
  assert.equal(store.ingest(batch('invalid-0', [valid]), 'invalid-0', now).accepted, 1);
});
test('native heart series replaces every derived point on parent correction and deletion across restart', t => {
  const f = fixture(t); let store = f.open();
  const parent = heartParent('parent', now-4*60000, [60, 65]);
  store.ingest(batch('original', [parent]), 'original', now);
  assert.deepEqual(store.series(now).heart.map(row => row.value), [60, 65]);
  const corrected = heartParent('parent', now-2*60000, [88]);
  store.ingest(batch('corrected', [corrected]), 'corrected', now);
  assert.deepEqual(store.series(now).heart.map(row => row.value), [88]);
  assert.equal(store.rawRecords().length, 1);
  store.close(); store = f.open();
  assert.deepEqual(store.series(now).heart.map(row => row.value), [88]);
  store.ingest(batch('deleted', [{ op: 'delete', typeIdentifier: parent.typeIdentifier, recordId: parent.recordId }]), 'deleted', now);
  store.close(); store = f.open(); t.after(() => store.close());
  assert.equal(store.series(now).heart.length, 0);
  assert.equal(store.rawRecords().length, 0);
});
test('native heart series survives an unchanged legacy parent replay without changing its frozen batch identity', t => {
  const store = fixture(t).open(); t.after(() => store.close());
  const parent = heartParent('parent', now-4*60000, [60, 65]);
  const legacy = { ...parent, payload: { value: parent.payload.value, unit: parent.payload.unit } };
  store.ingest(batch('enriched', [parent]), 'enriched', now);
  const body = batch('legacy', [legacy]);
  const receipt = store.ingest(body, 'legacy', now);
  assert.deepEqual(receipt, { batchId: 'legacy', committed: true, accepted: 0, duplicates: 1 });
  assert.deepEqual(store.series(now).heart.map(row => row.value), [60, 65]);
  assert.deepEqual(store.rawRecords()[0].payload.series, parent.payload.series);
  assert.deepEqual(store.ingest(body, 'legacy', now+60000), receipt);
  assert.throws(() => store.ingest(batch('legacy', [parent]), 'legacy', now), e => e.status === 409);
  const incomplete = { ...legacy, payload: { ...legacy.payload, quantityCount: 2 } };
  assert.throws(() => store.ingest(batch('incomplete', [incomplete]), 'incomplete', now), e => e.status === 422);
  assert.deepEqual(store.series(now).heart.map(row => row.value), [60, 65]);
});
test('native heart series is cleared when a legacy parent corrects any core measurement field', t => {
  const store = fixture(t).open(); t.after(() => store.close());
  const parent = heartParent('parent', now-4*60000, [60, 65]);
  const legacy = { ...parent, payload: { value: parent.payload.value, unit: parent.payload.unit } };
  const corrections = [
    { ...legacy, start: new Date(now-5*60000).toISOString() },
    { ...legacy, end: new Date(now-60000).toISOString() },
    { ...legacy, payload: { ...legacy.payload, value: 88 } },
    { ...legacy, payload: { ...legacy.payload, unit: 'bpm' } },
    { ...legacy, source: { ...legacy.source, id: 'another-watch' } },
  ];
  for (const [i, corrected] of corrections.entries()) {
    store.ingest(batch(`enriched-${i}`, [parent]), `enriched-${i}`, now);
    const receipt = store.ingest(batch(`corrected-${i}`, [corrected]), `corrected-${i}`, now);
    assert.equal(receipt.accepted, 1);
    assert.equal(store.series(now).heart.length, 1);
    assert.equal(store.rawRecords()[0].payload.series, undefined);
    assert.equal(store.rawRecords()[0].payload.quantityCount, undefined);
  }
});
test('corrections replace derived facts and deletions survive restart', t => {
  const f = fixture(t); let store = f.open();
  store.ingest(batch('b1', [sample('HeartRate', 'h', 72)]), 'b1', now);
  assert.equal(store.ingest(batch('b2', [sample('HeartRate', 'h', 80)]), 'b2', now).accepted, 1);
  assert.equal(store.series(now).heart.length, 1); assert.equal(store.series(now).heart[0].value, 80);
  store.ingest(batch('b3', [{ op: 'delete', typeIdentifier: 'HKQuantityTypeIdentifierHeartRate', recordId: 'h' }]), 'b3', now);
  store.close(); store = f.open(); t.after(() => store.close());
  assert.equal(store.series(now).heart.length, 0); assert.equal(store.rawRecords().length, 0);
  assert.equal(store.status(now).recordCount, 0);
});
test('only marks publication committed after success and persists content deduplication', async t => {
  const f = fixture(t); let store = f.open();
  store.ingest(batch('b', [sample('HeartRate', 'h', 76)]), 'b', now);
  let tries = 0;
  const publish = async title => { tries++; assert.equal(title, '❔ 状态暂无｜🛏️ 睡眠暂无｜❤️ 心率76｜👣 今日步数暂无｜同步时间: 10/20 16:00｜详情 ↗'); if (tries === 1) throw Error('offline'); };
  await assert.rejects(store.publish(publish, now), /offline/);
  assert.equal(await store.publish(publish, now), true);
  store.close(); store = f.open(); t.after(() => store.close());
  assert.equal(await store.publish(publish, now), false); assert.equal(tries, 2);
});

test('sync time advances only on a new committed batch, never on a refresh or old batch replay', async t => {
  const store = fixture(t).open(); t.after(() => store.close());
  const record = sample('HeartRate', 'h', 76), body = batch('sync1', [record]);
  store.ingest(body, 'sync1', now);
  assert.match(store.status(now).title, /同步时间: 10\/20 16:00｜/);
  await store.publish(async () => {}, now);
  assert.equal(await store.publish(async () => assert.fail('A refresh alone must not republish'), now + 60000), false);
  store.ingest(body, 'sync1', now + 5 * 60000);
  assert.match(store.status(now + 5 * 60000).title, /同步时间: 10\/20 16:00｜/);
  store.ingest(batch('sync2', [record]), 'sync2', now + 5 * 60000);
  assert.match(store.status(now + 5 * 60000).title, /同步时间: 10\/20 16:05｜/);
});

test('publishes each pressure category with its scoring HRV and preserves it for retained results', async t => {
  const f = fixture(t), store = f.open(); t.after(() => store.close());
  const evidence = now - 30 * 60000;
  const window = (id, at, hrv, heart) => [
    ...[0, 10, 19].map(minute => sample('HeartRateVariabilityRMSSD', `v-${id}-${minute}`, hrv, 'ms', at-minute*60000)),
    ...Array.from({ length: 10 }, (_, minute) => sample('HeartRate', `h-${id}-${minute}`, heart, 'count/min', at-minute*60000)),
  ];
  const history = [1, 2, 3, 4, 5, 6, 7].flatMap(day => window(day, evidence-day*86400000, 50, 60));
  store.ingest(batch('history', history), 'history', now);
  for (const [id, hrv, heart, expected] of [
    ['relaxed', 70, 50, '🌟 状态优秀'], ['normal', 50, 60, '🌿 状态正常'],
    ['elevated', 42, 65, '⚡ 注意压力'], ['high', 20, 85, '🚨 压力过载'],
  ]) {
    store.ingest(batch(id, [...window('current', evidence, hrv, heart), sample('HeartRate', 'h-latest', 76)]), id, now);
    const status = store.status(now);
    assert.equal(status.title, `${expected}(恢复HRV ${hrv})｜🛏️ 睡眠暂无｜❤️ 心率76｜👣 今日步数暂无｜同步时间: 10/20 16:00｜详情 ↗`);
    assert.equal(status.indices.title, status.title);
    assert.equal(status.indices.features.hrv.current, hrv);
    let sent;
    await store.publish(async title => { sent = title; }, now);
    assert.equal(sent, status.title);
    assert.match(sent, new RegExp(`\\(恢复HRV ${hrv}\\)`));
  }
  const retained = store.status(now + 6 * 3600000);
  assert.match(retained.title, /^🚨 上次压力过载\(恢复HRV 20\)｜🛏️ 睡眠暂无｜❤️ 上次心率76/);
  assert.match(retained.title, /同步时间: 10\/20 16:00｜详情 ↗$/);
  await store.publish(async () => {}, now + 6 * 3600000);
  const restarted = f.open(); t.after(() => restarted.close());
  assert.match(restarted.status(now + 6 * 3600000 + 60000).title, /^🚨 上次压力过载\(恢复HRV 20\)｜/);
  assert.match(store.status(now + 8 * 86400000).title, /^❔ 状态暂无｜/);
});

test('publishes requested activity without inventing missing HRV', async t => {
  const store = fixture(t).open(); t.after(() => store.close());
  const w = sample('HKWorkoutType', 'workout', 0, undefined, now-3*3600000, now-2*3600000);
  w.payload = { durationSeconds: 1200 };
  store.ingest(batch('activity', [sample('HeartRate', 'h', 76), sample('StepCount', 's', 150, 'count'), w]), 'activity', now);
  let sent;
  await store.publish(async title => { sent = title; }, now);
  assert.equal(sent, '❔ 状态暂无｜🛏️ 睡眠暂无｜❤️ 心率76｜🪑 今日150步｜💪 今日锻炼20分｜同步时间: 10/20 16:00｜详情 ↗');
  assert.doesNotMatch(sent, /HRV/);
  assert.equal(store.status(now).activity.steps.value, 150);
});

test('workout live summaries expose actual heart evidence and are replaced without duplicate duration', t => {
  const store = fixture(t).open(); t.after(() => store.close());
  const live = sample('HKWorkoutType', 'live-workout', 0, undefined, now-20*60000, now-60000);
  live.payload = { durationSeconds: 600, activityType: 50, live: { version: 1, state: 'running',
    heartRate: { value: 110, unit: 'count/min', measuredAt: new Date(now-90000).toISOString() } } };
  store.ingest(batch('live', [live]), 'live', now);
  const current = store.status(now);
  assert.match(current.title, /💓 心率110/);
  assert.equal(current.activity.workouts.minutes, 10);
  store.ingest(batch('native-heart', [sample('HeartRate', 'native-h', 112, 'count/min', now-90000)]), 'native-heart', now);
  assert.match(store.status(now).title, /💓 心率112/, 'Native heart samples take precedence over derived workout summaries');
  const complete = { ...live, recordId: 'native-workout', payload: { durationSeconds: 660, activityType: 50 } };
  store.ingest(batch('final', [{ op: 'delete', typeIdentifier: 'HKWorkoutType', recordId: 'live-workout' }, complete]), 'final', now);
  assert.equal(store.status(now).activity.workouts.minutes, 11);
  assert.equal(store.rawRecords().length, 2);
  const bad = { ...live, payload: { ...live.payload, live: { ...live.payload.live,
    heartRate: { value: 110, unit: 'count/min', measuredAt: new Date(now+60000).toISOString() } } } };
  assert.throws(() => store.ingest(batch('future-heart', [bad]), 'future-heart', now), e => e.status === 422);
});

test('publishes the computed sleep category only on the sleep ending day', async t => {
  const store = fixture(t).open(); t.after(() => store.close());
  const records = [0, 1, 2, 3].map(day => sample('HKCategoryTypeIdentifierSleepAnalysis', `night-${day}`, 3,
    undefined, now - 16 * 3600000 - day * 86400000, now - 8 * 3600000 - day * 86400000));
  store.ingest(batch('sleep', records), 'sleep', now);
  const state = store.status(now);
  assert.equal(state.indices.sleep.score, 100); // Eight hours, regular bedtime, no recorded awake time.
  let sent;
  await store.publish(async title => { sent = title; }, now);
  assert.match(sent, /｜💤 睡眠优秀\(100分\)｜/);
  assert.match(store.status(now + 8 * 3600000).title, /｜🛏️ 睡眠暂无｜/); // Beijing midnight.
});
