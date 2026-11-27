import test from 'node:test';
import assert from 'node:assert/strict';
import { createBadgeCache, readBadgeCache } from './badge.mjs';

const now = Date.parse('2026-10-21T04:00:00Z');
const today = '2026-10-21';
const dto = () => ({
  generatedAt: now, dataUpdatedAt: now,
  healthIndices: {
    pressure: { score: 42.5, evidenceAt: now - 3600000, validUntil: now + 3600000, hrvMethod: 'RMSSD' },
    sleep: { score: 81.5, date: today, endAt: Date.parse('2026-10-21T00:00:00Z') },
  },
  heart: { latest: { v: 66.5, s: now - 60000 } },
  hrv: [{ t: now - 1000, v: 99 }],
  recoveryHrv: [{ t: now - 120000, v: 31.5 }, { t: now + 1000, v: 90 }],
  sleep: [
    { date: '2026-10-20', end: Date.parse('2026-10-20T00:00:00Z'), asleepMinutes: 440.5 },
    { date: today, end: Date.parse('2026-10-21T00:00:00Z'), asleepMinutes: 390.5 },
  ],
  daily: [{ date: today, metrics: {
    step_count: { v: 1234.5, unit: 'count' }, active_energy: { v: 460.5, unit: 'kcal' },
    apple_exercise_time: { v: 31.5, unit: 'min' }, walk_run_distance: { v: 3.6545, unit: 'km' },
  } }],
  pressureHistory: { days: [
    { date: '2026-10-15', median: 25, status: 'available' },
    { date: '2026-10-19', median: 44, status: 'insufficient' },
    { date: '2026-10-20', median: 40.5, status: 'available' },
    { date: today, median: 42, status: 'available' },
  ] },
});
const emptyNight = date => ({ date, total: null, deep: null, core: null, rem: null, awake: null, unknown: null });
const workout = overrides => ({ start: now - 3600000, end: now - 1800000,
  durationMs: 10.5 * 60000, activeEnergyKcal: 55.5, ...overrides });
const project = (source = dto(), workouts = [workout()]) => readBadgeCache(createBadgeCache(source, now, { workouts }), now);

test('V3 has exactly 26 bounded fields for today, with recorded short-workout duration and canonical activity units', () => {
  const result = project();
  assert.deepEqual(result, {
    v: 3, online: true, demo: false, asOf: '10/21 11:59', pressure: 43, retained: false,
    pressureAt: '10/21 11:00', heart: 67, heartAt: '10/21 11:59', hrv: 32,
    hrvMethod: 'RMSSD', hrvAt: '10/21 11:58', sleepScore: 82, sleepMinutes: 391,
    sleepDate: today, trend: [25, null, null, null, null, 41, 42], day: today,
    workoutCount: 1, workoutMinutes: 11, workoutKcal: 56,
    steps: 1235, activeKcal: 461, exerciseMinutes: 32, distanceMeters: 3655,
    workoutTypes: ['Other'], sleepWeek: [
      ...['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19'].map(emptyNight),
      { date: '2026-10-20', total: 441, deep: 0, core: 0, rem: 0, awake: null, unknown: 441 },
      { date: today, total: 391, deep: 0, core: 0, rem: 0, awake: null, unknown: 391 },
    ],
  });
  const serialized = JSON.stringify(result);
  assert.ok(serialized.length < 4096);
  assert.match(serialized, /^[\x00-\x7f]+$/);
  assert.equal(Object.keys(result).length, 26);
});

test('future or missing pressure evidence never becomes a displayed result', () => {
  for (const evidenceAt of [now + 1000, null]) {
    const source = dto(); source.healthIndices.pressure.evidenceAt = evidenceAt;
    const result = project(source);
    assert.equal(result.pressure, null); assert.equal(result.pressureAt, ''); assert.equal(result.retained, false);
  }
  const source = dto(); source.healthIndices.pressure.retained = true;
  assert.equal(project(source).pressure, 43, 'same-day recorded pressure stays visibly retained');
  assert.equal(project(source).retained, true);
});

test('today sleep duration never borrows a score from yesterday, or a duration from a different night', () => {
  const source = dto(); source.healthIndices.sleep.date = '2026-10-20';
  let result = project(source);
  assert.equal(result.sleepScore, null); assert.equal(result.sleepMinutes, 391); assert.equal(result.sleepDate, today);
  source.sleep = source.sleep.filter(row => row.date !== today);
  result = project(source);
  assert.equal(result.sleepScore, null); assert.equal(result.sleepMinutes, null); assert.equal(result.sleepDate, '');
  source.healthIndices.sleep.date = today;
  result = project(source);
  assert.equal(result.sleepScore, 82); assert.equal(result.sleepMinutes, null); assert.equal(result.sleepDate, today);
});

