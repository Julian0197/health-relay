import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSignatureSnapshot, TITLES, SIGNATURE_SCHEMA_VERSION, SIGNATURE_RULE_VERSION } from './signature.mjs';

const DAY = 86400000, HOUR = 3600000, MIN = 60000;
const NOW = Date.parse('2026-09-26T12:00:00+08:00');
const iso = ms => new Date(ms).toISOString();

let seq = 0;
const key = (kind, start) => `${kind}:${start}:${seq++}`;
const hrv = (start, value = 60, source = 'Watch') =>
  ({ kind: 'hrv', start, end: start + 90000, value, unit: 'ms', method: 'SDNN', source, key: key('hrv', start) });
const heart = (start, value = 70, source = 'Watch') =>
  ({ kind: 'heart', start, end: start + MIN, value, min: value - 3, max: value + 3, unit: 'bpm', source, key: key('heart', start) });
const sleepRows = (nightStart, source = 'Watch') => {
  // 两段 core 跨过午夜（23:00→00:20、00:20→00:50），结束日为入睡日的次日
  return [
    { kind: 'sleep', start: nightStart, end: nightStart + 80 * MIN, stage: 'core', source, key: key('sleep', nightStart) },
    { kind: 'sleep', start: nightStart + 80 * MIN, end: nightStart + 110 * MIN, stage: 'core', source, key: key('sleep', nightStart + 80 * MIN) },
  ];
};
const rhr = (dayStart, value = 55, source = 'Watch') =>
  ({ kind: 'daily', metric: 'resting_heart_rate', start: dayStart + 7 * HOUR, end: dayStart + 7 * HOUR, value, unit: 'count/min', source, key: key('rhr', dayStart) });
const workout = (start, end, id = 'w1') =>
  ({ kind: 'workout', id, start, end, source: 'Watch', key: id });

/** 生成 n 个历史夜晚的睡眠+HRV+RHR（不含今天），今天的睡眠单独给。 */
function history(n, { hrvValue = 60, rhrValue = 55 } = {}) {
  const series = { hrv: [], heart: [], sleep: [], daily: [], workout: [] };
  // 北京时间今天 0 点（NOW 当天 12:00 +08）
  const todayMidnight = Date.parse('2026-09-26T00:00:00+08:00');
  for (let d = 1; d <= n; d++) {
    const midnight = todayMidnight - d * DAY;
    const nightStart = midnight - 1 * HOUR; // 前一天 23:00 入睡（结束日为 d 天前那天）
    series.sleep.push(...sleepRows(nightStart));
    series.hrv.push(hrv(nightStart + 10 * MIN, hrvValue));
    series.daily.push(rhr(midnight, rhrValue));
  }
  return { series, todayMidnight };
}

function addTonight(series, todayMidnight, { hrvValue = 60, rhrValue = 55 } = {}) {
  const nightStart = todayMidnight - 1 * HOUR; // 昨晚 23:00，结束于今天凌晨 → 主睡眠归属今天
  series.sleep.push(...sleepRows(nightStart));
  series.hrv.push(hrv(nightStart + 10 * MIN, hrvValue));
  series.daily.push(rhr(todayMidnight, rhrValue));
  return nightStart;
}

test('空库输出 pending/no_data，title 为固定待更新模板', async () => {
  const snap = await buildSignatureSnapshot({ hrv: [], heart: [], sleep: [], daily: [], workout: [] }, NOW);
  assert.equal(snap.state, 'pending');
  assert.equal(snap.publishState, 'pending');
  assert.equal(snap.title, TITLES.pending);
  assert.deepEqual(snap.reasons, ['no_data']);
  assert.equal(snap.publishable, true);
  assert.equal(snap.quality, 'insufficient');
  assert.equal(snap.schemaVersion, SIGNATURE_SCHEMA_VERSION);
  assert.equal(snap.ruleVersion, SIGNATURE_RULE_VERSION);
  assert.match(snap.evidenceVersion, /^[0-9a-f]{16}$/);
});

test('全部信号陈旧且无睡眠 → pending，不用钟点猜测睡眠', async () => {
  const s = { hrv: [], heart: [heart(NOW - 3 * HOUR)], sleep: [], daily: [], workout: [] };
  const snap = await buildSignatureSnapshot(s, NOW);
  assert.equal(snap.state, 'pending');
  assert.ok(snap.reasons.some(r => r.startsWith('heart_stale')));
  assert.ok(!snap.reasons.includes('sleeping'));
});

test('刚结束 20 分钟的训练 → post_workout，优先级高于基线积累', async () => {
  const { series } = history(3); // 基线不足
  series.heart.push(heart(NOW - 5 * MIN, 88));
  series.workout.push(workout(NOW - 50 * MIN, NOW - 20 * MIN));
  const snap = await buildSignatureSnapshot(series, NOW);
  assert.equal(snap.state, 'post_workout');
  assert.equal(snap.title, TITLES.post_workout);
  assert.deepEqual(snap.reasons, ['post_workout_window']);
  assert.ok(snap.validUntil <= NOW + 24 * HOUR);
  // 快照在训练后窗口结束时到期
  assert.equal(snap.validUntil, NOW - 20 * MIN + 60 * MIN);
});

