import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeHealth } from './health-card.mjs';
import { emptyState, mergeSummary, overview, fingerprint } from './health-state.mjs';
const now = Date.parse('2026-09-24T02:00:00Z');
const metric = (name, qty, date = '2026-09-24', units = 'count') => ({ name, units, data: [{ date, qty }] });
const health = metrics => summarizeHealth({ data: { metrics } });
const context = { stream: 'health', aggregation: 'days', now };

test('independent streams merge, identical resends do not change visible content', async () => {
  let state = mergeSummary(emptyState(), health([metric('step_count', 1234)]), context);
  const sleep = health([{ name: 'sleep_analysis', units: 'hr', data: [{ date: '2026-09-24', totalSleep: 7 }] }]);
  state = mergeSummary(state, sleep, { ...context, stream: 'sleep' });
  const workouts = summarizeHealth({ data: { workouts: [{ id: 'one', name: 'Running', start: '2026-09-24T01:00:00Z', end: '2026-09-24T01:30:00Z', duration: 1800 }] } });
  state = mergeSummary(state, workouts, { ...context, stream: 'workouts' });
  const view = overview(state, now);
  assert.equal(view.metrics.length, 2);
  assert.equal(view.workouts.length, 1);
  const duplicate = mergeSummary(state, health([metric('step_count', 1234)]), { ...context, now: now + 1000 });
  assert.equal(await fingerprint(overview(duplicate, now)), await fingerprint(view));
});

test('late older-day uploads do not replace today; daily revisions replace without summing', () => {
  let state = mergeSummary(emptyState(), health([metric('step_count', 1000)]), context);
  state = mergeSummary(state, health([metric('step_count', 9000, '2026-09-23')]), context);
  assert.match(overview(state, now).metrics[0].latest.value, /1000/);
  state = mergeSummary(state, health([metric('step_count', 1500)]), context);
  assert.match(overview(state, now).metrics[0].latest.value, /1500/);
  state = mergeSummary(state, health([metric('step_count', 10, '2026-09-24T01:00:00Z')]), { ...context, aggregation: 'unknown', stream: 'legacy' });
  assert.match(overview(state, now).metrics[0].latest.value, /1500/);
});

test('daily contract rejects multiple windows for one metric/day and negative steps', () => {
  const summary = health([{ name: 'step_count', units: 'count', data: [
    { date: '2026-09-24T01:00:00Z', qty: 20 }, { date: '2026-09-24T02:00:00Z', qty: 30 },
  ] }]);
  assert.throws(() => mergeSummary(emptyState(), summary, context), /daily/);
  assert.throws(() => mergeSummary(emptyState(), health([metric('step_count', -1)]), context), /daily/);
});

test('daily validation identifies the failing metric and reason without exposing values', () => {
  const cases = [
    [health([metric('step_count', -1)]), 'negative_steps'],
    [health([metric('active_energy', 10), metric('active_energy', 20)]), 'multiple_records_per_day'],
  ];
  for (const [summary, reason] of cases) {
    assert.throws(() => mergeSummary(emptyState(), summary, context), error => {
      assert.equal(error.message, 'daily_aggregation_required');
      assert.deepEqual(error.details, { reason, metric: summary.metrics[0].name });
      return true;
    });
  }
});

test('sleep and workout revisions upsert and data older than seven calendar days expires', () => {
  let state = mergeSummary(emptyState(), health([metric('resting_heart_rate', 54, '2026-09-23', 'bpm')]), context);
  const initial = health([{ name: 'sleep_analysis', units: 'hr', data: [{ date: '2026-09-24', totalSleep: 6 }] }]);
  const revised = health([{ name: 'sleep_analysis', units: 'hr', data: [{ date: '2026-09-24', totalSleep: 7 }] }]);
  state = mergeSummary(state, initial, { ...context, stream: 'sleep' });
  state = mergeSummary(state, revised, { ...context, stream: 'sleep' });
  assert.match(overview(state, now).metrics.find(m => m.name === 'sleep_analysis').latest.value, /7 小时/);
  assert.equal(overview(state, now + 8 * 86400000).metrics.length, 0);
});

test('deduplication metadata stores a digest, not another copy of health values', async () => {
  const digest = await fingerprint({ metrics: [{ value: 'private-health-value' }] });
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(digest, /private-health/);
});

test('daily fractional steps preserve raw totals and display rounded steps alongside other metrics', () => {
  const state = mergeSummary(emptyState(), health([
    metric('step_count', 1234.56), metric('resting_heart_rate', 54, '2026-09-24', 'bpm'),
  ]), context);
  assert.equal(state.metrics.length, 2);
  const steps = state.metrics.find(m => m.name === 'step_count').latest;
  assert.equal(steps.rawValue, 1234.56);
  assert.equal(steps.value, '1235 步');
});