test('workouts aggregate by Beijing end day, include short records and exclude unfinished/future records', () => {
  const result = project(dto(), [workout(), workout({ start: Date.parse('2026-10-20T15:50:00Z'),
    end: Date.parse('2026-10-20T16:10:00Z'), durationMs: 15 * 60000, activeEnergyKcal: 99.4 }),
  workout({ start: now - 2 * 86400000, end: now - 86400000 }), workout({ end: now + 1000 })]);
  assert.equal(result.workoutCount, 2); assert.equal(result.workoutMinutes, 26); assert.equal(result.workoutKcal, 155);
});

test('workout domain absence stays unknown; known empty has zero recorded sessions; incomplete totals stay unknown', () => {
  const missing = readBadgeCache(createBadgeCache(dto(), now), now);
  assert.equal(missing.workoutCount, null); assert.equal(missing.workoutMinutes, null); assert.equal(missing.workoutKcal, null);
  const empty = project(dto(), []);
  assert.equal(empty.workoutCount, 0); assert.equal(empty.workoutMinutes, 0); assert.equal(empty.workoutKcal, 0);
  const incomplete = project(dto(), [workout(), workout({ durationMs: undefined, activeEnergyKcal: null })]);
  assert.equal(incomplete.workoutCount, 2); assert.equal(incomplete.workoutMinutes, null); assert.equal(incomplete.workoutKcal, null);
});

test('workout duration sums milliseconds before conversion at the daily upper bound', () => {
  const result = project(dto(), Array.from({ length: 100 }, () => workout({ durationMs: 864000, activeEnergyKcal: 100 })));
  assert.equal(result.workoutCount, 100); assert.equal(result.workoutMinutes, 1440); assert.equal(result.workoutKcal, 10000);
});

test('completed sleep duration remains visible without a score, while future sleep evidence is excluded', () => {
  const source = dto(); source.healthIndices.sleep.score = null;
  source.sleep[1].reason = 'insufficient_baseline';
  assert.equal(project(source).sleepMinutes, 391);
  source.sleep[1].end = now + 1000;
  source.healthIndices.sleep.endAt = now + 1000;
  source.healthIndices.sleep.score = 80;
  const result = project(source);
  assert.equal(result.sleepMinutes, null); assert.equal(result.sleepScore, null); assert.equal(result.sleepDate, '');
});

test('activity normalizes supported units and does not turn missing, conflicts or invalid values into zero', () => {
  const source = dto(), metrics = source.daily[0].metrics;
  metrics.active_energy = { v: 418.4, unit: 'kJ' };
  metrics.apple_exercise_time = { v: 120, unit: 's' };
  metrics.walk_run_distance = { v: 1, unit: 'mi' };
  let result = project(source);
  assert.equal(result.activeKcal, 100); assert.equal(result.exerciseMinutes, 2); assert.equal(result.distanceMeters, 1609);
  for (const metric of Object.values(metrics)) metric.conflict = true;
  result = project(source);
  assert.equal(result.steps, null); assert.equal(result.activeKcal, null);
  assert.equal(result.exerciseMinutes, null); assert.equal(result.distanceMeters, null);
  delete source.daily;
  assert.equal(project(source).steps, null);
});

test('reason flags, unsupported units, bounds and other dates never become current activity', () => {
  const source = dto(), metrics = source.daily[0].metrics;
  metrics.step_count.reason = 'source_conflict'; metrics.active_energy.unit = 'unknown';
  metrics.apple_exercise_time.v = true; metrics.walk_run_distance.v = 2001;
  let result = project(source);
  for (const key of ['steps', 'activeKcal', 'exerciseMinutes', 'distanceMeters']) assert.equal(result[key], null);
  source.daily[0].date = '2026-10-20';
  assert.equal(project(source).steps, null);
});