test('训练进行中不输出结论（pending），结束的训练不写成运动中', async () => {
  const { series, todayMidnight } = history(16);
  addTonight(series, todayMidnight);
  series.heart.push(heart(NOW - 2 * MIN, 120));
  series.workout.push(workout(NOW - 10 * MIN, NOW + 20 * MIN));
  const snap = await buildSignatureSnapshot(series, NOW);
  assert.equal(snap.state, 'pending');
  assert.deepEqual(snap.reasons, ['workout_in_progress']);
});

test('可比历史不足 14 晚 → baseline_building', async () => {
  const { series, todayMidnight } = history(5);
  addTonight(series, todayMidnight);
  const snap = await buildSignatureSnapshot(series, NOW);
  assert.equal(snap.state, 'baseline_building');
  assert.equal(snap.publishState, 'baseline_building');
  assert.equal(snap.title, TITLES.baseline_building);
  assert.equal(snap.quality, 'limited');
  assert.ok(snap.reasons.some(r => r.startsWith('nightly_baseline_building')));
});

test('基线充足且无偏离 → steady（影子态，公开发布回落中性模板）', async () => {
  const { series, todayMidnight } = history(16);
  addTonight(series, todayMidnight); // 今晚 HRV=60，与基线持平
  series.heart.push(heart(NOW - 10 * MIN, 70));
  const snap = await buildSignatureSnapshot(series, NOW);
  assert.equal(snap.state, 'steady');
  assert.equal(snap.publishable, false);
  assert.equal(snap.publishState, 'pending');
  assert.equal(snap.title, TITLES.pending);
  assert.equal(snap.shadow.state, 'steady');
  assert.equal(snap.shadow.title, TITLES.steady);
});

test('夜间 HRV 偏低 + RHR 偏高 双证据 → drift 影子态', async () => {
  const { series, todayMidnight } = history(16, { hrvValue: 60, rhrValue: 55 });
  addTonight(series, todayMidnight, { hrvValue: 30, rhrValue: 62 });
  series.heart.push(heart(NOW - 10 * MIN, 78));
  const snap = await buildSignatureSnapshot(series, NOW);
  assert.equal(snap.state, 'drift');
  assert.ok(snap.reasons.includes('nightly_hrv_below_usual'));
  assert.ok(snap.reasons.includes('resting_hr_above_usual'));
  assert.equal(snap.publishable, false);
});

test('仅 HRV 单指标偏低、RHR 与心率不支持 → 不定性为 drift', async () => {
  const { series, todayMidnight } = history(16, { hrvValue: 60, rhrValue: 55 });
  addTonight(series, todayMidnight, { hrvValue: 30, rhrValue: 55 });
  series.heart.push(heart(NOW - 10 * MIN, 70));
  const snap = await buildSignatureSnapshot(series, NOW);
  assert.equal(snap.state, 'steady');
  assert.ok(snap.reasons.includes('single_signal_not_enough'));
});

test('evidenceVersion：相同事实稳定，修订测量值才产生新版本', async () => {
  const build = () => {
    const { series, todayMidnight } = history(16);
    addTonight(series, todayMidnight, { hrvValue: 60 });
    series.heart.push(heart(NOW - 10 * MIN, 70));
    return series;
  };
  const v1 = (await buildSignatureSnapshot(build(), NOW)).evidenceVersion;
  const v2 = (await buildSignatureSnapshot(build(), NOW)).evidenceVersion;
  assert.equal(v1, v2);
  const s3 = build();
  s3.hrv.at(-1).value = 42;
  const v3 = (await buildSignatureSnapshot(s3, NOW)).evidenceVersion;
  assert.notEqual(v3, v1);
});

test('validUntil 被夹在 5 分钟下限与 24 小时上限之间', async () => {
  const { series, todayMidnight } = history(16);
  addTonight(series, todayMidnight);
  const snap = await buildSignatureSnapshot(series, NOW);
  assert.ok(snap.validUntil >= NOW + 5 * MIN);
  assert.ok(snap.validUntil <= NOW + 24 * HOUR);
});

test('title 永远不包含指标数值（模板外字符禁止由状态机产生）', async () => {
  const { series, todayMidnight } = history(16);
  addTonight(series, todayMidnight, { hrvValue: 30, rhrValue: 62 });
  series.heart.push(heart(NOW - 10 * MIN, 120));
  series.workout.push(workout(NOW - 200 * MIN, NOW - 100 * MIN));
  const snap = await buildSignatureSnapshot(series, NOW);
  for (const title of [snap.title, snap.shadow?.title].filter(Boolean)) {
    assert.ok(Object.values(TITLES).includes(title), `非固定模板 title: ${title}`);
  }
});
