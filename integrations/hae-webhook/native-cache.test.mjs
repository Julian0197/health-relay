import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeCloudTestStore as NativeStore } from './native-sql-test-helper.mjs';

const DAY = 86400000, now = Date.parse('2026-10-27T04:00:00Z');
const sample = (id, at = now-60000) => ({ op: 'upsert', typeIdentifier: 'HKQuantityTypeIdentifierHeartRate',
  recordId: id, start: new Date(at).toISOString(), end: new Date(at).toISOString(),
  source: { id: 'synthetic', name: '合成🧪'.repeat(100), device: 'Watch' }, payload: { value: 72, unit: 'count/min' } });
const batch = (id, records) => JSON.stringify({ schemaVersion: 1, batchId: id, records });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'native-cache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return () => {
    const store = new NativeStore(join(directory, 'health.sqlite')), counts = { rawRows: 0 };
    const all = store.sql.all;
    store.sql.all = (sql, ...args) => {
      const rows = all(sql, ...args);
      if (/SELECT (?:key,)?body FROM native_records/.test(sql)) counts.rawRows += rows.length;
      return rows;
    };
    return { store, counts };
  };
}

// Removing persisted chunk reuse must make both warm and restarted reads scan raw history again.
test('days larger than 1 MB reuse complete cached records after a process restart', t => {
  const open = fixture(t), rows = Array.from({ length: 1400 }, (_, i) => sample('large-'+i));
  assert.ok(Buffer.byteLength(JSON.stringify(rows)) > 1000000);
  let { store, counts } = open();
  store.ingest(batch('seed', rows), 'seed', now);
  assert.equal(store.recentRecords(now).length, 1400);
  const cold = counts.rawRows;
  assert.equal(store.recentRecords(now).length, 1400);
  assert.equal(counts.rawRows, cold, 'unchanged large days must not reread their raw rows');
  store.close(); ({ store, counts } = open()); t.after(() => store.close());
  const cached = store.recentRecords(now);
  assert.equal(cached.length, 1400);
  assert.equal(counts.rawRows, 0, 'the cache must be durable, not just an in-memory workaround');
  assert.equal(cached.find(r => r.recordId === 'large-42').source.name, rows[42].source.name);
});

// Splitting UTF-8 at a cache boundary must not truncate a large individual record.
test('a single large UTF-8 record survives cache chunk boundaries intact', t => {
  const open = fixture(t), row = sample('unicode'); row.source.name = '🧪测'.repeat(190000);
  assert.ok(Buffer.byteLength(JSON.stringify(row)) > 1000000);
  let { store } = open(); store.ingest(batch('unicode', [row]), 'unicode', now);
  assert.equal(store.recentRecords(now)[0].source.name, row.source.name);
  store.close(); const reopened = open(); store = reopened.store; t.after(() => store.close());
  assert.equal(store.recentRecords(now)[0].source.name, row.source.name);
  assert.equal(reopened.counts.rawRows, 0);
});

// Failing to invalidate either day would leave stale corrected/deleted facts in the cache.
test('cached large days preserve corrections, cross-day moves, deletes and rollback', t => {
  const open = fixture(t), rows = Array.from({ length: 1400 }, (_, i) => sample('change-'+i));
  let { store } = open(); store.ingest(batch('seed', rows), 'seed', now); store.recentRecords(now);
  const moved = { ...rows[0], start: new Date(now-DAY).toISOString(), end: new Date(now-DAY).toISOString(), payload: { value: 81, unit: 'count/min' } };
  store.ingest(batch('move', [moved, { op: 'delete', typeIdentifier: rows[1].typeIdentifier, recordId: rows[1].recordId }]), 'move', now);
  store.db.exec("CREATE TRIGGER reject_batch BEFORE INSERT ON native_batches BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");
  assert.throws(() => store.ingest(batch('rolled-back', [{ ...rows[2], payload: { value: 99, unit: 'count/min' } }]), 'rolled-back', now));
  store.db.exec('DROP TRIGGER reject_batch');
  let actual = store.recentRecords(now);
  assert.equal(actual.length, 1399);
  assert.equal(actual.find(r => r.recordId === 'change-0').payload.value, 81);
  assert.equal(actual.find(r => r.recordId === 'change-0').end, moved.end);
  assert.equal(actual.find(r => r.recordId === 'change-2').payload.value, 72);
  assert.ok(!actual.some(r => r.recordId === 'change-1'));
  store.close(); ({ store } = open()); t.after(() => store.close()); actual = store.recentRecords(now);
  assert.equal(actual.length, 1399);
  assert.equal(actual.find(r => r.recordId === 'change-0').payload.value, 81);
});
