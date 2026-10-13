import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePhysiology, neutralPhysiology, withLatestHeartOverview } from './physiology.mjs';

const HOUR = 3600000, DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-27T12:00:00+08:00');
const midnight = NOW - 12 * HOUR;
const sample = (kind, start, value) => ({ kind, start, end: start, value, source: 'Watch', key: `${kind}:${start}`,
  ...(kind === 'hrv' ? { method: 'SDNN' } : { metric: 'resting_heart_rate' }) });
function fixture(days = 18, hrv = 60, rhr = 55) {
  const s = { hrv: [], heart: [], daily: [], sleep: [], workout: [] };
  for (let d = 1; d <= days; d++) {
    for (const hour of [2, 1]) s.hrv.push(sample('hrv', NOW - d * DAY - hour * HOUR, 60 + (d % 3 - 1) * 3));
    s.daily.push(sample('daily', midnight - d * DAY, 55 + d % 3 - 1));
  }
  s.hrv.push(sample('hrv', NOW - 2 * HOUR, hrv), sample('hrv', NOW - HOUR, hrv));
  s.daily.push(sample('daily', midnight, rhr));
  return s;
}

test('personal comparable HRV and RHR produce a dated state rather than a data summary', () => {
  const out = evaluatePhysiology(fixture(), NOW);
  assert.equal(out.state, 'balanced');
  assert.match(out.title, /🔵 状态正常/);
  assert.match(out.title, /09\/27/);
  assert.doesNotMatch(out.title, /ms|已同步/);
  assert.equal(out.features.hrv.baselineDays, 18);
  assert.equal(out.features.resting.baselineDays, 18);
  assert.ok(out.validUntil > NOW);
});
test('single metric deviation is a fluctuation, two supported readings require new confirmation', () => {
  assert.equal(evaluatePhysiology(fixture(18, 35, 55), NOW).state, 'tense');
  const s = fixture(18, 35, 65);
  const first = evaluatePhysiology(s, NOW);
  assert.equal(first.state, 'tense');
  assert.equal(first.candidate, 'high');
  const duplicate = evaluatePhysiology(s, NOW + HOUR / 2, first);
  assert.equal(duplicate.state, 'tense');
  s.hrv.push(sample('hrv', NOW + HOUR / 2, 35));
  const second = evaluatePhysiology(s, NOW + HOUR / 2, duplicate);
  assert.equal(second.state, 'high');
  assert.match(second.title, /🔴 压力过载/);
});
test('new normal measurement cannot confirm a low median held down by older points', () => {
  const s = fixture(18, 35, 65), first = evaluatePhysiology(s, NOW);
  s.hrv.push(sample('hrv', NOW + HOUR / 2, 60));
  assert.notEqual(evaluatePhysiology(s, NOW + HOUR / 2, first).state, 'high');
});
test('ordinary high heart rate is not a second pressure vote', () => {
  const s = fixture(18, 35, 55);
  s.heart.push(sample('heart', NOW, 140));
  const out = evaluatePhysiology(s, NOW);
  assert.equal(out.state, 'tense');
  assert.notEqual(out.candidate, 'high');
});
test('single latest HRV can be compared but missing history, same-day RHR or variation still blocks a tier', () => {
  assert.equal(evaluatePhysiology(fixture(2), NOW).state, 'learning');
  const single = fixture(); single.hrv = single.hrv.filter(r => r.start !== NOW - 2 * HOUR);
  assert.equal(evaluatePhysiology(single, NOW).state, 'balanced');
  const oldRest = fixture(); oldRest.daily.pop();
  assert.equal(evaluatePhysiology(oldRest, NOW).state, 'insufficient');
  const flat = fixture(); flat.hrv.forEach(r => { r.value = 60; });
  assert.equal(evaluatePhysiology(flat, NOW).state, 'insufficient');
});
test('stale HRV cannot be renewed by steps or fresh heart readings', () => {
  const s = fixture(), first = evaluatePhysiology(s, NOW);
  s.heart.push(sample('heart', NOW + 7 * HOUR, 70));
  s.daily.push({ ...sample('daily', midnight, 10000), metric: 'step_count' });
  const out = evaluatePhysiology(s, NOW + 7 * HOUR, first);
  assert.equal(out.state, 'stale');
  assert.ok(out.validUntil === null || out.validUntil <= NOW + 7 * HOUR);
  assert.equal(out.title, null);
});
test('sleep and exercise samples do not become daytime physiology; unknown sources fail closed', () => {
  const s = fixture();
  s.sleep.push({ start: NOW - 3 * HOUR, end: NOW - HOUR / 2, stage: 'core', source: 'Watch' });
  assert.equal(evaluatePhysiology(s, NOW).state, 'stale');
  assert.equal(evaluatePhysiology(s, NOW).title, null);
  const active = fixture(); active.workout.push({ start: NOW - HOUR, end: NOW - HOUR / 2 });
  assert.equal(evaluatePhysiology(active, NOW).state, 'post_workout');
  const unknown = fixture(); unknown.hrv.forEach(r => { r.source = 'unknown'; });
  assert.equal(evaluatePhysiology(unknown, NOW).state, 'insufficient');
});
test('revisions are not new measurements', () => {
  const s = fixture(18, 35, 65), first = evaluatePhysiology(s, NOW);
  s.hrv[s.hrv.length - 1].value = 34;
  assert.notEqual(evaluatePhysiology(s, NOW + HOUR / 2, first).state, 'high');
});

