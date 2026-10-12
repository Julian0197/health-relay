import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { validateBatch } from './worker.mjs';
const batch = { schemaVersion: 1, taskId: 'synthetic-task', batchId: 'synthetic-batch', records: [{ op: 'upsert', typeIdentifier: 'synthetic', recordId: 'sample', start: '2026-10-12T00:00:00Z', end: '2026-10-12T00:00:00Z', source: { id: 'test.synthetic' }, payload: { value: 1 } }] };
test('requires native schema and batch id', () => {
  assert.equal(validateBatch(batch, batch.batchId), true);
  assert.equal(validateBatch(batch, 'different'), false);
  assert.equal(validateBatch({ ...batch, records: [{ ...batch.records[0], start: 'bad-date' }] }, batch.batchId), false);
});
test('authentication fails before storage access', async () => {
  const result = await worker.fetch(new Request('https://test.example/ingest', { method: 'POST' }), { TEST_API_KEY: 'synthetic-key' });
  assert.equal(result.status, 401);
});

import { normalizeHEA, normalizeCSV, csvRows, HealthRelayAcceptance } from './worker.mjs';
import { DatabaseSync } from 'node:sqlite';
const hea = value => ({ data: { metrics: [{ name: 'heart_rate', units: 'bpm', data: [{ date: '2026-10-12 12:00:00 +0800', Min: 50, Avg: value, Max: 80 }] }] } });
test('HEA aggregate corrections keep their window identity', () => {
  const a = normalizeHEA(hea(60), 'a', 't'), b = normalizeHEA(hea(70), 'b', 't');
  assert.equal(a.records[0].recordId, b.records[0].recordId);
  assert.notDeepEqual(a.records[0].payload, b.records[0].payload);
  assert.throws(() => normalizeHEA(hea(60), null, 't'));
});
test('multipart profile parses quoted cells and rejects missing dates', async () => {
  assert.deepEqual(csvRows('"Source","Value"\r\n"a,""b""","2"\r\n'), [['Source','Value'],['a,"b"','2']]);
  const form = new FormData(); form.append('file', new Blob(['"Date","Heart Rate Avg (bpm)"\r\n"2026-10-12 12:00:00 +0800","60"\r\n']), 'heart_rate.csv');
  const request = new Request('https://test.example', { method: 'POST', body: form });
  const parsed = await normalizeCSV(await request.arrayBuffer(), request.headers.get('content-type'), 'csv', 'task');
  assert.equal(parsed.records.length, 1); assert.equal(parsed.records[0].typeIdentifier, 'heart_rate');
});
test('transactional receipts replay safely and corrected windows replace one row', async () => {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query, ...values) { const rows = db.prepare(query).all(...values); return { one: () => rows[0], toArray: () => rows }; } };
  const receiver = new HealthRelayAcceptance({ storage: { sql, transactionSync(work) { db.exec('BEGIN'); try { const result = work(); db.exec('COMMIT'); return result; } catch(error) { db.exec('ROLLBACK'); throw error; } } } });
  const send = (id, value) => receiver.fetch(new Request('https://test.example/ingest/hea', { method: 'POST', headers: { 'Idempotency-Key': id, 'automation-id': 't' }, body: JSON.stringify(hea(value)) }));
  assert.equal((await send('a',60)).status, 200);
  assert.equal((await send('a',60)).status, 200);
  assert.equal((await send('a',70)).status, 409);
  assert.equal((await send('b',70)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM records').get().n, 1);
  assert.equal(JSON.parse(db.prepare('SELECT body FROM records').get().body).payload.Avg, 70);
  const stats = await (await receiver.fetch(new Request('https://test.example/status'))).json();
  assert.equal(stats.batches, 2); assert.equal(stats.events, 2);
  db.close();
});