test('cached pressure expires visibly and midnight clears only today fields without mutating saved facts or inventing asOf', () => {
  const cache = createBadgeCache(dto(), now, { workouts: [workout()] });
  const before = readBadgeCache(cache, now), expired = readBadgeCache(cache, now + 3600000);
  assert.equal(expired.retained, true); assert.equal(expired.pressureAt, before.pressureAt);
  const nextDay = readBadgeCache(cache, Date.parse('2026-10-21T16:00:00Z'));
  assert.equal(nextDay.day, '2026-10-22');
  for (const key of ['sleepScore', 'sleepMinutes', 'workoutCount', 'workoutMinutes', 'workoutKcal',
    'steps', 'activeKcal', 'exerciseMinutes', 'distanceMeters']) assert.equal(nextDay[key], null, key);
  assert.equal(nextDay.pressure, before.pressure); assert.equal(nextDay.pressureAt, before.pressureAt);
  assert.equal(nextDay.sleepDate, ''); assert.equal(nextDay.retained, true); assert.deepEqual(nextDay.workoutTypes, []);
  assert.deepEqual(nextDay.sleepWeek, [...before.sleepWeek.slice(1), emptyNight('2026-10-22')]);
  assert.equal(nextDay.heart, before.heart); assert.equal(nextDay.heartAt, before.heartAt);
  assert.equal(nextDay.hrvAt, before.hrvAt); assert.equal(nextDay.asOf, before.asOf);
  assert.deepEqual(nextDay.trend, [null, null, null, null, 41, 42, null]);
  assert.deepEqual(readBadgeCache(cache, now), before, 'GET must not mutate cached data');
  assert.deepEqual(readBadgeCache(cache, now + 8 * 86400000).trend, Array(7).fill(null));
  assert.equal(readBadgeCache({ ...cache, version: 1 }, now), null, 'old cache must wait for a fresh V2 projection');
});

test('SDNN never receives RMSSD values and unrecognized HRV methods do not produce a metric', () => {
  const source = dto(); source.healthIndices.pressure.hrvMethod = 'SDNN';
  const sdnn = project(source); assert.equal(sdnn.hrv, 99); assert.equal(sdnn.hrvMethod, 'SDNN');
  source.healthIndices.pressure.hrvMethod = 'unexpected'; assert.equal(project(source).hrv, null);
});

test('invalid metrics and conflicted sleep remain unknown instead of selecting another night', () => {
  const source = dto(); source.healthIndices.pressure.score = true; source.healthIndices.sleep.score = Infinity;
  source.sleep[1].conflict = true; source.heart.latest.v = 301;
  const result = project(source);
  assert.equal(result.pressure, null); assert.equal(result.retained, false); assert.equal(result.heart, null);
  assert.equal(result.sleepScore, null); assert.equal(result.sleepMinutes, null); assert.equal(result.sleepDate, '');
});


test('latest pressure uses only the dashboard-selected result across days, never trend or raw history alternatives', () => {
  const source = dto();
  source.healthIndices.pressure = { score: 73, evidenceAt: now - 17 * 3600000 - 40 * 60000,
    retained: true, validUntil: null, hrvMethod: 'RMSSD', trend: { lastValid: { score: 17, at: now - 150 * 60000 } } };
  source.healthIndices.lastValidPressure = { score: 17, evidenceAt: now - 150 * 60000 };
  source.pressureHistory.points = [{ score: 17, t: now - 150 * 60000 }];
  let result = project(source);
  assert.equal(result.pressure, 73); assert.equal(result.pressureAt, '10/20 18:20'); assert.equal(result.retained, true);
  source.healthIndices.pressure.score = null;
  result = project(source);
  assert.equal(result.pressure, null); assert.equal(result.pressureAt, ''); assert.equal(result.retained, false);
});

test('cross-day and expired pressure always retains its original measurement label', () => {
  const source = dto(); source.healthIndices.pressure.evidenceAt = now - 86400000;
  source.healthIndices.pressure.retained = false;
  assert.equal(project(source).pressure, 43); assert.equal(project(source).retained, true);
  assert.equal(project(source).pressureAt, '10/20 12:00');
  source.healthIndices.pressure.evidenceAt = now - 3600000;
  source.healthIndices.pressure.validUntil = now;
  assert.equal(project(source).retained, true);
});

test('sleep week keeps generic sleep unknown, wake separate, and integer stage totals consistent', () => {
  const source = dto();
  source.sleep[1] = { date: today, end: now - 3600000, asleepMinutes: 390.5, awakeMinutes: 25.5,
    stages: { deep: 70.4, core: 250.4, rem: 40.2, asleep: 29.5 } };
  const night = project(source).sleepWeek.at(-1);
  assert.equal(night.total, 391); assert.equal(night.awake, 26);
  assert.equal(night.deep + night.core + night.rem + night.unknown, night.total);
  assert.equal(night.deep, 70); assert.equal(night.core, 251); assert.equal(night.rem, 40); assert.equal(night.unknown, 30);
  source.sleep[1].stages = { asleep: 390.5 };
  assert.deepEqual(project(source).sleepWeek.at(-1), { date: today, total: 391, deep: 0, core: 0,
    rem: 0, awake: 26, unknown: 391 });
});

