import test from 'node:test';
import assert from 'node:assert/strict';
import { PressureHistory } from './pressure-history.mjs';
import { testSql } from './sql-test-helper.mjs';
const H = 3600000, NOW = Date.parse('2026-10-02T15:00:00+08:00');
const decision = (t, score = 50, context = 'awake_sample', ruleVersion = 'v1') => ({ ruleVersion, evaluatedAt: NOW,
  pressure: { evidenceAt: t, score, context, source: 'Watch', confidence: 'short_baseline' } });
test('latest retained pressure matches the rule and device and survives restart', () => {
  const sql = testSql(), h = new PressureHistory(sql);
  h.record(decision(NOW - 26 * H, 45), NOW);
  h.record(decision(NOW - H, 90, 'awake_sample', 'old'), NOW);
  h.record({ ...decision(NOW - H), pressure: { ...decision(NOW - H).pressure, source: 'Other' } }, NOW);
  h.record(decision(NOW + H, 80), NOW);
  const restarted = new PressureHistory(sql);
  const last = restarted.latest(NOW, 'v1', 'Watch');
  assert.equal(last.score, 45);
  assert.equal(last.evidenceAt, NOW - 26 * H);
  assert.equal(last.context, 'awake_sample');
  assert.equal(restarted.latest(NOW, 'v1', null), null);
  assert.equal(restarted.latest(NOW + 8 * 24 * H, 'v1', 'Watch')?.score, 80);
  assert.equal(restarted.latest(NOW + 36 * 24 * H, 'v1', 'Watch'), null);
  h.record({ ...decision(NOW - 26 * H), pressure: { ...decision(NOW - 26 * H).pressure,
    score: null, reason: 'sleep_or_workout' } }, NOW);
  assert.equal(restarted.latest(NOW, 'v1', 'Watch'), null);
});
test('received-record replay is marked separately and cannot relabel a live observation', () => {
  const h = new PressureHistory(testSql()), t = NOW - H;
  h.record(decision(t), NOW, 'received_records_replay');
  let point = h.view(NOW, '24h').points[0];
  assert.equal(point.basis, 'received_records_replay');
  assert.equal(point.recordedAt, NOW);
  h.record(decision(t, 55), NOW + 60000);
  point = h.view(NOW + 60000, '24h').points[0];
  assert.equal(point.basis, 'live');
  h.record(decision(t, 55), NOW + 120000, 'received_records_replay');
  assert.equal(h.view(NOW + 120000, '24h').points[0].basis, 'live');
});

test('existing pressure rows migrate with their original times and live provenance', () => {
  const sql = testSql();
  sql.exec(`CREATE TABLE pressure_observations (
    rule TEXT NOT NULL, context TEXT NOT NULL, evidence_at REAL NOT NULL, source TEXT NOT NULL,
    score REAL NOT NULL, confidence TEXT, recorded_at REAL NOT NULL, evaluated_at REAL NOT NULL,
    PRIMARY KEY(rule,context,evidence_at,source))`);
  sql.exec('INSERT INTO pressure_observations VALUES(?,?,?,?,?,?,?,?)', 'v1', 'awake_sample', NOW - H, 'Watch', 50, 'short_baseline', NOW, NOW);
  const h = new PressureHistory(sql), point = h.view(NOW, '24h').points[0];
  assert.equal(point.basis, 'live');
  assert.equal(point.recordedAt, NOW);
  assert.equal(point.score, 50);
  assert.equal(new PressureHistory(sql).view(NOW, '24h').points.length, 1);
  // The old eight-column writer must remain usable after upgrade/rollback.
  sql.exec('INSERT INTO pressure_observations VALUES(?,?,?,?,?,?,?,?)', 'v1', 'awake_sample', NOW - 2 * H, 'Watch', 40, 'short_baseline', NOW, NOW);
  const upgradedAgain = new PressureHistory(sql);
  upgradedAgain.record(decision(NOW - 2 * H, 45), NOW + 60000, 'received_records_replay');
  assert.equal(upgradedAgain.view(NOW + 60000, '24h').points[0].basis, 'live');
});

