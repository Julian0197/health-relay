import { evaluateHealthIndices } from './health-indices.mjs';
import { renderStatusSignature, STATUS_SIGNATURE_TEXT_VERSION } from './health-signature.mjs';
import { summarizeNativeActivity } from './native-activity.mjs';
const DAY = 86400000;
export const nativeError = (message, status = 422) => { throw Object.assign(new Error(message), { status }); };
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const stamp = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
export const nativeIdentity = row => JSON.stringify([row.typeIdentifier, row.recordId]);
const stages = ['in_bed', 'asleep', 'awake', 'core', 'deep', 'rem'];
const dailyMetrics = { RestingHeartRate: ['resting_heart_rate', ['count/min', 'bpm']],
  StepCount: ['step_count', ['count']], ActiveEnergyBurned: ['active_energy', ['kcal']],
  BasalEnergyBurned: ['basal_energy_burned', ['kcal']], AppleExerciseTime: ['apple_exercise_time', ['min']],
  AppleStandTime: ['apple_stand_time', ['min']], RespiratoryRate: ['respiratory_rate', ['count/min']],
  OxygenSaturation: ['blood_oxygen_saturation', ['%']] };
export function normalizeNativeRecord(row) {
  if (row.op === 'delete') return null;
  const start = stamp(row.start), end = stamp(row.end), payload = row.payload;
  const base = { id: row.recordId, source: row.source.id, start, end };
  const type = row.typeIdentifier.replace('HKQuantityTypeIdentifier', '');
  const numeric = () => { if (!Number.isFinite(payload.value) || payload.value < 0) nativeError('invalid_quantity'); };
  if (type === 'HeartRateVariabilitySDNN') {
    numeric(); if (!['ms', 's'].includes(payload.unit) || payload.value <= 0) nativeError('invalid_hrv');
    return { ...base, kind: 'hrv', value: payload.value * (payload.unit === 's' ? 1000 : 1), unit: 'ms', method: 'SDNN' };
  }
  if (type === 'HeartRate') {
    numeric(); if (!['count/min', 'bpm'].includes(payload.unit) || payload.value <= 0) nativeError('invalid_heart_rate');
    return { ...base, kind: 'heart', value: payload.value, unit: 'bpm' };
  }
  if (row.typeIdentifier === 'HKCategoryTypeIdentifierSleepAnalysis') {
    if (!Number.isInteger(payload.value) || !stages[payload.value] || end <= start || end-start > 48*3600000) nativeError('invalid_sleep');
    return { ...base, kind: 'sleep', stage: stages[payload.value] };
  }
  if (dailyMetrics[type]) {
    numeric(); const [metric, units] = dailyMetrics[type];
    if (!units.includes(payload.unit)) nativeError('invalid_daily_unit');
    return { ...base, kind: 'daily', metric, value: payload.value, unit: payload.unit,
      sum: ['StepCount', 'ActiveEnergyBurned', 'BasalEnergyBurned', 'AppleExerciseTime', 'AppleStandTime'].includes(type) };
  }
  if (row.typeIdentifier === 'HKWorkoutType') {
    if (end < start) nativeError('invalid_workout');
    let liveHeart = null;
    if (payload.live !== undefined) {
      const live = payload.live, heart = live?.heartRate;
      if (live?.version !== 1 || !['running', 'paused', 'ended'].includes(live.state) ||
        !Number.isFinite(payload.durationSeconds) || payload.durationSeconds < 0 || payload.durationSeconds > (end-start)/1000+1) nativeError('invalid_live_workout');
      if (heart !== undefined) {
        const at = stamp(heart.measuredAt);
        if (!Number.isFinite(heart.value) || heart.value <= 0 || heart.unit !== 'count/min' || !Number.isFinite(at) || at < start || at > end) nativeError('invalid_live_heart');
        liveHeart = { ...base, id: 'live-heart:'+row.recordId, kind: 'heart', start: at, end: at, value: heart.value, unit: 'bpm' };
      }
    }
    return { ...base, kind: 'workout', name: String(payload.activityType ?? 'Workout'), duration: (end-start)/60000, liveHeart };
  }
  return null;
}
export function validateNativeRecord(row, now) {
  if (!row || !['upsert', 'delete'].includes(row.op) || !text(row.typeIdentifier) || !text(row.recordId)) nativeError('invalid_record');
  if (row.op === 'delete') return;
  if (!text(row.source?.id) || !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) nativeError('invalid_record');
  const start = stamp(row.start), end = stamp(row.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end > now+60000) nativeError('invalid_record_time');
  normalizeNativeRecord(row);
}

export function decodeNativeBatch(body, id) {
  let batch; try { batch = JSON.parse(body); } catch { nativeError('invalid_json'); }
  if (batch?.schemaVersion !== 1 || !text(batch.batchId) || batch.batchId !== id ||
      !Array.isArray(batch.records) || !batch.records.length || batch.records.length > 5000) nativeError('invalid_batch');
  return batch;
}
export function nativeSeries(records, now) {
    const result = { hrv: [], heart: [], sleep: [], daily: [], workout: [] }, daily = new Map(), liveHearts = [];
    for (const raw of records) {
      const row = normalizeNativeRecord(raw); if (!row || row.end < now-35*DAY) continue;
      if (row.kind !== 'daily') {
        result[row.kind].push(row);
        if (row.liveHeart) liveHearts.push(row.liveHeart);
        continue;
      }
      const day = Math.floor((row.start + 8*3600000)/DAY)*DAY - 8*3600000;
      const key = JSON.stringify([day, row.metric, row.source]);
      let group = daily.get(key);
      if (!group) { group = { ...row, start: day, end: day, value: 0, n: 0 }; daily.set(key, group); }
      group.value += row.value; group.n++;
    }
    result.daily = [...daily.values()].map(({ sum, n, ...row }) => ({ ...row, value: sum ? row.value : row.value/n }));
    const nativeHeartTimes = new Set(result.heart.map(r => r.start));
    result.heart.push(...liveHearts.filter(r => !nativeHeartTimes.has(r.start)));
    for (const rows of Object.values(result)) rows.sort((a,b) => a.start-b.start || a.id.localeCompare(b.id));
    return result;
  }

export function nativeSnapshot(records, series, now, previous, lastReceivedAt, cached = {}) {
  const activity = cached.activity ?? summarizeNativeActivity(records, now);
  const indices = cached.indices ? structuredClone(cached.indices) : evaluateHealthIndices(series, now, previous);
    const last = previous?.pressure;
    indices.lastValidPressure = Number.isFinite(last?.score) ? {
      ruleVersion: previous.ruleVersion, source: last.source, score: last.score,
      evidenceAt: last.evidenceAt, context: last.context, hrv: last.evidence?.hrv ?? null,
    } : previous?.lastValidPressure ?? null;
    indices.title = renderStatusSignature(indices, now, activity, lastReceivedAt);
    indices.textVersion = STATUS_SIGNATURE_TEXT_VERSION;

  return { title: indices.title, indices, activity };
}