test('missing, duplicate, conflicting, future and inconsistent nights stay wholly unknown', () => {
  const source = dto(), original = source.sleep[1];
  for (const changed of [{ ...original, conflict: true }, { ...original, end: now + 1000 },
    { ...original, asleepMinutes: -1 }, { ...original, stages: { deep: 500 } },
    { ...original, stages: { core: false } }, { ...original, asleepMinutes: 1440, awakeMinutes: 1 }]) {
    source.sleep = [changed]; assert.deepEqual(project(source).sleepWeek.at(-1), emptyNight(today));
  }
  source.sleep = [original, original]; assert.deepEqual(project(source).sleepWeek.at(-1), emptyNight(today));
  source.sleep = []; assert.deepEqual(project(source).sleepWeek, Array.from({ length: 7 }, (_, i) =>
    emptyNight(new Date(now + 8 * 3600000 - (6 - i) * 86400000).toISOString().slice(0, 10))));
});

test('workout types conservatively normalize names, ignore unfinished records and bound distinct labels', () => {
  const names = ['Running', '跑步', '泳池 游泳', '足球', 'Cycling', 'Walking', 'Hiking', 'Yoga', 'Pilates', 'Basketball'];
  const result = project(dto(), names.map(name => workout({ name })));
  assert.deepEqual(result.workoutTypes, ['Running', 'Swimming', 'Football', 'Cycling', 'Walking', 'Hiking', 'Yoga', 'More']);
  assert.deepEqual(project(dto(), [workout({ name: 'Swimming' }), workout({ name: 'private \u0001运动' }),
    workout({ name: 'Running', end: now + 1000 })]).workoutTypes, ['Swimming', 'Other']);
  assert.deepEqual(project(dto(), []).workoutTypes, []);
  assert.ok(result.workoutTypes.every(label => /^[\x20-\x7e]{1,24}$/.test(label)));
});

test('legacy v2 caches retain their original 24-field and midnight behavior without mutation', () => {
  const cache = createBadgeCache(dto(), now, { workouts: [workout()] });
  const { sleepWeek, workoutTypes, ...payload } = cache.payload;
  const legacy = { ...cache, version: 2, payload: { ...payload, v: 2 } }, copy = structuredClone(legacy);
  const current = readBadgeCache(legacy, now);
  assert.equal(current.v, 2); assert.equal(Object.keys(current).length, 24);
  const next = readBadgeCache(legacy, now + 86400000);
  assert.equal(next.pressure, null); assert.equal(next.pressureAt, ''); assert.equal(next.retained, false);
  assert.deepEqual(legacy, copy);
});


test('maximum-sized valid V3 packet remains ASCII below the device buffer and all weekly segments sum exactly', () => {
  const source = dto();
  source.sleep = Array.from({ length: 7 }, (_, i) => ({
    date: new Date(now + 8 * 3600000 - (6 - i) * 86400000).toISOString().slice(0, 10),
    end: now - (6 - i) * 86400000 - 3600000, asleepMinutes: 1439.4, awakeMinutes: .6,
    stages: { deep: 479.8, core: 479.8, rem: 479.8 },
  }));
  const cache = createBadgeCache(source, now, { workouts: ['Running', 'Walking', 'Cycling', 'Swimming', 'Football', 'Strength', 'Table Tennis', 'Basketball']
    .map(name => workout({ name })) });
  assert.equal(cache.version, 3); assert.equal(Object.keys(cache).length, 4);
  const text = JSON.stringify(readBadgeCache(cache, now));
  assert.match(text, /^[\x20-\x7e]+$/); assert.ok(text.length < 4094);
  for (const night of cache.payload.sleepWeek) {
    assert.equal(night.deep + night.core + night.rem + night.unknown, night.total);
  }
  const before = structuredClone(cache);
  readBadgeCache(cache, now).workoutTypes.push('Other');
  assert.deepEqual(cache, before, 'returned type labels must not mutate cached facts');
  const moved = readBadgeCache(cache, now + 8 * 86400000);
  assert.equal(moved.sleepWeek.length, 7); assert.ok(moved.sleepWeek.every(night => night.total === null));
  moved.sleepWeek[0].total = 7;
  assert.deepEqual(cache, before, 'returning weekly rows must not allow callers to mutate cached facts');
});
