import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard, dashboardRange, HEART_POINT_CAP, bucketHeartPoints } from './dashboard.mjs';
import { evaluateHealthIndices } from './health-indices.mjs';
import { pressureHeadline, renderHealthSignature, PRESSURE_LABELS } from './health-signature.mjs';

const H = 3600000, D = 24 * H;
const NOW = Date.parse('2026-09-28T20:00:00+08:00');

function sleepNight(anchorEnd, coreMin = 300, awakeMin = 20, remMin = 60) {
  const end = anchorEnd;
  const coreMs = coreMin * 60000, awakeMs = awakeMin * 60000, remMs = remMin * 60000;
  let t = end - coreMs - awakeMs - remMs;
  const rows = [{ start: t, end: t + coreMs, stage: 'core', source: 'Watch' }];
  t += coreMs;
  rows.push({ start: t, end: t + awakeMs, stage: 'awake', source: 'Watch' });
  t += awakeMs;
  rows.push({ start: t, end: t + remMs, stage: 'rem', source: 'Watch' });
  return rows;
}

function fixture() {
  const s = { hrv: [], heart: [], daily: [], sleep: [], workout: [] };
  // Seven nights ending at 07:00 Beijing, plus same-time-band baselines for the scorer.
  for (let d = 0; d <= 6; d++) {
    s.sleep.push(...sleepNight(NOW - d * D - 13 * H, d === 0 ? 420 : 300, 20, d === 0 ? 80 : 60));
    if (d >= 1) {
      s.hrv.push({ start: NOW - d * D, end: NOW - d * D, value: 60 + (d % 3), source: 'Watch', method: 'SDNN' });
      s.heart.push({ start: NOW - d * D, end: NOW - d * D + 60000, value: 62, source: 'Watch' });
    }
  }
  // Fresh 24h data.
  s.hrv.push({ start: NOW - 2 * H, end: NOW - 2 * H, value: 72, source: 'Watch', method: 'SDNN' });
  s.heart.push({ start: NOW - 2 * H, end: NOW - H * 2 + 60000, value: 59, source: 'Watch' });
  s.daily.push(
    { metric: 'step_count', start: NOW - 12 * H, end: NOW - 12 * H, value: 8765.4, unit: 'count', source: 'Watch' },
    { metric: 'active_energy', start: NOW - 12 * H, end: NOW - 12 * H, value: 412.3, unit: 'kcal', source: 'Watch' },
    { metric: 'oxygen_saturation', start: NOW - 12 * H, end: NOW - 12 * H, value: 98, unit: '%', source: 'Watch' },
  );
  s.workout.push({ name: '户外跑步', start: NOW - 5 * H, end: NOW - 4 * H, source: 'Watch' });
  return s;
}

test('monthly workout history uses exact 20-minute cutoff, legacy facts and independent heart coverage', () => {
  const start = NOW - D;
  const w = (name, at, durationMs) => ({ name, start: at, end: at + H, durationMs, source: 'Watch' });
  const s = { hrv: [], daily: [], sleep: [], heart: [
    { start, end: start + 60000, value: 110, max: 130, source: 'Watch' },
    { start: start + 60000, end: start + 120000, value: 130, max: 170, source: 'Watch' },
  ], workout: [
    { ...w('足球', start, 1200000), activeEnergyKcal: 200 },
    w('短训练', start - H * 2, 1199999),
    { name: '旧力量训练', start: NOW - 20 * D, end: NOW - 20 * D + H,
      details: ['时长 1 小时 0 分钟', '活动能量 418.4 kJ', '平均心率 115 bpm', '最高心率 160 bpm'] },
    w('窗口外', NOW - 31 * D, H), w('未结束', NOW, H),
  ] };
  const dto = buildDashboard(s, NOW);
  assert.ok(dto.workoutHistory, 'monthly facts must be available without expanding the header range');
  assert.deepEqual(dto.workoutHistory.records.map(r => r.name), ['足球', '旧力量训练']);
  const [ball, legacy] = dto.workoutHistory.records;
  assert.equal(ball.durationMs, 1200000); assert.equal(ball.durationBasis, 'recorded');
  assert.equal(ball.heart.avg, 120); assert.equal(ball.heart.max, 170);
  assert.equal(ball.heart.coveredMinutes, 2); assert.equal(ball.heart.basis, 'matched_minutes');
  assert.equal(legacy.activeEnergyKcal, 100); assert.equal(legacy.durationBasis, 'elapsed');
  assert.equal(legacy.heart.avg, 115); assert.equal(legacy.heart.max, 160);
  assert.doesNotMatch(JSON.stringify(dto.workoutHistory), /Watch|source|details|latitude/);
  assert.equal(dto.workouts.length, 1, 'existing overlay windows remain independent of the display cutoff');
  const hash = dto.contentHash;
  s.workout[2].details[1] = '活动能量 836.8 kJ';
  assert.notEqual(buildDashboard(s, NOW).contentHash, hash);
});

