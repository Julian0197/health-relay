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

function receiverFixture() {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query, ...values) { const rows = db.prepare(query).all(...values); return { one: () => rows[0], toArray: () => rows }; } };
  const receiver = new HealthRelayAcceptance({ storage: { sql, transactionSync(work) {
    db.exec('BEGIN');
    try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  } } });
  const request = (path, body) => receiver.fetch(new Request('https://test.example' + path, body === undefined ? {} :
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': body.batchId ?? '' }, body: JSON.stringify(body) }));
  return { db, request };
}

test('one scoped 503 preserves a batch for automatic retry without duplicate commits', async () => {
  const { db, request } = receiverFixture();
  try {
    const control = await request('/faults', { taskId: batch.taskId, failures: 1, retryAfterSeconds: 30, expiresInSeconds: 600 });
    assert.equal(control.status, 200);
    const failed = await request('/ingest', batch);
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get('Retry-After'), '30');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM batches').get().n, 0);
    const recovered = await request('/ingest', batch);
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).batchId, batch.batchId);
    assert.equal((await request('/ingest', batch)).status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM batches').get().n, 1);
    const metadata = await (await request('/attempts?taskId=' + batch.taskId)).json();
    assert.deepEqual(metadata.attempts.map(row => row.status), [200, 200, 503]);
    assert.equal(new Set(metadata.attempts.map(row => row.digest)).size, 1);
    assert.equal(new Set(metadata.attempts.map(row => row.batchId)).size, 1);
    assert.equal(JSON.stringify(metadata).includes('payload'), false);
    assert.equal(metadata.fault.remaining, 0);
  } finally { db.close(); }
});

test('failure injection is scoped, expires, and rejects invalid controls', async () => {
  const { db, request } = receiverFixture();
  try {
    assert.equal((await request('/faults', { taskId: batch.taskId, failures: 100, retryAfterSeconds: 30, expiresInSeconds: 600 })).status, 400);
    assert.equal((await request('/faults', { taskId: batch.taskId, failures: 1, retryAfterSeconds: 30, expiresInSeconds: 600 })).status, 200);
    assert.equal((await request('/ingest', { ...batch, taskId: 'another-task', batchId: 'another-batch' })).status, 200);
    db.prepare('UPDATE faults SET expires_at=? WHERE task_id=?').run(0, batch.taskId);
    assert.equal((await request('/ingest', batch)).status, 200);
    assert.equal((await request('/attempts')).status, 400);
  } finally { db.close(); }
});

test('fault controls require the same authentication as ingestion', async () => {
  const response = await worker.fetch(new Request('https://test.example/faults', { method: 'POST', body: '{}' }), { TEST_API_KEY: 'synthetic-key' });
  assert.equal(response.status, 401);
});

test('HEA receiver accepts workout and specialized families without a metrics array', () => {
  const start = '2026-10-13 10:00:00 +0800', end = '2026-10-13 10:30:00 +0800';
  const data = {
    workouts: [{ id: 'synthetic-workout', name: 'Running', start, end, duration: 1800, route: [{ latitude: 0, longitude: 0 }] }],
    symptoms: [{ start, end, name: 'Headache', severity: 'Mild', userEntered: true, source: 'Synthetic' }],
    cycleTracking: [{ start, end, name: 'Menstrual Flow', value: 'Medium' }],
    ecg: [{ start, end, classification: 'Sinus Rhythm', averageHeartRate: 70, voltageMeasurements: [], numberOfVoltageMeasurements: 0, samplingFrequency: 512, source: 'Synthetic' }],
    heartRateNotifications: [{ start, end, threshold: 100, heartRate: [], heartRateVariation: [] }],
    stateOfMind: [{ id: 'synthetic-mood', start: '2026-10-13T00:00:00Z', end: '2026-10-13T00:00:00Z', kind: 'daily_mood', valence: 0.5, labels: [], associations: [], valenceClassification: 'pleasant' }],
    medications: [{ start, end: null, displayText: 'Synthetic medication', form: 'Tablet', status: 'Taken', isArchived: false, dosage: 1, codings: [] }]
  };
  const result = normalizeHEA({ data }, 'all-families', 'task');
  assert.equal(result.records.length, 7);
  assert.equal(result.records[0].recordId, 'synthetic-workout');
  assert.deepEqual(result.records[0].payload.route, data.workouts[0].route);
  assert.deepEqual(result.records.map(record => record.typeIdentifier), Object.keys(data));
  assert.throws(() => normalizeHEA({ data: { workouts: [{ ...data.workouts[0], start: null }] } }, 'invalid', 'task'));
  assert.throws(() => normalizeHEA({ data: { unrecognizedFamily: [{}] } }, 'unknown', 'task'));
});

test('HEA paired and categorical metrics retain fields and stable correction identity', () => {
  const date = '2026-10-13 10:00:00 +0800';
  const data = { metrics: [
    { name: 'blood_pressure', units: 'mmHg', data: [{ date, systolic: 120, diastolic: 80 }] },
    { name: 'sexual_activity', units: 'count', data: [{ date, Unspecified: 0, 'Protection Used': 1, 'Protection Not Used': 0 }] }
  ] };
  const result = normalizeHEA({ data }, 'paired', 'task');
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].payload.systolic, 120);
  const firstID = result.records[0].recordId;
  data.metrics[0].data[0].systolic = 125;
  assert.equal(normalizeHEA({ data }, 'corrected', 'task').records[0].recordId, firstID);
});

test('acceptance receiver supports a complete workout above one MiB within the configured ten MiB limit', async () => {
  const { db, request } = receiverFixture();
  try {
    const workout = { ...batch, batchId: 'large-workout', records: [{ ...batch.records[0], typeIdentifier: 'HKWorkoutType',
      payload: { durationSeconds: 3600, routeEvidence: 'x'.repeat(1_048_576) } }] };
    const response = await request('/ingest', workout);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).accepted, 1);
    assert.equal((await request('/ingest', workout)).status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM batches').get().n, 1);
  } finally { db.close(); }
});
