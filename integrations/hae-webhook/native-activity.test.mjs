import test from 'node:test';
import assert from 'node:assert/strict';
import * as activity from './native-activity.mjs';

const now = Date.parse('2026-10-20T08:00:00Z'), minute = 60000;
const at = offset => new Date(now + offset * minute).toISOString();
const step = (id, value, source, start = -60, end = -59) => ({ op: 'upsert', recordId: id,
  typeIdentifier: 'HKQuantityTypeIdentifierStepCount', source, start: at(start), end: at(end), payload: { value, unit: 'count' } });
const workout = (id, start, end, seconds) => ({ op: 'upsert', recordId: id, typeIdentifier: 'HKWorkoutType',
  source: { id: 'watch' }, start: at(start), end: at(end), payload: { durationSeconds: seconds } });
const watch = { id: 'watch', device: 'Watch' }, phone = { id: 'phone', device: 'iPhone' };
const summarize = rows => activity.summarizeNativeActivity(rows, now);

test('uses one clearly labeled current step source rather than adding overlapping phone and watch counts', () => {
  assert.equal(typeof activity.summarizeNativeActivity, 'function');
  const rows = [step('w1', 1000, watch), step('w2', 500, watch, -30, -29), step('p', 1200, phone),
    step('yesterday', 9999, watch, -1100, -1099), step('future', 9000, watch, 1, 2)];
  const result = summarize(rows);
  assert.equal(result.steps.value, 1500);
  assert.equal(result.steps.label, '手表今日');
  assert.equal(result.steps.measuredAt, Date.parse(at(-29)));
  assert.equal(result.workouts.minutes, null);
});
test('keeps missing steps unknown and falls back to one phone when watch data is absent', () => {
  assert.equal(summarize([]).steps.value, null);
  const result = summarize([step('p', 0, phone)]);
  assert.equal(result.steps.value, 0); assert.equal(result.steps.label, '手机今日');
});
test('totals actual workout duration excluding pauses and exact duplicate imports', () => {
  const result = summarize([workout('a', -120, -90, 1200), workout('duplicate', -120, -90, 1200),
    workout('b', -60, -40, 900), workout('yesterday', -1100, -1000, 6000)]);
  assert.equal(result.workouts.minutes, 35);
  assert.equal(result.workouts.durationSeconds, 2100);
});
test('withholds ambiguous overlapping or cross-midnight workout totals', () => {
  assert.equal(summarize([workout('a', -120, -90, 1200), workout('b', -100, -60, 2000)]).workouts.minutes, null);
  // Today starts 960 minutes before the 16:00 Beijing test clock.
  assert.equal(summarize([workout('midnight', -970, -950, 900)]).workouts.minutes, null);
  assert.equal(summarize([workout('invalid', -30, -10, 9000)]).workouts.minutes, null);
});
