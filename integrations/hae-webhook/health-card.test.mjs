import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeHealth, buildHealthCard } from './health-card.mjs';

const date = '2026-09-23 17:00:00 +0800';
const metric = (name, units, data) => ({ name, units, data });

test('all eight metric groups are represented with units and record times', () => {
  const metrics = [
    metric('heart_rate', 'bpm', [{ date, Avg: 72, Min: 61, Max: 89 }]),
    metric('resting_heart_rate', 'count/min', [{ date, qty: 60 }]),
    metric('heart_rate_variability', 'ms', [{ date, qty: 45 }]),
    metric('step_count', 'count', [{ date, qty: 1200 }]),
    metric('active_energy', 'kcal', [{ date, qty: 80 }]),
    metric('apple_exercise_time', 'min', [{ date, qty: 15 }]),
    metric('respiratory_rate', 'count/min', [{ date, qty: 14 }]),
    metric('sleep_analysis', 'hr', [{ date: '2026-09-23', totalSleep: 7.5, core: 4, deep: 1, rem: 2.5 }]),
  ];
  const summary = summarizeHealth({ data: { metrics } });
  assert.equal(summary.samples, 8);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.metrics.length, 8);
  const card = buildHealthCard(summary, { aggregation: 'hours', period: 'today' });
  const text = JSON.stringify(card);
  assert.equal(card.schema, '2.0');
  assert.match(text, /步数/);
  assert.match(text, /活动能量/);
  assert.match(text, /7 小时 30 分钟/);
  assert.match(text, /09-23 17:00/);
  assert.match(text, /61–89/);
  assert.match(text, /按小时汇总/);
  assert.doesNotMatch(text, /0 次锻炼/);
  assert.doesNotMatch(text, /实时心率|满血|过载|恢复分/);
});

test('invalid records and empty metrics stay visible and unsupported structured fields are counted', () => {
  const summary = summarizeHealth({ data: { metrics: [
    metric('heart_rate', 'bpm', [{ date, qty: 62 }, { date: 'bad', qty: 70 }]),
    metric('sleep_analysis', 'hr', []),
    metric('unknown_structure', 'x', [{ date, nested: { qty: 1 } }]),
    metric('custom_numeric', 'unit', [{ date, qty: 3.5 }]),
  ] } });
  assert.equal(summary.samples, 2);
  assert.equal(summary.skipped, 2);
  assert.deepEqual(summary.metrics.map(m => m.accepted), [1, 0, 0, 1]);
  const text = JSON.stringify(buildHealthCard(summary));
  assert.match(text, /暂缺/);
  assert.doesNotMatch(text, /有效 \d/);
  assert.match(text, /custom&#95;numeric/);
});

test('cumulative values are shown as latest bucket, not summed across dates or sources', () => {
  const summary = summarizeHealth({ data: { metrics: [metric('step_count', 'count', [
    { date: '2026-09-22 17:00:00 +0800', qty: 9000 },
    { date, qty: 1200 },
  ])] } });
  const text = JSON.stringify(buildHealthCard(summary));
  assert.match(text, /1200/);
  assert.doesNotMatch(text, /10200|全天总步数/);
});

test('sleep minutes and raw segments do not become fabricated daily totals', () => {
  const daily = summarizeHealth({ data: { metrics: [metric('sleep_analysis', 'min', [{ date, totalSleep: 450 }])] } });
  assert.match(JSON.stringify(buildHealthCard(daily)), /7 小时 30 分钟/);
  const segments = summarizeHealth({ data: { metrics: [metric('sleep_analysis', 'hr', [
    { startDate: date, endDate: '2026-09-23 17:30:00 +0800', qty: 0.5, value: 'Core' },
  ])] } });
  assert.match(JSON.stringify(buildHealthCard(segments)), /分段/);
  assert.match(JSON.stringify(buildHealthCard(segments)), /30 分钟/);
});

test('workouts v2 preserves seconds, explicit units, and partial optional data', () => {
  const summary = summarizeHealth({ data: { workouts: [{ id: 'fixture-workout', name: 'Running', start: date,
    end: '2026-09-23 17:30:00 +0800', duration: 1800,
    distance: { qty: 4, units: 'km' }, activeEnergyBurned: { qty: 300, units: 'kcal' },
    heartRate: { avg: { qty: 140, units: 'bpm' } },
  }] } });
  assert.equal(summary.workouts.length, 1);
  const text = JSON.stringify(buildHealthCard(summary));
  assert.match(text, /30 分钟/);
  assert.match(text, /4 km/);
  assert.match(text, /140 bpm/);
  assert.doesNotMatch(text, /没有运动/);
});

test('card text cannot inject links or at-all and no missing value is rendered as zero', () => {
  const summary = summarizeHealth({ data: { metrics: [metric('<at id=all>', 'ms', [{ date, qty: 2 }])] } });
  const text = JSON.stringify(buildHealthCard(summary, { aggregation: '<at id=all>' }));
  assert.doesNotMatch(text, /<at|https?:/);
  assert.match(text, /&#60;at/);
});

test('overview shows full date, yesterday marker, daily totals and no parsing jargon', () => {
  const summary = summarizeHealth({ data: { metrics: [
    metric('resting_heart_rate', 'count/min', [{ date: '2026-09-23T06:00:00Z', qty: 54 }]),
    metric('step_count', 'count', [{ date: '2026-09-24', qty: 1200 }]),
  ] } });
  summary.metrics[1].aggregation = 'days';
  const text = JSON.stringify(buildHealthCard(summary, { now: Date.parse('2026-09-24T02:00:00Z'), syncedAt: Date.parse('2026-09-24T01:59:00Z') }));
  assert.match(text, /2026-09-24/);
  assert.match(text, /昨日记录/);
  assert.match(text, /当日累计/);
  assert.match(text, /次\/分/);
  assert.doesNotMatch(text, /有效|解析 \d|聚合粒度未确认/);
});

test('HRV measurement and upload dates are explicitly distinct in the card', () => {
  const card = buildHealthCard({ metrics: [], workouts: [], workoutReceived: null,
    hrvSync: { latestSampleAt: Date.parse('2026-09-27T11:53:46+08:00'), receivedAt: Date.parse('2026-09-27T20:10:04+08:00'),
      stats: { inserted: 0, updated: 0, unchanged: 9 } },
    signatureStatus: { state: 'post_workout', reasons: ['exercise_context'], observation: { windowSamples: 1, windowSpanMinutes: 0 } },
  });
  const text = JSON.stringify(card);
  assert.match(text, /HRV 最新测量：2026-09-27 11:53/);
  assert.match(text, /HRV 最近上传：2026-09-27 20:10/);
  assert.match(text, /本批新增 0 · 修订 0 · 已存在 9 条/);
  assert.match(text, /运动中或结束后一小时/);
  assert.match(text, /合格 HRV 1 条 · 跨度 0 分钟/);
});
