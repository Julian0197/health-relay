import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOverviewCard } from './overview-card.mjs';
import { buildWorkoutHistory } from './workouts.mjs';
const now = Date.parse('2026-09-24T04:00:00Z'), DAY = 86400000;
const walk = node => [node, ...(node.body?.elements ?? node.elements ?? node.columns ?? []).flatMap(walk)];
const chart = card => walk(card).find(n => n.tag === 'chart').chart_spec.data.values;
const workout = (overrides = {}) => ({ name: 'Running', start: now - 2 * 3600000, end: now - 3600000,
  durationMs: 3600000, activeEnergyKcal: 300, heart: { avg: 125, max: 150 }, ...overrides });
const make = (records, extra = {}, options = {}) => buildOverviewCard({ workoutHistory: { records }, ...extra }, { now, syncedAt: now, ...options });

test('retained pressure keeps its evidence date while yesterday sleep becomes a dash', () => {
  const card = make([], { healthIndices: { pressure: { score: 64, evidenceAt: now - DAY, retained: true, confidence: 'short_baseline' },
    sleep: { score: 80, date: '2026-09-23' } }, sleep: [{ date: '2026-09-23', asleepMinutes: 480 }],
  heart: { latest: { value: 62, start: now - 60000 } }, recoveryHrv: { value: 34, start: now - 3600000 } });
  const text = JSON.stringify(card);
  assert.match(text, /09-23 12:00 · 短期基线/);
  assert.match(card.config.summary.content, /睡眠 -/);
  assert.match(text, /今日暂无睡眠记录/);
  assert.match(text, /09-24 11:59 · 窗口均值/);
  assert.match(text, /09-24 11:00 · RMSSD/);
  assert.doesNotMatch(text, /评分已过期|新版预览|\*\*80\*\*/);
});

test('chart uses seven Beijing calendar days and includes exactly twenty minutes, all sports and unit conversion', () => {
  const records = buildWorkoutHistory({ workout: [
    workout({ name: 'Swimming', durationMs: 20 * 60000, activeEnergyKcal: null, details: ['活动能量 418.4 kJ'] }),
    workout({ start: now - DAY, end: now - DAY + 19 * 60000, durationMs: 19 * 60000, activeEnergyKcal: 999 }),
    workout({ start: now - 7 * DAY, end: now - 7 * DAY + 3600000 }),
  ] }, now).records;
  const card = make(records);
  assert.deepEqual(chart(card), Array.from({ length: 7 }, (_, i) => ({ day: `09/${18 + i}`, kcal: i === 6 ? 100 : null })));
  assert.match(JSON.stringify(card), /游泳/);
  assert.doesNotMatch(JSON.stringify(card), /999/);
});

test('partial energy and overlapping records leave gaps; latest ending workout wins', () => {
  const records = [workout({ durationMs: 30 * 60000, end: now - 90 * 60000 }), workout({ activeEnergyKcal: null }),
    workout({ start: now - DAY, end: now - DAY + 3600000, activeEnergyKcal: 200 }),
    workout({ start: now - DAY + 7200000, end: now - DAY + 10800000, activeEnergyKcal: null })];
  const card = make(records), text = JSON.stringify(card);
  assert.match(text, /60 分钟/);
  assert.match(text, /记录重叠/);
  assert.match(text, /热量缺失/);
  assert.ok(chart(card).every(d => d.kcal === null));
});

test('empty metrics never become zero and text cannot inject links or mentions', () => {
  const card = make([workout({ name: '<at id=all>[click](https://evil.test)', activeEnergyKcal: null, heart: null })], {},
    { dashboardUrl: 'javascript:alert(1)', deviceLabel: '<at id=all>' });
  const text = JSON.stringify(card);
  assert.doesNotMatch(text, /<at|javascript:|open_url|\*\*0/);
  assert.match(text, /&#60;at/);
  assert.match(text, /恢复心率未同步/);
});

test('approved HTTPS detail link is optional and sync receipt is the only transport-time content', () => {
  const data = { workoutHistory: { records: [workout()] } };
  const a = buildOverviewCard(data, { now, syncedAt: 0, dashboardUrl: 'https://example.com/health' });
  const b = buildOverviewCard(data, { now: now + 60000, syncedAt: 0, dashboardUrl: 'https://example.com/health' });
  assert.deepEqual(a, b);
  assert.equal(walk(a).find(n => n.tag === 'button').behaviors[0].default_url, 'https://example.com/health');
  assert.ok(!walk(make([])).some(n => n.tag === 'button'));
});
