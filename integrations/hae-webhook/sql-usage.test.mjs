import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlUsage } from './sql-usage.mjs';
import { SeriesStore } from './series.mjs';
import { testSql } from './sql-test-helper.mjs';

test('upload deduplication has its own counter and survives a meter restart', () => {
  const base = testSql();
  // Domain SQLite has no billing API. Supply known cursor counts; workerd smoke
  // separately verifies the real billed rowsRead and rowsWritten properties.
  const sql = { exec(query, ...args) {
    const cursor = base.exec(query, ...args);
    return { ...cursor, rowsRead: cursor.toArray().length, rowsWritten: 0 };
  } };
  const meter = new SqlUsage(sql), store = new SeriesStore(meter.sql), now = Date.now();
  const row = { kind: 'heart', start: now - 60000, end: now, value: 65, source: 'Watch' };
  store.put([row], now); meter.flush(now);
  store.put([row], now); meter.flush(now);
  const counts = new SqlUsage(sql).view(now).days;
  const deduplication = counts.find(r => r.category === 'deduplication');
  assert.equal(deduplication?.queries, 2);
  assert.equal(deduplication?.rowsRead, 1);
  assert.doesNotMatch(JSON.stringify(counts), /Watch|value|source/);
});