test('workout heart recovery requires actual aligned end and one-minute measurements from one source', () => {
  const start = NOW - H * 2, end = NOW - H;
  const recovery = [{ time: end, avg: 150, source: 'Watch' }, { time: end + 60000, avg: 125, source: 'Watch' }];
  const s = { workout: [{ name: '器械', start, end, heartRateRecovery: recovery }], heart: [] };
  const record = () => buildDashboard(s, NOW).workoutHistory?.records[0];
  assert.ok(record(), 'workout history missing');
  assert.equal(record().recovery.drop1m, 25);
  recovery[1].time += 60000;
  assert.equal(record().recovery, null, 'two-minute sample cannot masquerade as one minute');
  recovery[1].time = end + 60000; recovery[1].source = 'Other';
  assert.equal(record().recovery, null);
  delete s.workout[0].heartRateRecovery;
  assert.equal(record().recovery, null, 'ordinary heart points cannot invent a recovery measurement');
});

test('24h dashboard is windowed, pivoted and limited to render fields', () => {
  const s = fixture();
  const indices = evaluateHealthIndices(s, NOW);
  const d = buildDashboard(s, NOW, { range: '24h', indices, publication: { mode: 'health-indices-v1', sentTitle: 'x', lastSentAt: NOW - H, pending: false } });
  assert.equal(d.schemaVersion, 'dashboard-v1');
  assert.equal(d.range, '24h');
  assert.equal(d.window.startAt, NOW - D);
  assert.equal(d.window.endAt, NOW);
  assert.equal(d.timezone, 'Asia/Shanghai');
  assert.equal(d.dataUpdatedAt, NOW - 2 * H + 60000);
  // The d=1 baseline point sits exactly on the 24h boundary; window is inclusive.
  assert.deepEqual(d.hrv, [{ t: NOW - D, v: 61 }, { t: NOW - 2 * H, v: 72 }]);
  assert.equal(d.heart.points.length, 2);
  assert.equal(d.heart.truncated, false);
  assert.equal(d.heart.cap, HEART_POINT_CAP);
  // Last night is in the 24h window, stages preserved.
  assert.equal(d.sleep.length, 1);
  assert.equal(d.sleep[0].date, '2026-09-28');
  assert.equal(d.sleep[0].asleepMinutes, 500);
  assert.equal(d.sleep[0].awakeMinutes, 20);
  assert.equal(d.sleep[0].stages.core, 420);
  assert.equal(d.sleep[0].stages.rem, 80);
  assert.equal(d.sleep[0].conflict, false);
  // Daily pivot whitelist drops oxygen_saturation.
  assert.deepEqual(Object.keys(d.daily.at(-1).metrics).sort(), ['active_energy', 'step_count']);
  assert.equal(d.daily.at(-1).metrics.step_count.v, 8765.4);
  assert.equal(d.workouts.length, 1);
  assert.equal(d.workouts[0].durationMs, H);
  assert.equal(d.channels.hrv.count, 7);
  assert.equal(d.channels.hrv.latestAt, NOW - 2 * H);
  // Indices view carries scores and presentation only.
  assert.equal(d.healthIndices.ruleVersion, 'health-indices-v4-nightly');
  assert.equal(typeof d.healthIndices.pressure.score, 'number');
  assert.ok(d.healthIndices.pressure.emoji);
  assert.equal(d.publication.sentTitle, 'x');
  // Raw source/device names and baseline internals never leave the service.
  assert.doesNotMatch(JSON.stringify(d), /Watch|hrvBaseline|heartBaseline|payload|originalTime/);
});