test('a previous sustained state needs new observations to return to steady', () => {
  const s = fixture();
  const previous = { ...evaluatePhysiology(s, NOW), state: 'high' };
  const waiting = evaluatePhysiology(s, NOW, previous);
  assert.equal(waiting.state, 'insufficient');
  assert.equal(evaluatePhysiology(s, NOW, waiting).state, 'insufficient');
  s.hrv.push(sample('hrv', NOW, 60));
  assert.equal(evaluatePhysiology(s, NOW, previous).state, 'balanced');
});
test('unknown and expired data do not claim sleep, calm or stress', () => {
  const out = evaluatePhysiology({ hrv: [], heart: [], daily: [], sleep: [], workout: [] }, midnight);
  assert.equal(out.state, 'insufficient');
  assert.equal(out.title, null);
});

test('3 comparable days start provisional mode; 14 days automatically mature', () => {
  const short = evaluatePhysiology(fixture(3), NOW);
  assert.equal(short.state, 'balanced');
  assert.equal(short.baselinePhase, 'provisional');
  assert.equal(evaluatePhysiology(fixture(14), NOW).baselinePhase, 'established');
});
test('relaxed requires both favorable signals; high HRV alone is not relaxed', () => {
  assert.equal(evaluatePhysiology(fixture(18, 78, 50), NOW).state, 'relaxed');
  assert.equal(evaluatePhysiology(fixture(18, 78, 55), NOW).state, 'balanced');
  assert.equal(evaluatePhysiology(fixture(18, 78, 65), NOW).state, 'tense');
});
test('unchanged measurements keep the same comparison window and title', () => {
  const s = fixture(), a = evaluatePhysiology(s, NOW), b = evaluatePhysiology(s, NOW + 4 * HOUR, a);
  assert.equal(b.title, a.title);
  assert.deepEqual(b.features, a.features);
});

test('sparse history remains opt-in while a single current sample is allowed', () => {
  const s = fixture(5);
  s.hrv = s.hrv.filter(r => r.start >= midnight || (NOW - r.start) % DAY === HOUR);
  const strict = evaluatePhysiology(s, NOW);
  assert.equal(strict.state, 'learning');
  assert.equal(strict.features.hrv.historyCoverage.length, 5);
  const trial = evaluatePhysiology(s, NOW, null, { minimumHistorySamples: 1 });
  assert.equal(trial.state, 'balanced');
  assert.equal(trial.features.hrv.baselineDays, 5);
  s.hrv = s.hrv.filter(r => r.start !== NOW - 2 * HOUR);
  assert.equal(evaluatePhysiology(s, NOW, null, { minimumHistorySamples: 1 }).state, 'balanced');
});