test('repeated evaluation updates one observation and preserves first recording time', () => {
  const h = new PressureHistory(testSql());
  h.record(decision(NOW - H), NOW);
  h.record(decision(NOW - H, 70), NOW + 600000);
  const rows = h.view(NOW + H, '24h');
  assert.equal(rows.points.length, 1);
  assert.equal(rows.points[0].score, 70);
  assert.equal(rows.points[0].recordedAt, NOW);
  assert.doesNotMatch(JSON.stringify(rows), /Watch/);
});
test('daily summary separates nights, preserves missing days and counts observations not refreshes', () => {
  const h = new PressureHistory(testSql());
  for (const [offset, score] of [[4, 20], [3, 50], [2, 80]]) h.record(decision(NOW - offset * H, score), NOW);
  h.record(decision(NOW - 8 * H, 99, 'nightly'), NOW);
  const view = h.view(NOW, '7d');
  const d = view.days.at(-1);
  assert.equal(d.count, 3); assert.equal(d.median, 50); assert.equal(d.q1, 35); assert.equal(d.q3, 65);
  assert.equal(d.highFraction, 1 / 3); assert.equal(d.spanMinutes, 120); assert.equal(d.status, 'available');
  assert.equal(d.partial, true); assert.equal(view.nights.length, 1); assert.equal(view.days.length, 8);
  assert.equal(view.days[0].status, 'missing'); assert.equal(view.days[0].median, null);
});
test('short coverage and mixed rules never produce daily scores', () => {
  const h = new PressureHistory(testSql());
  h.record(decision(NOW - H), NOW);
  assert.equal(h.view(NOW, '24h').days.at(-1).status, 'insufficient_samples');
  h.record(decision(NOW - 2 * H, 70, 'awake_sample', 'v2'), NOW);
  assert.equal(h.view(NOW, '24h').days.at(-1).status, 'mixed_rules');
  assert.equal(h.view(NOW, '24h').days.at(-1).median, null);
});

test('daily summaries retain short-baseline confidence when any included score is provisional', () => {
 const h = new PressureHistory(testSql());
 for (const [i, confidence] of ['personal_baseline', 'short_baseline', 'personal_baseline'].entries()) {
  const d = decision(NOW - (4 - i) * H);
  d.pressure.confidence = confidence;
  h.record(d, NOW);
 }
 const summary = h.view(NOW, '24h').days.at(-1);
 assert.equal(summary.status, 'available');
 assert.equal(summary.confidence, 'short_baseline');
});
test('daily scores never mix device epochs even when the rule is unchanged', () => {
  const h = new PressureHistory(testSql());
  for (const [offset, source] of [[4, 'hae-profile:old'], [3, 'hae-profile:new'], [2, 'hae-profile:new']]) {
    const d = decision(NOW - offset * H); d.pressure.source = source; h.record(d, NOW);
  }
  const mixed = h.view(NOW, '24h');
  assert.equal(mixed.days.at(-1).status, 'mixed_sources');
  assert.equal(mixed.days.at(-1).median, null);
  assert.equal(mixed.points[0].source, undefined);
});
test('expiry retains historical points but corrected invalid evidence removes its observation', () => {
  const h = new PressureHistory(testSql()); const d = decision(NOW - H);
  h.record(d, NOW);
  h.record({ ...d, pressure: { ...d.pressure, score: null, reason: 'expired_hrv' } }, NOW + 7 * H);
  assert.equal(h.view(NOW + 7 * H, '24h').points.length, 1);
  h.record({ ...d, pressure: { ...d.pressure, score: null, reason: 'source_or_sample_conflict' } }, NOW);
  assert.equal(h.view(NOW, '24h').points.length, 0);
});
test('observations survive restart and prune at 35 days without resetting collection start', () => {
  const sql = testSql(); const h = new PressureHistory(sql);
  h.record(decision(NOW), NOW);
  const restarted = new PressureHistory(sql);
  assert.equal(restarted.view(NOW, '24h').points.length, 1);
  restarted.record(decision(NOW + 36 * 24 * H), NOW + 36 * 24 * H);
  assert.equal(sql.exec('SELECT COUNT(*) AS n FROM pressure_observations').one().n, 1);
  assert.equal(restarted.view(NOW + 36 * 24 * H, '24h').since, NOW);
});
test('a corrected unavailable night is withdrawn but natural nightly expiry is retained', () => {
 const h = new PressureHistory(testSql()), d = decision(NOW - 2 * H, 50, 'nightly');
 h.record(d, NOW);
 h.record({ ...d, pressure: { ...d.pressure, score: null }, nightlyEvidence: { evidenceAt: d.pressure.evidenceAt, status: 'expired' } }, NOW);
 assert.equal(h.view(NOW, '24h').nights.length, 1);
 h.record({ ...d, pressure: { ...d.pressure, score: null }, nightlyEvidence: { evidenceAt: d.pressure.evidenceAt, status: 'unavailable' } }, NOW);
 assert.equal(h.view(NOW, '24h').nights.length, 0);
});
test('insufficient RMSSD window withdraws its previous observation, without altering SDNN history', () => {
 const h = new PressureHistory(testSql());
 const old = decision(NOW - H, 70, 'awake_sample', 'health-indices-v3-nightly');
 const latest = decision(NOW - H, 50, 'awake_sample', 'health-indices-v4-rmssd');
 h.record(old, NOW); h.record(latest, NOW);
 h.record({ ...latest, pressure: { ...latest.pressure, score: null, reason: 'insufficient_samples' } }, NOW);
 const rows = h.view(NOW, '24h').points;
 assert.equal(rows.length, 1); assert.equal(rows[0].ruleVersion, 'health-indices-v3-nightly');
});
