import test from 'node:test';
import assert from 'node:assert/strict';
import * as presentation from './health-signature.mjs';

test('shows every today sleep category with its computed score including zero', () => {
  const now = Date.parse('2026-10-20T08:00:00Z');
  const indices = { features: { hrv: { current: 69 } }, pressure: { score: null, reason: 'missing_hrv' },
    sleep: { date: '2026-10-20', score: 88 } };
  for (const [score, emoji, label] of [[0, '🌑', '待改善'], [39, '🌑', '待改善'], [40, '🌓', '一般'], [59, '🌓', '一般'],
    [60, '🌜', '良好'], [79, '🌜', '良好'], [80, '💤', '优秀'], [100, '💤', '优秀']]) {
    indices.sleep.score = score;
    assert.equal(presentation.renderStatusSignature(indices, now), `❔ 状态暂无｜${emoji} 睡眠${label}(${score}分)｜同步时间: 暂无｜详情 ↗`);
  }
});

test('shows the scoring HRV beside every pressure category rather than an unrelated latest sample', () => {
  const now = Date.parse('2026-10-21T02:00:00Z');
  const indices = { features: { hrv: { current: 99 } }, pressure: {
    score: 50, evidenceAt: now - 60000, evidence: { hrv: 45.56 },
  }, sleep: { date: '2026-10-21', score: 88 } };
  for (const [score, heading] of [[0, '🌟 状态优秀'], [25, '🌟 状态优秀'], [26, '🌿 状态正常'],
    [60, '🌿 状态正常'], [61, '⚡ 注意压力'], [80, '⚡ 注意压力'], [81, '🚨 压力过载'], [100, '🚨 压力过载']]) {
    indices.pressure.score = score;
    assert.equal(presentation.renderStatusSignature(indices, now),
      `${heading}(HRV 45.6)｜💤 睡眠优秀(88分)｜同步时间: 暂无｜详情 ↗`);
  }
});

test('missing or invalid scoring HRV stays unavailable instead of borrowing a different measurement', () => {
  const now = Date.parse('2026-10-21T02:00:00Z');
  const indices = { features: { hrv: { current: 99 } }, pressure: { score: 50, evidence: {} } };
  for (const hrv of [undefined, null, NaN, Infinity, 0, -1]) {
    indices.pressure.evidence.hrv = hrv;
    assert.equal(presentation.renderStatusSignature(indices, now),
      '🌿 状态正常(HRV 暂无)｜🛏️ 睡眠暂无｜同步时间: 暂无｜详情 ↗');
  }
  indices.pressure = { score: null, reason: 'short_baseline', hrvBaseline: { days: 0 }, heartBaseline: { days: 0 } };
  assert.equal(presentation.renderStatusSignature(indices, now),
    '⏳ 状态数据积累中｜🛏️ 睡眠暂无｜同步时间: 暂无｜详情 ↗');
});

test('shows daily step icons and the actual received time instead of pressure measurement time or current time', () => {
  const now = Date.parse('2026-10-21T02:00:00Z'), syncedAt = now - 37 * 60000;
  const indices = { features: { hrv: {} }, pressure: { score: 50, evidenceAt: now - 2 * 3600000, evidence: { hrv: 45 } },
    sleep: { date: '2026-10-21', score: 84 }, displayedHeart: { value: 65, measuredAt: now - 8 * 60000 } };
  const activity = { steps: { value: 1093, label: '手表今日' }, workouts: { minutes: null, reason: 'no_records' } };
  assert.equal(presentation.renderStatusSignature(indices, now, activity, syncedAt),
    '🌿 状态正常(HRV 45)｜💤 睡眠优秀(84分)｜❤️ 心率65｜🪑 今日1093步｜同步时间: 10/21 09:23｜详情 ↗');
  activity.steps.label = '手机今日';
  assert.match(presentation.renderStatusSignature(indices, now, activity, syncedAt), /｜🪑 今日1093步｜/);
  assert.match(presentation.renderStatusSignature(indices, now + 60000, activity, syncedAt), /同步时间: 10\/21 09:23｜/);
});

test('does not present missing, invalid or another day sleep score as today', () => {
  const now = Date.parse('2026-10-20T16:00:00Z'); // Beijing midnight, already October 21.
  const indices = { features: { hrv: {} }, pressure: { score: null, reason: 'missing_hrv' } };
  for (const sleep of [undefined, { date: '2026-10-21', score: null },
    { date: '2026-10-20', score: 88 }, { date: '2026-10-22', score: 88 },
    { date: '2026-10-21', score: 101 }, { date: '2026-10-21', score: -1 }]) {
    indices.sleep = sleep;
    assert.equal(presentation.renderStatusSignature(indices, now), '❔ 状态暂无｜🛏️ 睡眠暂无｜同步时间: 暂无｜详情 ↗');
  }
});