test('current observation diagnostics remain visible even when workout blocks classification', () => {
  const s = fixture(); s.workout.push({ start: NOW - HOUR / 2, end: NOW - HOUR / 4 });
  const out = evaluatePhysiology(s, NOW);
  assert.equal(out.state, 'post_workout');
  assert.equal(out.observation.latestSampleAt, NOW - HOUR);
  assert.equal(out.observation.windowSamples, 2);
  assert.equal(out.observation.recentSamples.at(-1).time, NOW - HOUR);
});

test('delayed upload across midnight pairs resting HR with the HRV observation day', () => {
  const s = fixture();
  // Move the same observations to 22:00 / 23:00; daily rows remain on their original days.
  for (const row of s.hrv) { row.start += 12 * HOUR; row.end += 12 * HOUR; }
  const before = evaluatePhysiology(s, NOW + 11.5 * HOUR);
  const after = evaluatePhysiology(s, NOW + 12.5 * HOUR);
  assert.equal(before.state, 'balanced');
  assert.equal(after.state, 'balanced');
  assert.equal(after.title, before.title);
  assert.deepEqual(after.features, before.features);
  assert.equal(after.features.resting.date, '2026-09-27');
  assert.equal(after.validUntil, before.validUntil);
  assert.equal(evaluatePhysiology(s, NOW + 17 * HOUR).state, 'stale');
  // A genuinely new HRV day must not borrow yesterday's daily resting HR.
  s.hrv.push(sample('hrv', NOW + 12.5 * HOUR, 60));
  assert.equal(evaluatePhysiology(s, NOW + 12.5 * HOUR).state, 'insufficient');
});


test('a sample can still be described when strict historical windows lack coverage', () => {
  const s = fixture(5, 60); s.hrv.pop();
  const observed = neutralPhysiology(s, NOW);
  assert.equal(evaluatePhysiology(s, NOW).state, 'learning');
  assert.deepEqual(evaluatePhysiology(s, NOW).reasons, ['baseline_building']);
  assert.equal(observed.state, 'neutral');
  assert.equal(observed.presentation, 'hrv_comparison');
  assert.equal(observed.hrvComparison.position, 'usual');
  assert.equal(observed.hrvComparison.baselineDays, 5);
  assert.equal(observed.hrvComparison.baseline, 60);
  assert.match(observed.title, /^\S+ 近常态｜.+\nHRV 60/);
  assert.equal(typeof observed.copy.phrase, 'string');
  assert.ok(observed.title.includes(observed.copy.shortPhrase));
  assert.doesNotMatch(observed.title, /状态优秀|状态正常|注意压力|压力过载|测于|数据不足/);
  assert.equal(neutralPhysiology(s, NOW + 8 * HOUR).title, observed.title);
  assert.equal(observed.measuredAt, s.hrv.at(-1).start);
});

test('overview time advances with latest heart but preserves the HRV evidence time', () => {
  const s = fixture(5, 40); s.hrv.pop(); s.daily = [];
  const anchor = s.hrv.at(-1).start;
  s.heart.push(sample('heart', anchor - 60000, 72.4), sample('heart', NOW - 60000, 90));
  const out = neutralPhysiology(s, NOW);
  assert.match(out.title, /^\S+ 偏低｜.+\nHRV 40↓ · HR 90｜09\/27 11:59$/);
  assert.equal(out.title.match(/\d{2}:\d{2}/g).length, 1);
  assert.equal((out.title.match(/HRV/g) ?? []).length, 1);
  assert.doesNotMatch(out.title, /🫀|静息|测于/);
  assert.equal(out.features.heart.aggregation, 'minutes');
  assert.equal(out.features.heart.measuredAt, NOW - 60000);
  assert.equal(out.features.heart.alignment, 'latest_available_same_source');
  assert.equal(out.asOfAt, NOW - 60000);
  assert.equal(out.measuredAt, NOW - 2 * HOUR);
  assert.ok(out.evidenceIds.includes(s.heart[1].key));
  assert.equal(evaluatePhysiology(s, NOW).state, 'insufficient');
  // New heart data advances only the overview timestamp, including across midnight.
  s.heart.push(sample('heart', NOW + DAY, 70));
  const next = neutralPhysiology(s, NOW + DAY);
  assert.equal(next.measuredAt, anchor);
  assert.equal(next.asOfAt, NOW + DAY);
  assert.match(next.title, /HR 70｜09\/28 12:00$/);
});

