// Replays one batch of inputs through a baseline checkout and this checkout's signature logic.
// node signature-replay.mjs <baseline-hae-webhook-dir> [private-fixture.json ...]
// A private fixture has the signature-fixture.example.json shape, optionally with
// lastValidPressure and pressureHistory. Synthetic scenarios always run; nothing leaves the machine.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [baselineDir, ...fixtures] = process.argv.slice(2);
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
function series({ end = T, days = 4, source = 'Watch', rmssd = 42, heart = 70, todayRmssd = rmssd, todayHeart = heart } = {}) {
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
const retainedAt = (at, score = 30) => ({ ruleVersion: ruleOf, context: 'awake_sample', evidenceAt: at, source: 'Watch', score });
const todayMedian = (median, now = T) => ({ days: [{ date: dateKey(now), status: 'available', ruleVersion: ruleOf, median, count: 12 }] });
const scenarios = [
  { name: 'current result', now: T, series: series() },
  { name: 'current result, stressed', now: T, series: series({ todayRmssd: 22, todayHeart: 92 }) },
  { name: "today's aggregate", now: T, series: series(), pressureHistory: todayMedian(70) },
  { name: 'expired, retained 2 h ago', now: T + 2 * HOUR, series: series(), lastValidPressure: retainedAt(T) },
  { name: 'expired, retained 3 d ago', now: T + 2 * HOUR, series: series(), lastValidPressure: retainedAt(T - 3 * DAY, 75) },
  { name: 'expired, last result 8 d ago', now: T + 2 * HOUR, series: series(), lastValidPressure: retainedAt(T - 8 * DAY) },
  { name: 'retained from another device', now: T + 2 * HOUR, series: series(), lastValidPressure: { ...retainedAt(T), source: 'Other' } },
  { name: 'baseline building (today only)', now: T, series: series({ days: 0 }) },
  { name: 'missing HRV', now: T, series: { ...series(), hrv: [] } },
  { name: 'source conflict', now: T, series: (s => ({ ...s, hrv: [...s.hrv, { ...s.hrv.at(-1), value: 99, source: 'Phone' }] }))(series()) },
];
for (const file of fixtures) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  scenarios.push({ name: `fixture ${file}`, now: Date.parse(data.now), series: data.series,
    lastValidPressure: data.lastValidPressure, pressureHistory: data.pressureHistory });
}
// Mirrors HealthStore.refreshSignaturePresentation: attach the recorded result, then render.
const run = (impl, scenario) => {
  const indices = impl.indices.evaluateHealthIndices(structuredClone(scenario.series), scenario.now);
  indices.lastValidPressure = scenario.lastValidPressure ?? null;
  return { indices, title: impl.signature.renderHealthSignature(indices, scenario.now, scenario.pressureHistory ?? null),
    headline: impl.signature.pressureHeadline?.(indices, scenario.now, scenario.pressureHistory ?? null) ?? null };
};
const rows = [];
for (const scenario of scenarios) {
  const old = run(before, scenario), next = run(after, scenario);
  // Same inputs, same scorer: only the text may differ between text versions.
  for (const field of ['ruleVersion', 'validUntil', 'asOfAt']) assert.deepEqual(next.indices[field], old.indices[field], `${scenario.name}: ${field}`);
  for (const field of ['score', 'reason', 'context', 'evidenceAt', 'components']) {
    assert.deepEqual(next.indices.pressure[field], old.indices.pressure[field], `${scenario.name}: pressure.${field}`);
  }
  assert.deepEqual(next.indices.sleep.score, old.indices.sleep.score, `${scenario.name}: sleep.score`);
  rows.push({ scenario: scenario.name, score: next.indices.pressure.score ?? '—', reason: next.indices.pressure.reason ?? '—',
    basis: next.headline?.basis ?? '—', changed: old.title !== next.title, before: old.title, after: next.title });
}
console.log(`Text ${before.indices.evaluateHealthIndices(series(), T).textVersion ?? 'health-signature-text-v1'} -> ${after.signature.SIGNATURE_TEXT_VERSION}; rule ${ruleOf} unchanged.`);
for (const row of rows) {
  console.log(`\n${row.changed ? '≠' : '='} ${row.scenario} · score ${row.score} · reason ${row.reason} · basis ${row.basis}`);
  console.log(`  before: ${row.before}`);
  if (row.changed) console.log(`  after:  ${row.after}`);
}
console.log(`\n${rows.filter(r => r.changed).length}/${rows.length} titles changed; scores, reasons, rule versions and validity identical.`);
