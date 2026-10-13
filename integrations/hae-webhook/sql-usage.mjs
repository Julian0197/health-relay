// Counts explicit SQL work, including index/trigger reads reported by workerd.
// No health values, measurement timestamps, keys or bodies enter these counters.
export class SqlUsage {
  constructor(sql) {
    this.raw = sql;
    this.pending = new Map();
    sql.exec(`CREATE TABLE IF NOT EXISTS sql_read_usage (
      day TEXT NOT NULL,category TEXT NOT NULL,queries INTEGER NOT NULL,rows_read INTEGER NOT NULL,
      rows_written INTEGER NOT NULL,PRIMARY KEY(day,category))`);
    this.sql = { exec: (query, ...bindings) => {
      const cursor = sql.exec(query, ...bindings), rows = cursor.toArray();
      if (Number.isFinite(cursor.rowsRead) && Number.isFinite(cursor.rowsWritten)) {
        const category = query.includes('pressure_') ? 'pressure'
          : query.includes('sample_day_cache') ? 'day_cache'
          : query.includes('sample_counts') ? 'counts'
          : query.startsWith('SELECT key,payload FROM samples WHERE key IN') ? 'deduplication'
          : query.startsWith('SELECT payload FROM samples') ? query.includes('end<=?') ? 'workout_heart' : 'raw_history'
          : query.startsWith('SELECT start FROM samples') ? 'history_bounds'
          : query.startsWith('DELETE FROM samples') ? 'retention'
          : query.startsWith('INSERT INTO samples') ? 'ingestion' : 'other';
        const totals = this.pending.get(category) ?? { queries: 0, reads: 0, writes: 0 };
        totals.queries++; totals.reads += cursor.rowsRead; totals.writes += cursor.rowsWritten;
        this.pending.set(category, totals);
      }
      return { rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten,
        toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    } };
  }

  flush(now) {
    const day = new Date(now).toISOString().slice(0, 10);
    try {
      for (const [category, totals] of this.pending) {
        this.raw.exec(`INSERT INTO sql_read_usage VALUES(?,?,?,?,?)
          ON CONFLICT(day,category) DO UPDATE SET queries=queries+excluded.queries,
          rows_read=rows_read+excluded.rows_read,rows_written=rows_written+excluded.rows_written`,
          day, category, totals.queries, totals.reads, totals.writes);
        this.pending.delete(category);
      }
      this.raw.exec('DELETE FROM sql_read_usage WHERE day<?', new Date(now - 7 * 86400000).toISOString().slice(0, 10));
    } catch { /* Metering must not turn a successful health upload into a retry. */ }
  }

  view(now) {
    return { scope: 'explicit_sql_excluding_meter_and_internal_kv',
      days: this.raw.exec(`SELECT day,category,queries,rows_read AS rowsRead,rows_written AS rowsWritten
        FROM sql_read_usage WHERE day>=? ORDER BY day,category`, new Date(now - 7 * 86400000).toISOString().slice(0, 10)).toArray() };
  }
}