test('ordinary heart display rejects future, invalid, other-source and conflicting minute values', () => {
  const s = fixture(5, 40); s.hrv.pop(); s.daily = [];
  const anchor = s.hrv.at(-1).start;
  s.heart.push(sample('heart', anchor - 60000, 72), sample('heart', NOW + 60000, 90),
    { ...sample('heart', anchor, 80), source: 'OtherWatch' }, sample('heart', anchor, NaN));
  assert.match(neutralPhysiology(s, NOW).title, /HR 72｜09\/27 10:00$/);
  s.heart.push(sample('heart', anchor - 60000, 74));
  assert.doesNotMatch(neutralPhysiology(s, NOW).title, /HR /);
  const rest = fixture(5, 40); rest.hrv.pop();
  assert.match(neutralPhysiology(rest, NOW).title, /RHR 55｜09\/27 10:00$/);
});

test('overview excludes heart older than the HRV proximity cutoff but permits a midnight boundary', () => {
  const s = fixture(5, 40); s.hrv.pop(); s.daily = [];
  const anchor = s.hrv.at(-1).start;
  s.heart.push(sample('heart', anchor - 16 * 60000, 72));
  assert.doesNotMatch(neutralPhysiology(s, NOW).title, /HR /);
  s.heart.push(sample('heart', anchor - 15 * 60000, 71));
  assert.match(neutralPhysiology(s, NOW).title, /HR 71/);
  const midnightSample = Date.parse('2026-09-28T00:02:00+08:00');
  s.hrv.push(sample('hrv', midnightSample, 41));
  s.heart.push(sample('heart', midnightSample - 5 * 60000, 65));
  assert.match(neutralPhysiology(s, midnightSample).title, /HR 65｜09\/28 00:02$/);
});
test('HRV comparison uses personal days, rejects context and preserves a factual fallback', () => {
  for (const [value, position] of [[80, 'above'], [40, 'below']]) {
    const s = fixture(5, value); s.hrv.pop();
    assert.equal(neutralPhysiology(s, NOW).hrvComparison.position, position);
  }
  const short = fixture(2); short.hrv.pop();
  assert.equal(neutralPhysiology(short, NOW).hrvComparison, undefined);
  const sleeping = fixture(5); sleeping.hrv.pop();
  sleeping.sleep.push({ start: NOW - 3 * HOUR, end: NOW - HOUR });
  assert.equal(neutralPhysiology(sleeping, NOW).hrvComparison, undefined);
  const moving = fixture(5); moving.hrv.pop();
  moving.workout.push({ start: NOW - 3 * HOUR, end: NOW - 2.5 * HOUR });
  assert.equal(neutralPhysiology(moving, NOW).hrvComparison, undefined);
  const mixed = fixture(5); mixed.hrv.pop();
  mixed.hrv.push({ ...mixed.hrv.at(-1), source: 'OtherWatch' });
  assert.equal(neutralPhysiology(mixed, NOW).hrvComparison, undefined);
  const weighted = fixture(5); weighted.hrv.pop();
  for (let i = 1; i <= 30; i++) weighted.hrv.push(sample('hrv', NOW - DAY - 2 * HOUR - i * 60000, 600));
  assert.equal(neutralPhysiology(weighted, NOW).hrvComparison.baseline, 63);
});

