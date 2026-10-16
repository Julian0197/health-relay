// Replays one batch of inputs through a baseline checkout and this checkout's signature logic.
// node signature-replay.mjs <baseline-hae-webhook-dir> [--rule-change] [private-fixture.json ...]
// Without --rule-change, scores must be identical and only text may differ. With it (a new
// ruleVersion), score and reason differences are reported side by side instead.
// A private fixture has the signature-fixture.example.json shape, optionally with
// lastValidPressure and pressureHistory. Synthetic scenarios always run; nothing leaves the machine.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const args = process.argv.slice(2), ruleChange = args.includes('--rule-change');
const [baselineDir, ...fixtures] = args.filter(arg => arg !== '--rule-change');
if (!baselineDir) throw new Error('usage: node signature-replay.mjs <baseline-hae-webhook-dir> [fixture.json ...]');
const load = async dir => ({
  indices: await import(pathToFileURL(resolve(dir, 'health-indices.mjs')).href),
  signature: await import(pathToFileURL(resolve(dir, 'health-signature.mjs')).href),
});
const before = await load(baselineDir), after = await load(new URL('.', import.meta.url).pathname);
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const T = Date.parse('2026-10-14T15:00:00+08:00');
const dateKey = t => new Date(t + 8 * HOUR).toISOString().slice(0, 10);

