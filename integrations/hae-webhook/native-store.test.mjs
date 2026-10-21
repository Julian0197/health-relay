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
  assert.equal(state.title, '⌚ 状态数据积累中｜🌙 睡眠暂无｜❤️ 心率76｜🪑 今日150步｜同步时间: 10/20 16:00｜详情 ↗');
  assert.doesNotMatch(state.title, /HRV|69/);
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
  const publish = async title => { tries++; assert.equal(title, '⚪ 状态暂无｜🌙 睡眠暂无｜❤️ 心率76｜👣 今日步数暂无｜同步时间: 10/20 16:00｜详情 ↗'); if (tries === 1) throw Error('offline'); };
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
  const history = [1, 2, 3].flatMap(day => [
    sample('HeartRateVariabilitySDNN', `v-${day}`, 50, 'ms', evidence-day*86400000),
    sample('HeartRate', `h-${day}`, 60, 'count/min', evidence-day*86400000),
  ]);
  store.ingest(batch('history', history), 'history', now);
  for (const [id, hrv, heart, expected] of [
    ['relaxed', 70, 50, '😌 状态优秀'], ['normal', 50, 60, '🙂 状态正常'],
    ['elevated', 42, 65, '😮‍💨 注意压力'], ['high', 20, 85, '😵‍💫 压力过载'],
  ]) {
    store.ingest(batch(id, [sample('HeartRateVariabilitySDNN', 'v-current', hrv, 'ms', evidence),
      sample('HeartRate', 'h-current', heart, 'count/min', evidence), sample('HeartRate', 'h-latest', 76)]), id, now);
    const status = store.status(now);
    assert.equal(status.title, `${expected}(HRV ${hrv})｜🌙 睡眠暂无｜❤️ 心率76｜👣 今日步数暂无｜同步时间: 10/20 16:00｜详情 ↗`);
    assert.equal(status.indices.title, status.title);
    assert.equal(status.indices.features.hrv.current, hrv);
    let sent;
    await store.publish(async title => { sent = title; }, now);
    assert.equal(sent, status.title);
    assert.match(sent, new RegExp(`\\(HRV ${hrv}\\)`));
  }
  const retained = store.status(now + 6 * 3600000);
  assert.match(retained.title, /^😵‍💫 上次压力过载\(HRV 20\)｜🌙 睡眠暂无｜❤️ 上次心率76/);
  assert.match(retained.title, /同步时间: 10\/20 16:00｜详情 ↗$/);
  await store.publish(async () => {}, now + 6 * 3600000);
  const restarted = f.open(); t.after(() => restarted.close());
  assert.match(restarted.status(now + 6 * 3600000 + 60000).title, /^😵‍💫 上次压力过载\(HRV 20\)｜/);
  assert.match(store.status(now + 8 * 86400000).title, /^⚪ 状态暂无｜/);
});

test('publishes requested activity without inventing missing HRV', async t => {
  const store = fixture(t).open(); t.after(() => store.close());
  const w = sample('HKWorkoutType', 'workout', 0, undefined, now-3*3600000, now-2*3600000);
  w.payload = { durationSeconds: 1200 };
  store.ingest(batch('activity', [sample('HeartRate', 'h', 76), sample('StepCount', 's', 150, 'count'), w]), 'activity', now);
  let sent;
  await store.publish(async title => { sent = title; }, now);
  assert.equal(sent, '⚪ 状态暂无｜🌙 睡眠暂无｜❤️ 心率76｜🪑 今日150步｜💪 今日锻炼20分｜同步时间: 10/20 16:00｜详情 ↗');
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
  assert.match(sent, /｜😴 睡眠优秀\(100分\)｜/);
  assert.match(store.status(now + 8 * 3600000).title, /｜🌙 睡眠暂无｜/); // Beijing midnight.
});
