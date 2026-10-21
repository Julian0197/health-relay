import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { evaluateHealthIndices } from './health-indices.mjs';
import { renderStatusSignature, STATUS_SIGNATURE_TEXT_VERSION } from './health-signature.mjs';
import { summarizeNativeActivity } from './native-activity.mjs';
const DAY = 86400000;
const fail = (message, status = 422) => { throw Object.assign(new Error(message), { status }); };
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const stamp = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
const identity = row => JSON.stringify([row.typeIdentifier, row.recordId]);
const stages = ['in_bed', 'asleep', 'awake', 'core', 'deep', 'rem'];
const dailyMetrics = { RestingHeartRate: ['resting_heart_rate', ['count/min', 'bpm']],
  StepCount: ['step_count', ['count']], ActiveEnergyBurned: ['active_energy', ['kcal']],
  BasalEnergyBurned: ['basal_energy_burned', ['kcal']], AppleExerciseTime: ['apple_exercise_time', ['min']],
  AppleStandTime: ['apple_stand_time', ['min']], RespiratoryRate: ['respiratory_rate', ['count/min']],
  OxygenSaturation: ['blood_oxygen_saturation', ['%']] };
function normalized(row) {
  if (row.op === 'delete') return null;
  const start = stamp(row.start), end = stamp(row.end), payload = row.payload;
  const base = { id: row.recordId, source: row.source.id, start, end };
  const type = row.typeIdentifier.replace('HKQuantityTypeIdentifier', '');
  const numeric = () => { if (!Number.isFinite(payload.value) || payload.value < 0) fail('invalid_quantity'); };
  if (type === 'HeartRateVariabilitySDNN') {
    numeric(); if (!['ms', 's'].includes(payload.unit) || payload.value <= 0) fail('invalid_hrv');
    return { ...base, kind: 'hrv', value: payload.value * (payload.unit === 's' ? 1000 : 1), unit: 'ms', method: 'SDNN' };
  }
  if (type === 'HeartRate') {
    numeric(); if (!['count/min', 'bpm'].includes(payload.unit) || payload.value <= 0) fail('invalid_heart_rate');
    return { ...base, kind: 'heart', value: payload.value, unit: 'bpm' };
  }
  if (row.typeIdentifier === 'HKCategoryTypeIdentifierSleepAnalysis') {
    if (!Number.isInteger(payload.value) || !stages[payload.value] || end <= start || end-start > 48*3600000) fail('invalid_sleep');
    return { ...base, kind: 'sleep', stage: stages[payload.value] };
  }
  if (dailyMetrics[type]) {
    numeric(); const [metric, units] = dailyMetrics[type];
    if (!units.includes(payload.unit)) fail('invalid_daily_unit');
    return { ...base, kind: 'daily', metric, value: payload.value, unit: payload.unit,
      sum: ['StepCount', 'ActiveEnergyBurned', 'BasalEnergyBurned', 'AppleExerciseTime', 'AppleStandTime'].includes(type) };
  }
  if (row.typeIdentifier === 'HKWorkoutType') {
    if (end < start) fail('invalid_workout');
    let liveHeart = null;
    if (payload.live !== undefined) {
      const live = payload.live, heart = live?.heartRate;
      if (live?.version !== 1 || !['running', 'paused', 'ended'].includes(live.state) ||
        !Number.isFinite(payload.durationSeconds) || payload.durationSeconds < 0 || payload.durationSeconds > (end-start)/1000+1) fail('invalid_live_workout');
      if (heart !== undefined) {
        const at = stamp(heart.measuredAt);
        if (!Number.isFinite(heart.value) || heart.value <= 0 || heart.unit !== 'count/min' || !Number.isFinite(at) || at < start || at > end) fail('invalid_live_heart');
        liveHeart = { ...base, id: 'live-heart:'+row.recordId, kind: 'heart', start: at, end: at, value: heart.value, unit: 'bpm' };
      }
    }
    return { ...base, kind: 'workout', name: String(payload.activityType ?? 'Workout'), duration: (end-start)/60000, liveHeart };
  }
  return null;
}
function validate(row, now) {
  if (!row || !['upsert', 'delete'].includes(row.op) || !text(row.typeIdentifier) || !text(row.recordId)) fail('invalid_record');
  if (row.op === 'delete') return;
  if (!text(row.source?.id) || !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) fail('invalid_record');
  const start = stamp(row.start), end = stamp(row.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end > now+60000) fail('invalid_record_time');
  normalized(row);
}
export class NativeStore {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file); chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS native_records (key TEXT PRIMARY KEY, body TEXT NOT NULL, deleted INTEGER NOT NULL, received_at REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS native_batches (id TEXT PRIMARY KEY, hash TEXT NOT NULL, receipt TEXT NOT NULL, received_at REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS native_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  ingest(body, id, now = Date.now()) {
    let batch; try { batch = JSON.parse(body); } catch { fail('invalid_json'); }
    if (batch?.schemaVersion !== 1 || !text(batch.batchId) || batch.batchId !== id ||
      !Array.isArray(batch.records) || !batch.records.length || batch.records.length > 5000) fail('invalid_batch');
    const digest = createHash('sha256').update(body).digest('hex');
    const previous = this.db.prepare('SELECT * FROM native_batches WHERE id=?').get(id);
    if (previous) { if (previous.hash !== digest) fail('batch_body_changed', 409); return JSON.parse(previous.receipt); }
    for (const row of batch.records) validate(row, now);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let accepted = 0, duplicates = 0;
      const findRecord = this.db.prepare('SELECT body FROM native_records WHERE key=?');
      const writeRecord = this.db.prepare(`INSERT INTO native_records VALUES(?,?,?,?) ON CONFLICT(key)
        DO UPDATE SET body=excluded.body,deleted=excluded.deleted,received_at=excluded.received_at`);
      for (const row of batch.records) {
        const key = identity(row), encoded = JSON.stringify(row);
        const old = findRecord.get(key);
        if (old?.body === encoded) { duplicates++; continue; }
        writeRecord.run(key, encoded, row.op === 'delete' ? 1 : 0, now);
        accepted++;
      }
      const receipt = { batchId: id, committed: true, accepted, duplicates };
      this.db.prepare('INSERT INTO native_batches VALUES(?,?,?,?)').run(id, digest, JSON.stringify(receipt), now);
      this.db.exec('COMMIT'); return receipt;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  rawRecords() { return this.db.prepare('SELECT body FROM native_records WHERE deleted=0 ORDER BY key').all().map(r => JSON.parse(r.body)); }
  series(now = Date.now(), records = this.rawRecords()) {
    const result = { hrv: [], heart: [], sleep: [], daily: [], workout: [] }, daily = new Map(), liveHearts = [];
    for (const raw of records) {
      const row = normalized(raw); if (!row || row.end < now-35*DAY) continue;
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
  state(key) { const r = this.db.prepare('SELECT value FROM native_state WHERE key=?').get(key); return r ? JSON.parse(r.value) : null; }
  saveState(key, value) { this.db.prepare('INSERT OR REPLACE INTO native_state VALUES(?,?)').run(key, JSON.stringify(value)); }
  status(now = Date.now()) {
    const previous = this.state('publishedDecision');
    const records = this.rawRecords(), activity = summarizeNativeActivity(records, now);
    const indices = evaluateHealthIndices(this.series(now, records), now, previous);
    const last = previous?.pressure;
    indices.lastValidPressure = Number.isFinite(last?.score) ? {
      ruleVersion: previous.ruleVersion, source: last.source, score: last.score,
      evidenceAt: last.evidenceAt, context: last.context, hrv: last.evidence?.hrv ?? null,
    } : previous?.lastValidPressure ?? null;
    const lastReceivedAt = this.db.prepare('SELECT MAX(received_at) AS t FROM native_batches').get().t;
    indices.title = renderStatusSignature(indices, now, activity, lastReceivedAt);
    indices.textVersion = STATUS_SIGNATURE_TEXT_VERSION;
    return { recordCount: this.db.prepare('SELECT COUNT(*) AS n FROM native_records WHERE deleted=0').get().n,
      batchCount: this.db.prepare('SELECT COUNT(*) AS n FROM native_batches').get().n,
      lastReceivedAt,
      title: indices.title, indices, activity, published: this.state('publication') };
  }
  async publish(publishTitle, now = Date.now()) {
    const state = this.status(now), old = state.published;
    if (old?.title === state.title) return false;
    await publishTitle(state.title);
    this.saveState('publication', { title: state.title, publishedAt: now });
    this.saveState('publishedDecision', state.indices);
    return true;
  }
}