test('7d range widens windows and covers every night', () => {
  const s = fixture();
  const d = buildDashboard(s, NOW, { range: '7d', indices: evaluateHealthIndices(s, NOW) });
  assert.equal(d.window.startAt, NOW - 7 * D);
  assert.equal(d.hrv.length, 7);
  assert.equal(d.heart.points.length, 7);
  assert.equal(d.sleep.length, 7);
});

test('sleep breakdowns use each night and preserve the current scorer components', () => {
  const s = fixture(), indices = evaluateHealthIndices(s, NOW);
  const d = buildDashboard(s, NOW, { range: '7d', indices });
  const latest = d.sleep.at(-1);
  assert.equal(latest.score, indices.sleep.score);
  assert.deepEqual(latest.components, indices.sleep.components);
  assert.equal(latest.bedtimeDeviationMinutes, indices.sleep.bedtimeDeviationMinutes);
  assert.deepEqual(d.healthIndices.sleep.components, indices.sleep.components);
  assert.equal(latest.components.regularity, 0);
  assert.equal(latest.components.duration, 50);
  const previous = d.sleep.at(-2);
  assert.equal(previous.components.duration, 37.5);
  assert.equal(previous.components.regularity, 30);
  assert.equal(previous.score, Math.round(37.5 + 30 + 20 * 360 / 380));
  assert.equal(d.sleep[0].score, null);
  assert.equal(d.sleep[0].reason, 'short_sleep_baseline');
  assert.equal(d.sleep[0].components, null);
});

test('historical sleep breakdown stays available after the current signature score expires', () => {
  const s = fixture(), later = NOW + D;
  const indices = evaluateHealthIndices(s, later);
  assert.equal(indices.sleep.reason, 'expired_sleep');
  const d = buildDashboard(s, later, { range: '7d', indices });
  assert.equal(d.healthIndices.sleep.score, null);
  assert.equal(d.sleep.at(-1).score, 69);
  assert.equal(d.sleep.at(-1).components.duration, 50);
});

test('conflicting sleep records have no fabricated breakdown', () => {
  const s = fixture();
  s.sleep.push({ ...s.sleep[0], source: 'Other Watch' });
  const d = buildDashboard(s, NOW, { range: '7d' });
  assert.equal(d.sleep.at(-1).score, null);
  assert.equal(d.sleep.at(-1).components, null);
  assert.equal(d.sleep.at(-1).reason, 'incomplete_or_conflicting_sleep');
});

test('RMSSD records do not enter the existing SDNN chart', () => {
  const s = fixture();
  const before = buildDashboard(s, NOW);
  s.hrv.push({ start: NOW - H, end: NOW - H + 60000, value: 35, source: 'Watch', method: 'RMSSD', aggregation: 'minutes' });
  const after = buildDashboard(s, NOW);
  assert.deepEqual(after.hrv, before.hrv);
  assert.equal(evaluateHealthIndices(s, NOW).features.hrv.method, 'RMSSD');
  const indices = evaluateHealthIndices(s, NOW);
  const view = buildDashboard(s, NOW, { indices });
  assert.equal(view.healthIndices.pressure.hrvMethod, 'RMSSD');
  assert.equal(view.healthIndices.pressure.validUntil, NOW - H + 90 * 60000);
});

