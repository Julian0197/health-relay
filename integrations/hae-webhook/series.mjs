import { timeOf } from './health-card.mjs';
import { workoutFacts } from './workouts.mjs';
const DAY = 86400000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const sourceOf = value => typeof value === 'string' && value.length <= 200 ? value : 'unknown';
// HAE 在 zh-Hans 系统语言下直接上传中文阶段名（实测会发「核心」）。
// 映射取自已安装版本 HAE Localizable.strings，归一到 analysis 依赖的英文枚举。
const SLEEP_STAGE_ZH = {
  核心: 'core', 深度: 'deep', 快速动眼期: 'rem', 清醒: 'awake',
  睡眠时长: 'asleep', 在床上: 'in_bed', 未指定: 'unspecified',
};
function normalizeStage(raw) {
  const value = String(raw ?? '').trim();
  return SLEEP_STAGE_ZH[value] ?? value.toLowerCase().replaceAll(' ', '_');
}
export const recordKey = row => JSON.stringify([row.kind, row.source, row.method ?? '', row.metric ?? '', row.id ?? row.start,
  row.id ? '' : row.kind === 'sleep' ? `${row.end}:${row.stage}` : '',
  ...(row.kind === 'hrv' && row.aggregation === 'minutes' ? ['minutes'] : [])]);

export function parseSeries(payload, stream, aggregation = stream === 'heart' ? 'minutes' : 'raw') {
  const names = { hrv: 'heart_rate_variability', heart: 'heart_rate', 'sleep-segments': 'sleep_analysis' };
  const hrvMethods = { heart_rate_variability: 'SDNN', heart_rate_variability_rmssd: 'RMSSD' };
  const metrics = payload?.data?.metrics;
  if (Array.isArray(metrics) && metrics.length === 0 && !payload.data.workouts?.length) return [];
  const allowedNames = stream === 'hrv' ? Object.keys(hrvMethods) : [names[stream]];
  const maxMetrics = stream === 'hrv' && aggregation === 'minutes' ? 2 : 1;
  if (!Array.isArray(metrics) || metrics.length > maxMetrics ||
      metrics.some(m => !allowedNames.includes(m?.name) || !Array.isArray(m.data)) ||
      new Set(metrics.map(m => m.name)).size !== metrics.length || payload.data.workouts?.length) {
    throw new Error('wrong_data_type_for_stream');
  }
  const rows = metrics.flatMap(metric => metric.data.map(point => {
    if (!point || typeof point !== 'object') throw new Error('invalid_series_record');
    const start = timeOf(point.startDate ?? point.date);
    const id = point.id ?? point.uuid;
    const row = { kind: stream === 'sleep-segments' ? 'sleep' : stream, start, end: start,
      source: sourceOf(point.source), originalTime: point.startDate ?? point.date };
    if (id !== undefined) {
      if (typeof id !== 'string' || id.length > 200) throw new Error('invalid_sample_id');
      row.id = id;
    }
    if (!Number.isFinite(start) || /^\d{4}-\d{2}-\d{2}$/.test(row.originalTime)) throw new Error('invalid_series_time');
    if (stream === 'hrv') {
      const minutes = aggregation === 'minutes';
      const value = minutes ? point.qty ?? point.Avg : point.qty;
      if (metric.units !== 'ms' || !finite(value) || value <= 0 || (!minutes && point.Avg !== undefined)) throw new Error('hrv_sample_required');
      if (minutes && start % 60000 !== 0) throw new Error('minute_window_required');
      Object.assign(row, { value, unit: 'ms', method: hrvMethods[metric.name],
        ...(minutes ? { aggregation: 'minutes', end: start + 60000 } : {}) });
    } else if (stream === 'heart') {
      // Minute grouping is asserted by the request headers. HAE incremental exports
      // can retain seconds in the window anchor; preserve it rather than rounding.
      const value = point.Avg ?? point.qty;
      if (!['bpm', 'count/min'].includes(metric.units) || !finite(value) || value <= 0) throw new Error('invalid_heart_window');
      // HAE averages can exceed an equal extremum by floating point noise. Keep the original values.
      const tolerance = 8 * Number.EPSILON * Math.max(1, value);
      if ((point.Min !== undefined && (!finite(point.Min) || point.Min < 0 || point.Min - value > tolerance)) ||
          (point.Max !== undefined && (!finite(point.Max) || value - point.Max > tolerance))) throw new Error('invalid_heart_window');
      Object.assign(row, { end: start + 60000, value, unit: 'bpm', min: point.Min ?? null, max: point.Max ?? null });
    } else {
      const stage = normalizeStage(point.value);
      const end = timeOf(point.endDate);
      const reason = !['hr', 'min'].includes(metric.units) ? 'unit' : !Number.isFinite(end) ? 'end_time' :
        end <= start || end - start > 48 * 3600000 ? 'duration' :
          !['core', 'deep', 'rem', 'awake', 'asleep', 'in_bed', 'unspecified'].includes(stage) ? 'stage' : null;
      if (reason) throw Object.assign(new Error('sleep_segments_required'), {
        // Format diagnostics only: never return timestamps, measurements, or device names.
        details: { reason, unit: typeof metric.units === 'string' ? metric.units.slice(0, 24) : null, stage: stage.slice(0, 32) },
      });
      Object.assign(row, { end, stage, originalEnd: point.endDate });
    }
    row.key = recordKey(row);
    return row;
  }));
  if (rows.length > 10000) throw new Error('too_many_series_records');
  return rows;
}

