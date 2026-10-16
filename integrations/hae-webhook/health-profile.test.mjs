import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHealthIndices } from './health-indices.mjs';
import { healthProfile } from './health-profile.mjs';
const HOUR = 3600000, DAY = 24 * HOUR, now = Date.parse('2026-10-10T10:00:00+08:00');
const profile = { id: 'new-watch', since: now - 2 * DAY, reportedSource: 'Watch' };
const series = () => ({ hrv: Array.from({ length: 6 }, (_, d) => ({ start: now - d * DAY,
  end: now - d * DAY, value: 60, method: 'SDNN', source: 'Watch' })),
  heart: Array.from({ length: 6 }, (_, d) => ({ start: now - d * DAY, end: now - d * DAY + 60000,
    value: 60, source: 'Watch' })), sleep: [], workout: [] });

test('a declared device epoch prevents same-name old hardware from filling a new baseline', () => {
  const result = evaluateHealthIndices(series(), now + 60000, null, { profile });
  assert.equal(result.pressure.hrvBaseline.days, 2);
  assert.equal(result.pressure.score, null);
  assert.equal(result.pressure.deviceEpoch, profile.id);
});

test('explicit exporter scope can pair source-less heart without rewriting stored provenance', () => {
  const input = series(); input.heart.forEach(r => { r.source = 'unknown'; });
  const before = structuredClone(input);
  const configured = { ...profile, since: now - 6 * DAY };
  const result = evaluateHealthIndices(input, now + 60000, null, { profile: configured });
  assert.equal(result.pressure.score, 50);
  assert.equal(result.pressure.sourceBasis, 'configured_exporter');
  assert.equal(result.displayedHeart.source, 'unknown');
  assert.deepEqual(input, before);
  assert.equal(evaluateHealthIndices(input, now + 60000).pressure.score, null, 'no implicit trust without profile');
});

test('a different reported source cannot acquire the configured exporter scope', () => {
  const input = series(); input.hrv[0].source = 'Other Watch';
  const result = evaluateHealthIndices(input, now + 60000, null, { profile: { ...profile, since: now - 6 * DAY } });
  assert.equal(result.pressure.score, null);
  assert.equal(result.pressure.reason, 'source_or_sample_conflict');
});
test('exporter scope requires a complete explicit configuration', () => {
  assert.equal(healthProfile({}), null);
  assert.throws(() => healthProfile({ HEALTH_DEVICE_PROFILE: 'new-watch' }), /invalid health device profile/);
  assert.throws(() => healthProfile({ HEALTH_DEVICE_PROFILE: 'new-watch', HEALTH_DEVICE_EPOCH_START: 'invalid',
    HEALTH_REPORTED_SOURCE: 'Watch' }), /invalid health device profile/);
  assert.deepEqual(healthProfile({ HEALTH_DEVICE_PROFILE: 'new-watch',
    HEALTH_DEVICE_EPOCH_START: new Date(profile.since).toISOString(), HEALTH_REPORTED_SOURCE: 'Watch' }), profile);
});
test('minute RMSSD and source-less HR use only the declared new device epoch', () => {
  const input = { hrv: [], heart: [], sleep: [], workout: [] };
  for (let d = 0; d <= 9; d++) {
    for (let i = 0; i < 3; i++) input.hrv.push({ start: now - d * DAY - i * 5 * 60000,
      end: now - d * DAY - i * 5 * 60000 + 60000, value: 40, method: 'RMSSD', source: 'unknown', aggregation: 'minutes' });
    for (let i = 0; i < 20; i++) input.heart.push({ start: now - d * DAY - i * 60000,
      end: now - d * DAY - i * 60000 + 60000, value: 60, source: 'unknown' });
  }
  const wider = evaluateHealthIndices(input, now + 60000, null, { profile: { ...profile, since: now - 10 * DAY } });
  assert.equal(wider.pressure.score, 50);
  const fresh = evaluateHealthIndices(input, now + 60000, wider, { profile });
  assert.equal(fresh.features.hrv.method, 'RMSSD');
  // Only the epoch's own days count toward the seven-day baseline.
  assert.equal(fresh.pressure.hrvBaseline.days, 1);
  assert.equal(fresh.pressure.score, null);
  assert.equal(fresh.pressure.reason, 'short_baseline');
  assert.match(fresh.title, /恢复HRV40 心率60/);
  assert.match(fresh.title, /^压力积累中 /); assert.doesNotMatch(fresh.title, /待评估|待更新/);
  const matured = evaluateHealthIndices(input, now + 60000, wider, { profile: { ...profile, since: now - 7 * DAY - HOUR } });
  assert.equal(matured.pressure.hrvBaseline.days, 7);
  assert.equal(matured.pressure.score, 50);
  assert.equal(matured.pressure.confidence, 'short_baseline');
  const firstDay = evaluateHealthIndices(input, now + 60000, fresh, { profile: { ...profile, since: now - HOUR } });
  assert.equal(firstDay.pressure.hrvBaseline.days, 0);
  assert.equal(firstDay.pressure.score, null);
  assert.equal(firstDay.pressure.reason, 'short_baseline');
});
