import test from 'node:test';
import assert from 'node:assert/strict';
import { sleepSessions, analyze } from './analysis.mjs';
const HOUR = 3600000, DAY = 24 * HOUR, now = Date.parse('2026-09-24T03:30:00Z');
const sample = (start, value = 50, source = 'Watch') => ({ kind: 'hrv', start, end: start, value, method: 'SDNN', source });
const segment = (start, end, stage = 'core', source = 'Watch') => ({ kind: 'sleep', start, end, stage, source });
const empty = () => ({ hrv: [], heart: [], sleep: [], daily: [], workout: [] });

test('sleep interval union excludes awake/in-bed and double counted general sleep', () => {
  const start = now - 12 * HOUR;
  const [s] = sleepSessions([segment(start, start + 8 * HOUR, 'in_bed'), segment(start, start + 8 * HOUR, 'asleep'),
    segment(start, start + 7 * HOUR), segment(start + 7 * HOUR, start + 8 * HOUR, 'awake')]);
  assert.equal(s.asleepMinutes, 420); assert.equal(s.awakeMinutes, 60); assert.equal(s.conflict, false);
});
test('cross-midnight main sleep and later nap are separate; overlapping sources block analysis', () => {
  const mainStart = Date.parse('2026-09-23T15:00:00Z');
  const sessions = sleepSessions([segment(mainStart, mainStart + 8 * HOUR), segment(mainStart + 14 * HOUR, mainStart + 15 * HOUR)]);
  assert.equal(sessions.length, 2); assert.equal(sessions.filter(s => s.main).length, 1);
  const [conflict] = sleepSessions([segment(mainStart, mainStart + 8 * HOUR), segment(mainStart, mainStart + 8 * HOUR, 'deep', 'Phone')]);
  assert.equal(conflict.conflict, true);
});
test('14 prior distinct comparable days establish median and IQR, samples from today are excluded', () => {
  const input = empty(); input.hrv = [sample(now, 30), ...Array.from({ length: 14 }, (_, i) => sample(now - (i + 1) * DAY, 50 + i % 3))];
  const result = analyze(input, now).daytime;
  assert.equal(result.status, 'comparable'); assert.equal(result.baseline.days, 14); assert.equal(result.baseline.median, 51);
  assert.equal(result.position, 'below_usual'); assert.ok(result.changePercent < 0);
});
test('many same-day samples cannot satisfy baseline; stale and exercise contexts do not produce state', () => {
  const input = empty(); input.hrv = [sample(now), ...Array.from({ length: 30 }, (_, i) => sample(now - DAY + i * 1000))];
  assert.equal(analyze(input, now).daytime.status, 'baseline_building');
  assert.equal(analyze(input, now + 7 * HOUR).daytime.status, 'stale');
  input.workout = [{ start: now - HOUR, end: now + HOUR }];
  assert.equal(analyze(input, now).daytime.status, 'exercise_context');
});
test('constant baseline is descriptive, never divides by zero or manufactures a stress score', () => {
  const input = empty(); input.hrv = [sample(now), ...Array.from({ length: 14 }, (_, i) => sample(now - (i + 1) * DAY))];
  const result = analyze(input, now);
  assert.equal(result.daytime.position, 'flat_baseline'); assert.equal(result.daytime.changePercent, 0);
  assert.doesNotMatch(JSON.stringify(result), /NaN|Infinity|stressScore/);
});
test('night HRV only uses asleep intervals and cannot substitute daily resting heart rate for sleep heart rate', () => {
  const input = empty(); const start = now - 12 * HOUR, end = now - 4 * HOUR;
  input.sleep = [segment(start, end)]; input.hrv = [sample(start + HOUR, 70), sample(now, 20)];
  input.heart = [{ start: start + HOUR, value: 55, source: 'Watch' }];
  input.daily = [{ metric: 'resting_heart_rate', start: end, value: 61, source: 'Watch' }];
  const result = analyze(input, now);
  assert.equal(result.nightly.current, 70); assert.equal(result.nightly.heartMedian, 55); assert.equal(result.resting.current, 61);
});

test('old resting records and conflicting same-day sources cannot report a current comparison', () => {
  const input = empty();
  input.daily = [{ metric: 'resting_heart_rate', start: now - 4 * DAY, value: 60, source: 'Watch' }];
  assert.equal(analyze(input, now).resting.status, 'stale');
  input.daily = [{ metric: 'resting_heart_rate', start: now, value: 60, source: 'Watch' },
    { metric: 'resting_heart_rate', start: now, value: 70, source: 'Phone' }];
  assert.equal(analyze(input, now).resting.status, 'source_conflict');
});
test('in-bed only does not become a zero-hour main sleep; awake-specific overlap is uncertain', () => {
  assert.equal(sleepSessions([segment(now - HOUR, now, 'in_bed')]).length, 0);
  assert.equal(sleepSessions([segment(now - HOUR, now), segment(now - HOUR, now, 'awake')])[0].conflict, true);
});

test('baseline uses full prior calendar days including the earliest morning', () => {
  const input = empty();
  input.hrv = [sample(now), sample(now - 30 * DAY - HOUR)];
  assert.equal(analyze(input, now).daytime.baseline.days, 1);
});

test('same-source segment boundary correction without ID is flagged, never claimed as precise sleep', () => {
  const input = empty();
  input.sleep = [segment(now - 10 * HOUR, now - 2 * HOUR), segment(now - 10 * HOUR, now - 3 * HOUR)];
  const result = analyze(input, now);
  assert.equal(result.sleep[0].conflict, true); assert.equal(result.nightly.status, 'source_conflict');
});