// Store only the daily numeric facts and workout fields used by this service.
export function parseArchive(payload, summary, stream, aggregation) {
  const rows = [];
  if (stream === 'health' && aggregation === 'days') {
    for (const metric of summary.metrics) for (const point of metric.points) rows.push({
      kind: 'daily', metric: metric.name, start: point.time, end: point.time,
      value: point.rawValue, unit: point.unit, source: point.source,
    });
  }
  for (const workout of summary.workouts) {
    const original = payload.data.workouts.find(w => (typeof w.id === 'string' ? w.id.slice(0, 120) : `${w.name}:${timeOf(w.start)}:${timeOf(w.end)}`) === workout.id);
    const row = { ...workout, ...workoutFacts(original), kind: 'workout', source: sourceOf(original?.source) };
    for (const field of ['heartRateData', 'heartRateRecovery']) {
      if (original?.[field] === undefined) continue;
      if (!Array.isArray(original[field]) || original[field].length > 10000) throw new Error('invalid_workout_curve');
      row[field] = original[field].map(point => {
        const time = timeOf(point.date);
        if (!Number.isFinite(time) || !['bpm', 'count/min'].includes(point.units) ||
            !finite(point.Avg) || point.Avg <= 0 ||
            (point.Min !== undefined && (!finite(point.Min) || point.Min < 0 || point.Min > point.Avg)) ||
            (point.Max !== undefined && (!finite(point.Max) || point.Max < point.Avg))) throw new Error('invalid_workout_curve');
        return { time, avg: point.Avg, min: point.Min ?? null, max: point.Max ?? null, source: sourceOf(point.source) };
      });
    }
    rows.push(row);
  }
  return rows.map(row => ({ ...row, key: recordKey(row) }));
}

// Compare normalized business content, not JSON order or equivalent timestamp spelling.
function semanticValue(value) {
  if (Array.isArray(value)) return value.map(semanticValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => !['key', 'originalTime', 'originalEnd'].includes(key))
    .map(key => [key, semanticValue(value[key])]));
}
const semanticText = row => JSON.stringify(semanticValue(row));