test('four-tier overview adds latest heart without changing the scoring evidence or expiry', () => {
  const s = fixture();
  const decision = evaluatePhysiology(s, NOW);
  const original = structuredClone(decision);
  const heart = sample('heart', NOW - 60000, 96);
  const view = withLatestHeartOverview(decision, [heart], NOW);
  assert.equal(view.state, decision.state);
  assert.equal(view.measuredAt, decision.measuredAt);
  assert.equal(view.validUntil, decision.validUntil);
  assert.deepEqual(view.features.hrv, decision.features.hrv);
  assert.deepEqual(view.features.resting, decision.features.resting);
  assert.deepEqual(view.reasons, decision.reasons);
  assert.equal(view.asOfAt, heart.start);
  assert.match(view.title, /HR 96｜09\/27 11:59$/);
  assert.deepEqual(decision, original);
  assert.equal(withLatestHeartOverview(decision, [heart, heart], NOW).title, view.title);
});


test('sleep context stays internal while public copy keeps only encouragement and dated metrics', () => {
  const s = fixture(5, 55); s.hrv.pop(); s.daily = [];
  s.sleep.push({ start: NOW - 3 * HOUR, end: NOW - HOUR });
  s.heart.push(sample('heart', NOW - 60000, 59));
  const out = neutralPhysiology(s, NOW);
  assert.equal(out.sampleContext, 'sleep');
  assert.doesNotMatch(out.title, /睡眠|采样|运动|日常节奏/);
  assert.match(out.title, /^🍃 按自己的节奏走\nHRV 55 · HR 59｜09\/27 11:59$/);
  assert.doesNotMatch(out.title, /健康记录|正常|优秀|偏高|偏低|状态优秀|状态正常|注意压力|压力过载|截至/);
  assert.equal(out.title.match(/\d{2}:\d{2}/g).length, 1);
});

test('metric comparison labels describe only supported HRV observations', () => {
  for (const [value, label] of [[40, '↓'], [60, ''], [80, '↑']]) {
    const s = fixture(5, value); s.hrv.pop(); s.daily = [];
    s.heart.push(sample('heart', NOW - 60000, 59));
    assert.ok(neutralPhysiology(s, NOW).title.includes(`HRV ${value}${label} · HR 59｜`));
  }
  const s = fixture(2, 60); s.hrv.pop();
  const out = neutralPhysiology(s, NOW);
  assert.match(out.title, /^🍃 按自己的节奏走\nHRV 60 · RHR 55｜/);
  assert.doesNotMatch(out.title, /健康记录|正常|优秀|截至/);
  s.hrv = [];
  assert.equal(neutralPhysiology(s, NOW).title, null);
});


test('contextual fallback follows the sample context rather than implying current sleep or exercise', () => {
  const s = fixture(5, 55); s.hrv.pop(); s.daily = [];
  s.workout.push({ start: NOW - 3 * HOUR, end: NOW - 2.5 * HOUR });
  const out = neutralPhysiology(s, NOW);
  assert.match(out.title, /^🍃 按自己的节奏走\nHRV 55｜/);
  assert.doesNotMatch(out.title, /正常|优秀|健康记录/);
  s.hrv.push(sample('hrv', NOW, 60));
  const newer = neutralPhysiology(s, NOW);
  assert.equal(newer.sampleContext, 'unclassified');
  assert.doesNotMatch(newer.title, /运动采样|HRV 60运动/);
});


test('four-tier comparison uses the displayed latest HRV rather than an older window median', () => {
  const s = fixture(5, 100, 55);
  s.hrv.at(-1).value = 35;
  const out = evaluatePhysiology(s, NOW);
  assert.equal(out.state, 'tense');
  assert.equal(out.features.hrv.current, 35);
  assert.equal(out.features.hrv.latest, 35);
  assert.equal(out.features.hrv.currentAggregation, 'latest_sample');
});

test('a single current HRV never bypasses red-tier independent-measurement confirmation', () => {
  const s = fixture(5, 35, 65);
  s.hrv = s.hrv.filter(r => r.start !== NOW - 2 * HOUR);
  const first = evaluatePhysiology(s, NOW);
  assert.equal(first.state, 'tense');
  assert.equal(first.candidate, 'high');
  assert.equal(evaluatePhysiology(s, NOW + HOUR / 2, first).state, 'tense');
  s.hrv.push(sample('hrv', NOW + HOUR / 2, 34));
  assert.equal(evaluatePhysiology(s, NOW + HOUR / 2, first).state, 'high');
});