test('recovery HRV has its own windowed points and coverage without changing SDNN', () => {
  const s = fixture();
  const row = (start, value) => ({ start, end: start + 60000, value, source: 'Watch', method: 'RMSSD', aggregation: 'minutes' });
  s.hrv.push(row(NOW - 2 * D, 30), row(NOW - H, 35), row(NOW + H, 50), row(NOW - H / 2, 0));
  const dto = buildDashboard(s, NOW);
  assert.deepEqual(dto.recoveryHrv, [{ t: NOW - H, v: 35 }]);
  assert.equal(dto.hrv.at(-1).v, 72);
  assert.deepEqual(dto.channels.recoveryHrv, { count: 2, latestAt: NOW - H + 60000 });
  assert.equal(dto.channels.hrv.count, 7);
  assert.equal(dto.channels.hrv.latestAt, NOW - 2 * H);
  const hash = dto.contentHash;
  s.hrv.find(r => r.method === 'RMSSD' && r.start === NOW - H).value = 36;
  assert.notEqual(buildDashboard(s, NOW).contentHash, hash);
  assert.deepEqual(buildDashboard(s, NOW, { range: '7d' }).recoveryHrv, [{ t: NOW - 2 * D, v: 30 }, { t: NOW - H, v: 36 }]);
  assert.doesNotMatch(JSON.stringify(dto.recoveryHrv), /Watch|source|originalTime/);
});

test('heart points past the cap are newest-kept and flagged truncated', () => {
  const s = { hrv: [], heart: [], daily: [], sleep: [], workout: [] };
  for (let i = 0; i < HEART_POINT_CAP + 250; i++) {
    s.heart.push({ start: NOW - (i + 1) * 60000, end: NOW - i * 60000, value: 60 + (i % 5), source: 'Watch' });
  }
  const d = buildDashboard(s, NOW, { range: '7d' });
  assert.equal(d.heart.points.length, HEART_POINT_CAP);
  assert.equal(d.heart.truncated, true);
  // Newest window (the last pushed, i=0) survives.
  assert.equal(d.heart.points.at(-1).s, NOW - 60000);
});

test('7d heart buckets are computed BEFORE the cap, covering the whole window', () => {
  // Regression: a full week is 10080 minute windows; truncating to 5000 before bucketing
  // silently lost the oldest 3.5 days and the 10-min buckets only spanned ~3.47 days.
  const tenMin = 10 * 60000;
  const s = { hrv: [], heart: [], daily: [], sleep: [], workout: [] };
  for (let i = 0; i < 7 * 24 * 60; i++) {
    s.heart.push({ start: NOW - (i + 1) * 60000, end: NOW - i * 60000, value: 60 + (i % 7), source: 'Watch' });
  }
  const d = buildDashboard(s, NOW, { range: '7d', heartBucketMs: tenMin });
  assert.equal(d.heart.bucketMinutes, 10);
  assert.equal(d.heart.truncated, false);
  assert.ok(d.heart.points.length >= 1008 && d.heart.points.length <= 1009,
    `expected ~1008 buckets, got ${d.heart.points.length}`);
  const span = d.heart.points.at(-1).e - d.heart.points[0].s;
  assert.ok(span >= 7 * 24 * 3600000 - tenMin, `buckets must span the full week, got ${span / 3600000}h`);
  // mean within any bucket is a real average, not raw passthrough
  assert.ok(d.heart.points.every(p => p.e - p.s <= tenMin));
});