export class SeriesStore {
  constructor(sql) {
    this.sql = sql;
    this.readCache = new Map();
    this.cacheChars = 0;
    this.readStats = { queries: 0, rowsReturned: 0, rowsRead: 0, cacheHits: 0 };
    sql.exec('CREATE TABLE IF NOT EXISTS samples (key TEXT PRIMARY KEY, kind TEXT NOT NULL, start REAL NOT NULL, end REAL NOT NULL, payload TEXT NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS samples_kind_start ON samples(kind, start)');
    sql.exec('CREATE INDEX IF NOT EXISTS samples_end ON samples(end)');
    sql.exec('CREATE TABLE IF NOT EXISTS sample_day_cache (kind TEXT NOT NULL,day INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,day))');
    sql.exec('CREATE INDEX IF NOT EXISTS sample_cache_day ON sample_day_cache(day)');
    sql.exec('CREATE TABLE IF NOT EXISTS sample_counts (kind TEXT PRIMARY KEY,n INTEGER NOT NULL)');
    if (!sql.exec("SELECT 1 FROM sample_counts WHERE kind='' ").toArray().length) {
      sql.exec('INSERT OR REPLACE INTO sample_counts SELECT kind,COUNT(*) FROM samples GROUP BY kind');
      sql.exec("INSERT INTO sample_counts VALUES('',0)");
    }
    // Triggers keep derived facts correct inside the caller's transaction, including
    // writes from an older deployment after rollback. Unchanged uploads never fire them.
    sql.exec(`CREATE TRIGGER IF NOT EXISTS sample_cache_insert AFTER INSERT ON samples BEGIN
      INSERT INTO sample_counts VALUES(NEW.kind,1) ON CONFLICT(kind) DO UPDATE SET n=n+1;
      DELETE FROM sample_day_cache WHERE kind=NEW.kind AND day=CAST(NEW.start/${DAY} AS INTEGER);
    END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS sample_cache_delete AFTER DELETE ON samples BEGIN
      UPDATE sample_counts SET n=n-1 WHERE kind=OLD.kind;
      DELETE FROM sample_day_cache WHERE kind=OLD.kind AND day=CAST(OLD.start/${DAY} AS INTEGER);
    END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS sample_cache_update AFTER UPDATE ON samples BEGIN
      UPDATE sample_counts SET n=n-1 WHERE kind=OLD.kind AND OLD.kind<>NEW.kind;
      INSERT INTO sample_counts SELECT NEW.kind,1 WHERE OLD.kind<>NEW.kind ON CONFLICT(kind) DO UPDATE SET n=n+1;
      DELETE FROM sample_day_cache WHERE kind=OLD.kind AND day=CAST(OLD.start/${DAY} AS INTEGER);
      DELETE FROM sample_day_cache WHERE kind=NEW.kind AND day=CAST(NEW.start/${DAY} AS INTEGER);
    END`);
  }
  invalidate(kind) {
    if (kind === undefined) { this.readCache.clear(); this.cacheChars = 0; return; }
    this.cacheChars -= this.readCache.get(kind)?.chars ?? 0;
    this.readCache.delete(kind);
  }
  put(records, now) {
    const stats = { parsedRecords: records.length, duplicateInBatch: 0, uniqueRecords: 0, inserted: 0, updated: 0, unchanged: 0, expired: 0 };
    const result = { stored: 0, expired: 0, stats, changedRange: null };
    const unique = new Map();
    // Validate the complete batch before any write; caller provides the transaction.
    for (const row of records) {
      if (row.start > now + 60000 || row.end > now + 60000) throw new Error('future_series_time');
      const key = row.key ?? recordKey(row), content = semanticText(row);
      const previous = unique.get(key);
      if (previous && previous.content !== content) throw new Error('conflicting_records_in_batch');
      if (previous) stats.duplicateInBatch++;
      else unique.set(key, { row, content });
      if (row.end < now - 35 * DAY) result.expired++;
      else result.stored++; // Preserve the legacy accepted input count.
    }
    stats.uniqueRecords = unique.size;
    const keys = [...unique.keys()], existing = new Map();
    for (let offset = 0; offset < keys.length; offset += 100) {
      const chunk = keys.slice(offset, offset + 100);
      for (const row of this.sql.exec(`SELECT key,payload FROM samples WHERE key IN (${chunk.map(() => '?').join(',')})`, ...chunk)) {
        const record = JSON.parse(row.payload);
        existing.set(row.key, { content: semanticText(record), record });
      }
    }
    for (const [key, { row, content }] of unique) {
      if (row.end < now - 35 * DAY) { stats.expired++; continue; }
      if (existing.get(key)?.content === content) { stats.unchanged++; continue; }
      if (existing.has(key)) stats.updated++; else stats.inserted++;
      this.invalidate(row.kind);
      const previous = existing.get(key)?.record;
      result.changedRange = {
        startAt: Math.min(result.changedRange?.startAt ?? Infinity, row.start, previous?.start ?? Infinity),
        endAt: Math.max(result.changedRange?.endAt ?? -Infinity, row.end, previous?.end ?? -Infinity),
      };
      this.sql.exec(`INSERT INTO samples(key,kind,start,end,payload) VALUES(?,?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET start=excluded.start,end=excluded.end,payload=excluded.payload`,
        key, row.kind, row.start, row.end, JSON.stringify(row));
    }
    return result;
  }
  list(kind, since = 0) {
    const cached = this.readCache.get(kind);
    if (cached && since >= cached.since) {
      this.readStats.cacheHits++;
      return cached.rows.filter(row => row.start >= since);
    }
    const first = this.sql.exec('SELECT start FROM samples WHERE kind=? AND start>=? ORDER BY start LIMIT 1', kind, since).toArray()[0]?.start;
    if (first === undefined) return [];
    const last = this.sql.exec('SELECT start FROM samples WHERE kind=? ORDER BY start DESC LIMIT 1', kind).toArray()[0].start;
    const firstDay = Math.floor(first / DAY), lastDay = Math.floor(last / DAY);
    const cursor = this.sql.exec('SELECT day,payload FROM sample_day_cache WHERE kind=? AND day>=? AND day<=? ORDER BY day', kind, firstDay, lastDay);
    const days = new Map(cursor.toArray().map(row => [row.day, JSON.parse(row.payload)]));
    this.readStats.queries++;
    this.addReadCount(cursor);
    const rows = [];
    for (let day = firstDay; day <= lastDay; day++) {
      let bucket = days.get(day);
      if (!bucket) {
        const raw = this.sql.exec('SELECT payload FROM samples WHERE kind=? AND start>=? AND start<? ORDER BY start,key', kind, day * DAY, (day + 1) * DAY);
        bucket = raw.toArray().map(row => JSON.parse(row.payload));
        this.readStats.queries++;
        this.addReadCount(raw);
        const payload = JSON.stringify(bucket);
        // A pathological multi-source day falls back to authoritative raw SQL.
        if (new TextEncoder().encode(payload).length <= 1000000) this.sql.exec('INSERT OR REPLACE INTO sample_day_cache VALUES(?,?,?)', kind, day, payload);
      }
      rows.push(...bucket.filter(row => row.start >= since));
    }
    this.readStats.rowsReturned += rows.length;
    // Cache facts only: time-dependent scores are always recomputed. Bound aggregate
    // serialized size and row count; eviction/restart reloads persisted day caches.
    const chars = JSON.stringify(rows).length;
    if (chars <= 4000000 && rows.length <= 20000) {
      this.invalidate(kind);
      while (this.cacheChars + chars > 4000000) this.invalidate(this.readCache.keys().next().value);
      this.readCache.set(kind, { since, rows, chars });
      this.cacheChars += chars;
    }
    return rows.slice();
  }
  listBetween(kind, start, end) {
    const cursor = this.sql.exec('SELECT payload FROM samples WHERE kind=? AND start>=? AND start<=? AND end<=? ORDER BY start,key', kind, start, end, end);
    const rows = cursor.toArray().map(r => JSON.parse(r.payload));
    this.readStats.queries++;
    this.readStats.rowsReturned += rows.length;
    this.addReadCount(cursor);
    return rows;
  }
  addReadCount(cursor) {
    this.readStats.rowsRead = this.readStats.rowsRead !== null && Number.isFinite(cursor.rowsRead)
      ? this.readStats.rowsRead + cursor.rowsRead : null;
  }
  hasRecords() { return this.sql.exec('SELECT 1 FROM samples LIMIT 1').toArray().length > 0; }
  counts() { return Object.fromEntries(this.sql.exec('SELECT kind,n FROM sample_counts WHERE n>0').toArray().map(r => [r.kind, r.n])); }
  prune(now) {
    const deleted = this.sql.exec('DELETE FROM samples WHERE end < ? RETURNING kind', now - 35 * DAY).toArray();
    for (const kind of new Set(deleted.map(row => row.kind))) this.invalidate(kind);
    this.sql.exec('DELETE FROM sample_day_cache WHERE day<?', Math.floor((now - 35 * DAY) / DAY));
    return deleted.length;
  }
}
