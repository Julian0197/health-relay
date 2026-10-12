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
