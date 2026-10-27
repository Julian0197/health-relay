import { decodeNativeBatch, validateNativeRecord, nativeIdentity, nativeError, nativeSeries, nativeSnapshot } from './native-domain.mjs';
import { NativeDayProjection, projectedSeries, projectedActivity, projectedMetadata } from './native-projection.mjs';
const DAY = 86400000, dayOf = t => Math.floor((t + 8 * 3600000) / DAY);
const CHUNK_BYTES = 512 * 1024;
const decodeParts = parts => {
  const bytes = new Uint8Array(parts.reduce((n,p) => n+p.byteLength, 0));
  let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
};
const scoringType = row => row && ['HKQuantityTypeIdentifierHeartRate', 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
  'HKCategoryTypeIdentifierSleepAnalysis', 'HKWorkoutType'].includes(row.typeIdentifier);

// SQL adapters supply parameterized all/run and a synchronous transaction boundary.
export class NativeRepository {
  constructor(sql) {
    this.sql = sql;
    this.readStats = { rowsReturned: 0, dayCacheHits: 0, normalizedRecords: 0, scoringEvaluations: 0 };
    this.dayCache = new Map();
    for (const statement of [
      'CREATE TABLE IF NOT EXISTS native_records (key TEXT PRIMARY KEY, body TEXT NOT NULL, deleted INTEGER NOT NULL, received_at REAL NOT NULL, day INTEGER NOT NULL DEFAULT 0)',
      'CREATE TABLE IF NOT EXISTS native_batches (id TEXT PRIMARY KEY, hash TEXT NOT NULL, receipt TEXT NOT NULL, received_at REAL NOT NULL)',
      'CREATE TABLE IF NOT EXISTS native_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS native_day_cache (day INTEGER PRIMARY KEY, body TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS native_day_cache_chunks (day INTEGER NOT NULL, part INTEGER NOT NULL, body BLOB NOT NULL, PRIMARY KEY(day,part))',
      'CREATE TABLE IF NOT EXISTS native_cache_v2 (day INTEGER NOT NULL, part INTEGER NOT NULL, through INTEGER NOT NULL, body BLOB NOT NULL, PRIMARY KEY(day,part))',
      'CREATE TABLE IF NOT EXISTS native_cache_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, day INTEGER NOT NULL, final INTEGER NOT NULL, body BLOB NOT NULL)',
      'CREATE INDEX IF NOT EXISTS native_cache_changes_day ON native_cache_changes(day,id)',
    ]) sql.run(statement);
    if (!sql.all('PRAGMA table_info(native_records)').some(c => c.name === 'day')) {
      sql.transaction(() => {
        sql.run('ALTER TABLE native_records ADD COLUMN day INTEGER NOT NULL DEFAULT 0');
        for (const row of sql.all('SELECT key,body,received_at FROM native_records')) {
          const raw = JSON.parse(row.body);
          sql.run('UPDATE native_records SET day=? WHERE key=?', dayOf(Date.parse(raw.end) || row.received_at), row.key);
        }
      });
    }
    sql.run('CREATE INDEX IF NOT EXISTS native_records_day ON native_records(day,deleted,key)');
    if (!this.state('reception')) this.saveState('reception', {
      recordCount: sql.all('SELECT COUNT(*) AS n FROM native_records WHERE deleted=0')[0].n,
      batchCount: sql.all('SELECT COUNT(*) AS n FROM native_batches')[0].n,
      lastReceivedAt: sql.all('SELECT MAX(received_at) AS t FROM native_batches')[0].t,
    });
    // A deployment rolled back to the older writer cannot maintain v2 deltas.
    // Only derived caches are discarded when such a writer is detected.
    const count = this.state('reception').batchCount;
    if (this.state('cacheV2BatchCount') !== count) sql.transaction(() => {
      sql.run('DELETE FROM native_cache_v2'); sql.run('DELETE FROM native_cache_changes');
      this.saveState('cacheV2BatchCount', count);
      this.saveState('scoringRevision', (this.state('scoringRevision') ?? 0)+1);
    });
  }
  state(key) { const row = this.sql.all('SELECT value FROM native_state WHERE key=?', key)[0]; return row ? JSON.parse(row.value) : null; }
  saveState(key, value) { this.sql.run('INSERT OR REPLACE INTO native_state VALUES(?,?)', key, JSON.stringify(value)); }
  commit(body, id, hash, now, minStart = -Infinity) {
    const batch = decodeNativeBatch(body, id);
    const changes = new Map(), durable = new Map(); let scoringChanged = false;
    const change = (day, key, raw) => {
      if (!changes.has(day)) changes.set(day, []);
      changes.get(day).push([key, raw]);
    };
    const result = this.sql.transaction(() => {
      const previous = this.sql.all('SELECT hash,receipt FROM native_batches WHERE id=?', id)[0];
      if (previous) {
        if (previous.hash !== hash) nativeError('batch_body_changed', 409);
        return { receipt: JSON.parse(previous.receipt), isNew: false };
      }
      for (const row of batch.records) {
        validateNativeRecord(row, now);
        if (row.op === 'upsert' && Date.parse(row.start) < minStart) nativeError('before_sync_start');
      }
      let accepted = 0, duplicates = 0;
      const reception = this.state('reception');
      for (const row of batch.records) {
        const key = nativeIdentity(row), encoded = JSON.stringify(row);
        const old = this.sql.all('SELECT body,deleted,day FROM native_records WHERE key=?', key)[0];
        if (old?.body === encoded) { duplicates++; continue; }
        const deleted = row.op === 'delete' ? 1 : 0;
        const day = row.end ? dayOf(Date.parse(row.end)) : old?.day ?? dayOf(now);
        this.sql.run('INSERT INTO native_records VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,deleted=excluded.deleted,received_at=excluded.received_at,day=excluded.day', key, encoded, deleted, now, day);
        const before = old && !old.deleted ? JSON.parse(old.body) : null;
        if (old && old.day !== day) change(old.day, key, null);
        change(day, key, deleted ? null : row);
        if (scoringType(before) || scoringType(row)) scoringChanged = true;
        reception.recordCount += (deleted ? 0 : 1) - (old && !old.deleted ? 1 : 0);
        accepted++;
      }
      for (const [day, updates] of changes) {
        this.sql.run('DELETE FROM native_day_cache WHERE day=?', day);
        this.sql.run('DELETE FROM native_day_cache_chunks WHERE day=?', day);
        const bytes = new TextEncoder().encode(JSON.stringify(updates)); let parts = 0;
        for (let start = 0; start < bytes.length; start += CHUNK_BYTES) {
          this.sql.run('INSERT INTO native_cache_changes(day,final,body) VALUES(?,?,?)', day,
            start+CHUNK_BYTES >= bytes.length ? 1 : 0, bytes.slice(start, start+CHUNK_BYTES)); parts++;
        }
        durable.set(day, { through: this.sql.all('SELECT last_insert_rowid() AS id')[0].id, bytes: bytes.length, parts });
      }
      const receipt = { batchId: id, committed: true, accepted, duplicates };
      this.sql.run('INSERT INTO native_batches VALUES(?,?,?,?)', id, hash, JSON.stringify(receipt), now);
      this.saveState('reception', { ...reception, batchCount: reception.batchCount+1, lastReceivedAt: now });
      this.saveState('cacheV2BatchCount', reception.batchCount+1);
      if (scoringChanged) this.saveState('scoringRevision', (this.state('scoringRevision') ?? 0)+1);
      return { receipt, isNew: true };
    });
    // In-memory facts change only after the whole batch and its receipt commit.
    for (const [day, updates] of changes) {
      const cached = this.dayCache.get(day); if (!cached) continue;
      cached.projection.update(updates);
      const delta = durable.get(day); cached.through = delta.through;
      cached.bytes += delta.bytes; cached.parts += delta.parts;
    }
    return result;
  }
  rawRecords() { return this.sql.all('SELECT body FROM native_records WHERE deleted=0 ORDER BY key').map(r => JSON.parse(r.body)); }
  cachedDays(now) {
    const first = dayOf(now - 35*DAY), last = dayOf(now + 60000);
    for (const day of this.dayCache.keys()) if (day < first || day > last) this.dayCache.delete(day);
    const days = [];
    for (let day = first; day <= last; day++) {
      let cached = this.dayCache.get(day);
      if (cached) this.readStats.dayCacheHits++;
      else { cached = this.loadDay(day); this.dayCache.set(day, cached); }
      if (cached.bytes >= CHUNK_BYTES/2 || cached.parts >= 16) this.compactDay(day, cached);
      days.push(cached);
    }
    return days;
  }
  loadDay(day) {
    const stored = this.sql.all('SELECT through,body FROM native_cache_v2 WHERE day=? ORDER BY part', day);
    this.readStats.rowsReturned += stored.length;
    let values, through = 0;
    if (stored.length) {
      values = decodeParts(stored.map(r => new Uint8Array(r.body))); through = stored[0].through;
      this.readStats.dayCacheHits++;
    } else {
      // Adopt existing valid caches once, without a raw-data migration or reindex.
      const legacy = this.sql.all('SELECT body FROM native_day_cache WHERE day=?', day);
      const chunks = legacy.length ? [] : this.sql.all('SELECT body FROM native_day_cache_chunks WHERE day=? ORDER BY part', day);
      this.readStats.rowsReturned += legacy.length+chunks.length;
      if (legacy.length) values = JSON.parse(legacy[0].body);
      else if (chunks.length) values = decodeParts(chunks.map(r => new Uint8Array(r.body)));
      else {
        const raw = this.sql.all('SELECT body FROM native_records WHERE day=? AND deleted=0 ORDER BY key', day);
        this.readStats.rowsReturned += raw.length; values = raw.map(r => JSON.parse(r.body));
      }
    }
    const rows = new Map(values.map(r => [nativeIdentity(r),r]));
    const deltas = this.sql.all('SELECT id,final,body FROM native_cache_changes WHERE day=? AND id>? ORDER BY id', day, through);
    this.readStats.rowsReturned += deltas.length;
    let parts = [], bytes = 0;
    for (const delta of deltas) {
      const part = new Uint8Array(delta.body); parts.push(part); bytes += part.byteLength;
      if (delta.final) {
        for (const [key, raw] of decodeParts(parts)) { if (raw) rows.set(key, raw); else rows.delete(key); }
        parts = []; through = delta.id;
      }
    }
    const cached = { rows, through, bytes, parts: deltas.length, projection: new NativeDayProjection(rows, this.readStats) };
    if (!stored.length) this.compactDay(day, cached);
    return cached;
  }
  compactDay(day, cached) {
    const values = [...cached.rows].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([,r]) => r);
    const bytes = new TextEncoder().encode(JSON.stringify(values));
    this.sql.transaction(() => {
      this.sql.run('DELETE FROM native_cache_v2 WHERE day=?', day);
      for (let start = 0, part = 0; start < bytes.length; start += CHUNK_BYTES, part++) {
        this.sql.run('INSERT INTO native_cache_v2 VALUES(?,?,?,?)', day, part, cached.through, bytes.slice(start, start+CHUNK_BYTES));
      }
      this.sql.run('DELETE FROM native_cache_changes WHERE day=? AND id<=?', day, cached.through);
    });
    cached.bytes = 0; cached.parts = 0;
  }
  recentRecords(now) {
    return this.cachedDays(now).flatMap(day => [...day.rows].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([,r]) => r));
  }
  series(now = Date.now(), records = this.rawRecords()) { return nativeSeries(records, now); }
  view(now = Date.now(), { range = null, statusOnly = false } = {}) {
    const days = this.cachedDays(now), cutoff = now-35*DAY;
    const projections = days.map((cached,i) => i === 0 && cached.rows.size
      ? new NativeDayProjection(new Map([...cached.rows].filter(([,r]) => Date.parse(r.end) >= cutoff)), this.readStats)
      : cached.projection);
    const previous = this.state('publishedDecision'), revision = this.state('scoringRevision') ?? 0;
    const key = JSON.stringify([revision, previous?.ruleVersion, previous?.features?.hrv?.method, previous?.pressure?.trend]);
    const scoring = this.state('scoringCache');
    const reception = this.state('reception');
    let full, indices;
    if (scoring?.key === key && now >= scoring.at && now < scoring.until) indices = scoring.indices;
    else {
      full = projectedSeries(projections, now);
      const evaluated = nativeSnapshot([], full, now, previous, reception.lastReceivedAt);
      indices = evaluated.indices; this.readStats.scoringEvaluations++;
      const times = [(dayOf(now)+1)*DAY-8*3600000, indices.validUntil];
      for (const rows of [full.heart, full.hrv, full.sleep, full.workout]) for (const row of rows) {
        times.push(row.start, row.end, row.end+35*DAY+1);
      }
      const until = times.reduce((next,t) => Number.isFinite(t) && t > now ? Math.min(next,t) : next, Infinity);
      this.saveState('scoringCache', { key, at: now, until, indices });
    }
    // Materialize the displayed days before publication yields to network I/O.
    // New uploads may update the warm projections while this view is in flight.
    const activities = new Map();
    for (let offset = 0; offset <= (statusOnly ? 0 : 7); offset++) {
      const end = Math.min(now, (dayOf(now)-offset+1)*DAY-8*3600000-1);
      activities.set(dayOf(end), projectedActivity(projections, end));
    }
    const activityAt = at => activities.get(dayOf(at));
    const snapshot = nativeSnapshot([], null, now, previous, reception.lastReceivedAt, { indices, activity: activityAt(now) });
    const status = { ...reception, ...snapshot, published: this.state('publication') };
    if (statusOnly) return { status };
    const series = range ? projectedSeries(projections, now, range) : full ?? projectedSeries(projections, now);
    const workoutDurations = new Map();
    for (const p of projections) for (const { row, raw } of p.detail.values()) {
      if (row.kind === 'workout') workoutDurations.set(row.id, raw.payload?.durationSeconds);
    }
    const metadata = projectedMetadata(projections, series, now);
    return { series, activityAt, workoutDurations, ...metadata, status };
  }
  status(now = Date.now()) { return this.view(now, { statusOnly: true }).status; }
}