test('labels night and retained evidence without presenting them as a current measurement', () => {
  assert.equal(typeof presentation.renderStatusSignature, 'function');
  const now = Date.parse('2026-10-20T08:00:00Z'), evidenceAt = now - 8 * 3600000;
  const indices = { ruleVersion: 'rule', features: { hrv: { method: 'SDNN' } }, pressure: {
    score: 50, context: 'nightly', evidenceAt, source: 'watch', hrvBaseline: { days: 3 }, heartBaseline: { days: 3 },
    evidence: { hrv: 60 },
  } };
  assert.equal(presentation.renderStatusSignature(indices, now), '🌿 夜间状态正常(HRV 60)｜🛏️ 睡眠暂无｜同步时间: 暂无｜详情 ↗');
  indices.lastValidPressure = { ruleVersion: 'rule', source: 'watch', evidenceAt, score: 50, context: 'nightly', hrv: 58.2 };
  indices.pressure.score = null; indices.pressure.reason = 'expired_hrv';
  assert.equal(presentation.renderStatusSignature(indices, now), '🌿 上次状态正常(HRV 58.2)｜🛏️ 睡眠暂无｜同步时间: 暂无｜详情 ↗');
  delete indices.lastValidPressure.hrv;
  assert.equal(presentation.renderStatusSignature(indices, now), '🌿 上次状态正常(HRV 暂无)｜🛏️ 睡眠暂无｜同步时间: 暂无｜详情 ↗');
});

test('separates stale heart measurement time from pressure time and does not invent missing daily data', () => {
  const now = Date.parse('2026-10-20T08:00:00Z');
  const indices = { ruleVersion: 'rule', features: { hrv: {} }, pressure: {
    score: null, reason: 'missing_hrv', hrvBaseline: { days: 0 }, heartBaseline: { days: 0 },
  }, displayedHeart: { value: 55, measuredAt: now-2*3600000 } };
  const activity = { steps: { value: null }, workouts: { minutes: null, reason: 'no_records' } };
  assert.equal(presentation.renderStatusSignature(indices, now, activity),
    '❔ 状态暂无｜🛏️ 睡眠暂无｜💙 上次心率55｜👣 今日步数暂无｜同步时间: 暂无｜详情 ↗');
  indices.displayedHeart = null;
  activity.steps = { value: 0, label: '手机今日' }; activity.workouts = { minutes: 0, durationSeconds: 30 };
  assert.equal(presentation.renderStatusSignature(indices, now, activity),
    '❔ 状态暂无｜🛏️ 睡眠暂无｜🤍 心率暂无｜🪑 今日0步｜同步时间: 暂无｜详情 ↗');
});

test('heart icons follow displayed numeric intervals and omit the rate unit', () => {
  const now = Date.parse('2026-10-21T02:00:00Z');
  const indices = { features: { hrv: {} }, pressure: { score: null, reason: 'missing_hrv' } };
  const activity = { steps: { value: 0 } };
  for (const [value, icon, displayed] of [[45, '💙', 45], [59, '💙', 59], [59.5, '❤️', 60],
    [60, '❤️', 60], [99, '❤️', 99], [99.5, '💓', 100], [100, '💓', 100],
    [139, '💓', 139], [139.5, '🔥', 140], [140, '🔥', 140], [180, '🔥', 180]]) {
    indices.displayedHeart = { value, measuredAt: now - 60000 };
    const title = presentation.renderStatusSignature(indices, now, activity);
    assert.ok(title.split('｜').includes(`${icon} 心率${displayed}`));
    assert.doesNotMatch(title, /次\/分|bpm/);
  }
});

test('step icons use non-overlapping intervals matching the displayed count', () => {
  const now = Date.parse('2026-10-21T02:00:00Z');
  const indices = { features: { hrv: {} }, pressure: { score: null, reason: 'missing_hrv' } };
  for (const [value, icon, displayed] of [[0, '🪑', 0], [1, '🪑', 1], [2999, '🪑', 2999],
    [2999.5, '🚶', 3000], [3000, '🚶', 3000], [7999, '🚶', 7999],
    [7999.5, '🏃', 8000], [8000, '🏃', 8000], [11999, '🏃', 11999],
    [11999.5, '🏅', 12000], [12000, '🏅', 12000], [20000, '🏅', 20000]]) {
    const title = presentation.renderStatusSignature(indices, now, { steps: { value } });
    assert.ok(title.split('｜').includes(`${icon} 今日${displayed}步`));
  }
});

test('workout text is present only for a known cumulative duration of at least ten minutes', () => {
  const now = Date.parse('2026-10-21T02:00:00Z');
  const indices = { features: { hrv: {} }, pressure: { score: null, reason: 'missing_hrv' } };
  for (const workouts of [undefined, { minutes: null, reason: 'no_records' },
    { minutes: null, reason: 'overlapping_workouts' }, { minutes: NaN },
    { minutes: 0, durationSeconds: 30 }, { minutes: 1, durationSeconds: 60 },
    { minutes: 9, durationSeconds: 599 }, { minutes: 9.99 }]) {
    assert.doesNotMatch(presentation.renderStatusSignature(indices, now, { workouts }), /今日锻炼/);
  }
  for (const minutes of [10, 11, 30]) {
    const title = presentation.renderStatusSignature(indices, now, { workouts: { minutes, durationSeconds: minutes * 60 } });
    assert.ok(title.split('｜').includes(`💪 今日锻炼${minutes}分`));
  }
});