test('heart bucketing averages onto a fixed grid and keeps gaps', () => {
  const ten = 10 * 60000;
  const t0 = Math.floor(NOW / ten) * ten - ten;
  const pts = [
    { s: t0 + 60000, e: t0 + 120000, v: 60 },
    { s: t0 + 180000, e: t0 + 240000, v: 70 },
    { s: t0 + 2 * ten, e: t0 + 2 * ten + 60000, v: 90 }, // empty bucket in between
  ];
  const buckets = bucketHeartPoints(pts, ten);
  assert.equal(buckets.length, 2);
  assert.deepEqual(buckets[0], { s: t0, e: t0 + 240000, v: 65, min: 60, max: 70 });
  assert.deepEqual(buckets[1], { s: t0 + 2 * ten, e: t0 + 2 * ten + 60000, v: 90, min: 90, max: 90 });
  // Minute-or-smaller bucket sizes pass through untouched.
  assert.equal(bucketHeartPoints(pts, 60000), pts);
});

test('missing facts and missing indices degrade to empties, never zeros', () => {
  const d = buildDashboard({ hrv: [], heart: [], daily: [], sleep: [], workout: [] }, NOW, {});
  assert.equal(d.dataUpdatedAt, null);
  assert.deepEqual(d.hrv, []);
  assert.equal(d.heart.points.length, 0);
  assert.deepEqual(d.sleep, []);
  assert.equal(d.daily.length, 2);
  assert.ok(d.daily.every(d => Object.keys(d.metrics).length === 0));
  assert.deepEqual(d.workouts, []);
  for (const ch of Object.values(d.channels)) assert.deepEqual(ch, { count: 0, latestAt: null });
  assert.equal(d.healthIndices, null);
  assert.equal(d.publication, null);
});

test('range is strictly validated', () => {
  assert.equal(dashboardRange('24h'), '24h');
  assert.equal(dashboardRange('7d'), '7d');
  assert.equal(dashboardRange('30d'), null);
  assert.throws(() => buildDashboard({}, NOW, { range: '30d' }), /invalid_range/);
});

test('contentHash moves on same-timestamp value corrections but ignores generatedAt', () => {
  const dayStart = NOW - 12 * H;
  const boardWith = steps => buildDashboard({
    hrv: [], heart: [], sleep: [], workout: [],
    daily: [{ metric: 'step_count', start: dayStart, end: dayStart, value: steps, unit: 'count', source: 'Watch' }],
  }, NOW, { range: '24h' });
  const first = boardWith(1000);
  const same = boardWith(1000);
  const corrected = boardWith(2000);
  // Deterministic across identical builds; the measured timestamp never changed.
  assert.equal(first.contentHash, same.contentHash);
  assert.notEqual(first.contentHash, corrected.contentHash);
  assert.equal(first.dataUpdatedAt, corrected.dataUpdatedAt);
  // Re-rendering one second later (new generatedAt only) must look identical to the client.
  const later = buildDashboard({
    hrv: [], heart: [], sleep: [], workout: [],
    daily: [{ metric: 'step_count', start: dayStart, end: dayStart, value: 1000, unit: 'count', source: 'Watch' }],
  }, NOW + 1000, { range: '24h' });
  assert.equal(later.contentHash, first.contentHash);
});

test('contentHash ignores evaluation time but still tracks health state changes', () => {
  const series = fixture();
  const indices = evaluateHealthIndices(series, NOW);
  const board = (now, indices) => buildDashboard(series, now, { range: '7d', indices });
  const first = board(NOW, indices);
  const later = board(NOW + 1000, evaluateHealthIndices(series, NOW + 1000));
  assert.notEqual(later.healthIndices.evaluatedAt, first.healthIndices.evaluatedAt);
  assert.equal(later.contentHash, first.contentHash);
  const changed = structuredClone(indices);
  changed.ruleVersion = 'next-rule';
  assert.notEqual(board(NOW, changed).contentHash, first.contentHash);
});