// Awake RMSSD every 5 minutes with paired minute heart windows, for `days` days ending at `end`.
function series({ end = T, days = 10, source = 'Watch', rmssd = 42, heart = 70, todayRmssd = rmssd, todayHeart = heart } = {}) {
  const s = { hrv: [], heart: [], sleep: [], daily: [], workout: [] };
  for (let t = end - days * DAY; t <= end; t += MINUTE) {
    const hour = new Date(t + 8 * HOUR).getUTCHours();
    if (hour < 8 || hour >= 23) continue;
    const today = dateKey(t) === dateKey(end);
    s.heart.push({ kind: 'heart', start: t, end: t + MINUTE, value: today ? todayHeart : heart + (t / MINUTE) % 3, source });
    if ((t / MINUTE) % 5 === 0) s.hrv.push({ kind: 'hrv', start: t, end: t, method: 'RMSSD', value: today ? todayRmssd : rmssd + (t / MINUTE) % 4, source });
  }
  return s;
}
const ruleOf = after.indices.evaluateHealthIndices(series(), T).ruleVersion;
// Recorded history belongs to the rule that wrote it, so each implementation gets its own.
const retainedAt = (at, score = 30) => rule => ({ ruleVersion: rule, context: 'awake_sample', evidenceAt: at, source: 'Watch', score });
const todayMedian = (median, now = T) => rule => ({ days: [{ date: dateKey(now), status: 'available', ruleVersion: rule, median, count: 12 }] });
const scenarios = [
  { name: 'current result', now: T, series: series() },
  { name: 'current result, stressed', now: T, series: series({ todayRmssd: 22, todayHeart: 92 }) },
  { name: "today's aggregate", now: T, series: series(), pressureHistory: todayMedian(70) },
  { name: 'expired, retained 2 h ago', now: T + 2 * HOUR, series: series(), lastValidPressure: retainedAt(T) },
  { name: 'expired, retained 3 d ago', now: T + 2 * HOUR, series: series(), lastValidPressure: retainedAt(T - 3 * DAY, 75) },
  { name: 'expired, last result 8 d ago', now: T + 2 * HOUR, series: series(), lastValidPressure: retainedAt(T - 8 * DAY) },
  { name: 'retained from another device', now: T + 2 * HOUR, series: series(), lastValidPressure: rule => ({ ...retainedAt(T)(rule), source: 'Other' }) },
  { name: 'baseline building (today only)', now: T, series: series({ days: 0 }) },
  ...[1, 3, 6, 7, 14, 25, 30].map(days => ({ name: `${days} prior days, stressed now`, now: T, series: series({ days, todayRmssd: 30, todayHeart: 80 }) })),
  { name: '10 prior days, sparse heart history', now: T,
    series: (s => ({ ...s, heart: s.heart.filter(r => dateKey(r.start) === dateKey(T) || (r.start / MINUTE) % 30 === 0) }))(series({ days: 10 })) },
  { name: 'missing HRV', now: T, series: { ...series(), hrv: [] } },
  { name: 'source conflict', now: T, series: (s => ({ ...s, hrv: [...s.hrv, { ...s.hrv.at(-1), value: 99, source: 'Phone' }] }))(series()) },
];
for (const file of fixtures) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  scenarios.push({ name: `fixture ${file}`, now: Date.parse(data.now), series: data.series,
    lastValidPressure: data.lastValidPressure && (() => data.lastValidPressure),
    pressureHistory: data.pressureHistory && (() => data.pressureHistory) });
}
// Mirrors HealthStore.refreshSignaturePresentation: attach the recorded result, then render.
const run = (impl, scenario) => {
  const indices = impl.indices.evaluateHealthIndices(structuredClone(scenario.series), scenario.now);
  indices.lastValidPressure = scenario.lastValidPressure?.(indices.ruleVersion) ?? null;
  const history = scenario.pressureHistory?.(indices.ruleVersion) ?? null;
  return { indices, title: impl.signature.renderHealthSignature(indices, scenario.now, history),
    headline: impl.signature.pressureHeadline?.(indices, scenario.now, history) ?? null };
};
const rows = [];
for (const scenario of scenarios) {
  const old = run(before, scenario), next = run(after, scenario);
  // Same inputs: a text version may change only titles; a rule version may change pressure only.
  assert.deepEqual(next.indices.asOfAt, old.indices.asOfAt, `${scenario.name}: asOfAt`);
  assert.deepEqual(next.indices.sleep.score, old.indices.sleep.score, `${scenario.name}: sleep.score`);
  if (!ruleChange) {
    for (const field of ['ruleVersion', 'validUntil']) assert.deepEqual(next.indices[field], old.indices[field], `${scenario.name}: ${field}`);
    for (const field of ['score', 'reason', 'context', 'evidenceAt', 'components']) {
      assert.deepEqual(next.indices.pressure[field], old.indices.pressure[field], `${scenario.name}: pressure.${field}`);
    }
  }
  const p = impl => `${impl.indices.pressure.score ?? '—'}${impl.indices.pressure.reason ? ` (${impl.indices.pressure.reason})` : ''}` +
    ` · 基线 HRV ${impl.indices.pressure.hrvBaseline?.days ?? 0} / HR ${impl.indices.pressure.heartBaseline?.days ?? 0} 天`;
  rows.push({ scenario: scenario.name, score: next.indices.pressure.score ?? '—', reason: next.indices.pressure.reason ?? '—',
    basis: next.headline?.basis ?? '—', changed: old.title !== next.title || p(old) !== p(next), before: old.title, after: next.title,
    pressureBefore: p(old), pressureAfter: p(next) });
}
const oldRule = before.indices.evaluateHealthIndices(series(), T).ruleVersion;
console.log(`Text ${before.indices.evaluateHealthIndices(series(), T).textVersion ?? 'health-signature-text-v1'} -> ${after.signature.SIGNATURE_TEXT_VERSION}; rule ${oldRule} -> ${ruleOf}.`);
for (const row of rows) {
  console.log(`\n${row.changed ? '≠' : '='} ${row.scenario} · basis ${row.basis}`);
  if (ruleChange) console.log(`  pressure: ${row.pressureBefore}${row.pressureBefore !== row.pressureAfter ? `  ->  ${row.pressureAfter}` : ''}`);
  console.log(`  before: ${row.before}`);
  if (row.before !== row.after) console.log(`  after:  ${row.after}`);
}
console.log(`\n${rows.filter(r => r.changed).length}/${rows.length} changed; ${ruleChange
  ? 'measurement times and sleep identical; pressure differences listed above.'
  : 'scores, reasons, rule versions and validity identical.'}`);