test('same-day conflicting metrics stay missing regardless of arrival order', () => {
  const dayStart = NOW - 12 * H;
  const mk = source => ({ metric: 'step_count', start: dayStart, end: dayStart,
    value: source === 'iPhone' ? 1000 : 8000, unit: 'count', source });
  // Device order must never silently choose one conflicting value.
  const watchFirst = buildDashboard({ hrv: [], heart: [], sleep: [], workout: [],
    daily: [mk('Apple Watch'), mk('iPhone')] }, NOW, { range: '24h' });
  // Phone first, Watch second: same result, proving order cannot decide it.
  const watchLast = buildDashboard({ hrv: [], heart: [], sleep: [], workout: [],
    daily: [mk('iPhone'), mk('Apple Watch')] }, NOW, { range: '24h' });
  assert.equal(watchFirst.daily.at(-1).metrics.step_count.v, null);
  assert.equal(watchFirst.daily.at(-1).metrics.step_count.reason, 'source_conflict');
  assert.equal(watchFirst.daily.at(-1).metrics.step_count.source, 'mixed');
  assert.equal(watchFirst.daily.at(-1).metrics.step_count.sources, 2);
  assert.equal(watchFirst.daily.at(-1).metrics.step_count.conflict, true);
  assert.deepEqual(watchLast.daily.at(-1).metrics, watchFirst.daily.at(-1).metrics);

  // Only the phone -> phone wins without a conflict flag.
  const phoneOnly = buildDashboard({ hrv: [], heart: [], sleep: [], workout: [],
    daily: [mk('iPhone')] }, NOW, { range: '24h' });
  assert.equal(phoneOnly.daily.at(-1).metrics.step_count.v, 1000);
  assert.equal(phoneOnly.daily.at(-1).metrics.step_count.source, 'phone');
  assert.equal(phoneOnly.daily.at(-1).metrics.step_count.conflict, false);
});

test('future rows are excluded; non-positive values are dropped', () => {
  const s = {
    hrv: [{ start: NOW + H, end: NOW + H, value: 99, source: 'Watch' }, { start: NOW - H, end: NOW - H, value: 0, source: 'Watch' }],
    heart: [{ start: NOW + H, end: NOW + H + 60000, value: 80, source: 'Watch' }],
    daily: [], sleep: [], workout: [],
  };
  const d = buildDashboard(s, NOW, { range: '24h' });
  assert.deepEqual(d.hrv, []);
  assert.equal(d.heart.points.length, 0);
});

test('dashboard preserves score context and latest minute independently of buckets', () => {
  const s = fixture(); const last = s.heart.at(-1); last.min = 53; last.max = 68;
  const indices = evaluateHealthIndices(s, NOW);
  const dto = buildDashboard(s, NOW, { indices, heartBucketMs: 600000 });
  assert.equal(dto.healthIndices.pressure.context, 'awake_sample');
  assert.equal(dto.healthIndices.pressure.evidenceAt, indices.pressure.evidenceAt);
  assert.equal(dto.healthIndices.pressure.validUntil, indices.pressure.evidenceAt + 6 * H);
  assert.deepEqual(dto.heart.latest, { s: last.start, e: last.end, v: 59, min: 53, max: 68 });
  assert.equal(dto.heart.points.at(-1).min, 53);
});
test('dashboard keeps the last recorded pressure at its measurement time after expiry', () => {
  const series = fixture(), measured = evaluateHealthIndices(series, NOW);
  const later = NOW + 8 * H, indices = evaluateHealthIndices(series, later);
  assert.equal(indices.pressure.reason, 'expired_hrv');
  const last = { ruleVersion: measured.ruleVersion, source: measured.pressure.source,
    score: measured.pressure.score, evidenceAt: measured.pressure.evidenceAt,
    context: measured.pressure.context, confidence: measured.pressure.confidence };
  indices.lastValidPressure = last;
  const dto = buildDashboard(series, later, { indices });
  assert.equal(dto.healthIndices.pressure.score, last.score);
  assert.equal(dto.healthIndices.pressure.evidenceAt, last.evidenceAt);
  assert.equal(dto.healthIndices.pressure.state, measured.pressure.presentation.state);
  assert.equal(dto.healthIndices.pressure.reason, null);
  assert.equal(dto.healthIndices.pressure.retained, true);
  assert.equal(dto.healthIndices.pressure.components, null);
  assert.equal(dto.generatedAt, later);
  assert.equal(indices.pressure.score, null);
  for (const change of [{ source: 'Other' }, { ruleVersion: 'Other' }, { evidenceAt: later + H }]) {
    indices.lastValidPressure = { ...last, ...change };
    assert.equal(buildDashboard(series, later, { indices }).healthIndices.pressure.score, null);
  }
  indices.pressure.reason = 'insufficient_samples';
  indices.lastValidPressure = last;
  assert.equal(buildDashboard(series, later, { indices }).healthIndices.pressure.score, null);
  indices.pressure.evidenceAt = later - H;
  assert.equal(buildDashboard(series, later, { indices }).healthIndices.pressure.score, last.score);
});
test('dashboard headline and retention follow the signature, including the seven-day limit', () => {
  const series = fixture(), measured = evaluateHealthIndices(series, NOW);
  const last = { ruleVersion: measured.ruleVersion, source: measured.pressure.source, score: measured.pressure.score,
    evidenceAt: measured.pressure.evidenceAt, context: measured.pressure.context };
  const at = (now, lastValidPressure, history = null) => {
    // Attach the recorded result as HealthStore.refreshSignaturePresentation does.
    const indices = evaluateHealthIndices(series, now);
    indices.lastValidPressure = lastValidPressure;
    indices.headline = pressureHeadline(indices, now, history);
    return { indices, history, dto: buildDashboard(series, now, { indices }), title: renderHealthSignature(indices, now, history) };
  };
  const retained = at(NOW + 8 * H, last);
  assert.equal(retained.dto.healthIndices.headline.basis, 'retained');
  assert.equal(retained.dto.healthIndices.headline.evidenceAt, last.evidenceAt);
  // The signature names the state only; the 「上次」 distinction lives in the dashboard headline.
  assert.ok(retained.title.startsWith(`🔵 ${retained.dto.healthIndices.headline.label}`) || retained.title.includes(` ${retained.dto.healthIndices.headline.label} `));
  assert.doesNotMatch(retained.title, /上次|今日压力|最近压力/);
  // Older than the signature keeps it: neither copy presents it any longer.
  const old = at(last.evidenceAt + 7 * D + H, last);
  assert.equal(old.dto.healthIndices.pressure.retained, false);
  assert.equal(old.dto.healthIndices.pressure.score, null);
  assert.equal(old.dto.healthIndices.headline.basis, 'missing');
  assert.match(old.title, /^压力暂无/);
  // A current result labels both copies with the same four-tier words.
  const current = at(NOW, null);
  assert.equal(current.dto.healthIndices.headline.basis, 'current');
  assert.equal(current.dto.healthIndices.headline.label, PRESSURE_LABELS[current.dto.healthIndices.pressure.state]);
  assert.ok(current.title.includes(current.dto.healthIndices.headline.label));
});
test('daily dates are complete and normalized; conflicting sources cannot overwrite silently', () => {
  const row = (value, unit, source) => ({ metric: 'active_energy', start: NOW - H, end: NOW - H, value, unit, source });
  let dto = buildDashboard({ daily: [row(418.4, 'kJ', 'Watch')] }, NOW);
  assert.equal(dto.daily.length, 2);
  assert.deepEqual(dto.daily[0].metrics, {});
  assert.deepEqual(dto.daily.at(-1).metrics.active_energy, { v: 100, unit: 'kcal', source: 'watch', sources: 1, conflict: false });
  dto = buildDashboard({ daily: [row(100, 'kcal', 'Watch'), row(150, 'kcal', 'Phone')] }, NOW);
  assert.equal(dto.daily.at(-1).metrics.active_energy.v, null);
  assert.equal(dto.daily.at(-1).metrics.active_energy.reason, 'source_conflict');
});
