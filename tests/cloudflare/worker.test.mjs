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

function wideCSVRequest(text, id = 'wide-batch') {
  const boundary = 'synthetic-wide-csv';
  return new Request('https://test.example/ingest/hea-csv', { method: 'POST', headers: {
    'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Idempotency-Key': id, 'automation-id': 'wide-task'
  }, body: '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="HealthAutoExport.csv"\r\n'
    + 'Content-Type: text/csv; charset=utf-8\r\n\r\n' + text + '\r\n--' + boundary + '--\r\n' });
}

test('observed Chinese LF wide CSV groups heart and sleep fields into native record counts', async () => {
  const heart = ['心率 [最小值] (bpm)', '心率 [最大] (bpm)', '心率 [平均值] (bpm)'];
  const sleep = ['Total', '睡眠时长', '在床上', '核心', '深度', '快速动眼期', '清醒'].map(stage => `睡眠分析 [${stage}] (小时)`);
  const columns = ['日期/时间', ...heart, ...sleep, '步数 (步)'];
  const request = wideCSVRequest(columns.join(',') + '\n2026-02-02 00:00:00,50,90,60,7,7,8,4,1,2,0.5,\n');
  const batch = await normalizeCSV(await request.arrayBuffer(), request.headers.get('content-type'), 'wide', 'task');
  assert.equal(batch.records.length, 2, 'Three HR cells and seven sleep cells represent two native records');
  assert.deepEqual(batch.records.map(row => row.typeIdentifier), ['heart_rate', 'sleep_analysis']);
  assert.equal(batch.records[0].payload[heart[2]], 60);
  assert.equal(batch.records[1].payload[sleep[2]], 8);
  assert.equal(batch.records.some(row => '步数 (步)' in row.payload), false);
});

test('sparse wide metric pages and corrections retain other metrics with accurate receipts', async () => {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query, ...values) { const rows = db.prepare(query).all(...values); return { one: () => rows[0], toArray: () => rows }; } };
  const receiver = new HealthRelayAcceptance({ storage: { sql, transactionSync(work) {
    db.exec('BEGIN'); try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  } } });
  const headers = ['日期/时间', '心率 [最小值] (bpm)', '心率 [最大] (bpm)', '心率 [平均值] (bpm)', '步数 (步)', '睡眠分析 [Total] (小时)'];
  const send = (id, cells) => receiver.fetch(wideCSVRequest(headers.join(',') + '\n' + ['2026-02-02 00:00:00', ...cells].join(',') + '\n', id));
  try {
    for (const [id, cells, count] of [['heart', [50, 90, 60, '', ''], 1], ['sleep', ['', '', '', '', 7], 1],
      ['steps', ['', '', '', 10, ''], 1], ['corrected', [51, 91, 61, 12, ''], 2]]) {
      const response = await send(id, cells);
      assert.equal(response.status, 200);
      const receipt = await response.json();
      assert.equal(receipt.accepted + receipt.duplicates, count);
    }
    const replay = await send('corrected', [51, 91, 61, 12, '']);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).accepted, 2);
    const saved = db.prepare('SELECT type_id,body FROM records ORDER BY type_id').all();
    assert.equal(saved.length, 3);
    const points = Object.fromEntries(saved.map(row => [row.type_id, JSON.parse(row.body).payload]));
    assert.equal(points.heart_rate['心率 [平均值] (bpm)'], 61);
    assert.equal(points.sleep_analysis['睡眠分析 [Total] (小时)'], 7);
    assert.equal(points['csv:步数 (步)']['步数 (步)'], 12);
    assert.equal(db.prepare('SELECT events FROM stats').get().events, 5);
  } finally { db.close(); }
});

test('wide CSV rejects missing dates, duplicate columns and nonnumeric cells', async () => {
  for (const text of ['日期/时间,步数 (步)\n,10\n', '日期/时间,步数 (步),步数 (步)\n2026-02-02 00:00:00,10,20\n',
    '日期/时间,步数 (步)\n2026-02-02 00:00:00,=1+1\n']) {
    const request = wideCSVRequest(text);
    await assert.rejects(() => request.arrayBuffer().then(bytes => normalizeCSV(bytes, request.headers.get('content-type'), 'bad', 'task')));
  }
});

test('wide CSV group count follows the configured 5000 record limit', async () => {
  const normalize = async count => {
    const rows = Array.from({ length: count }, (_, index) => {
      const date = new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 19).replace('T', ' ');
      return date + ',1';
    });
    const request = wideCSVRequest('日期/时间,步数 (步)\n' + rows.join('\n') + '\n');
    return normalizeCSV(await request.arrayBuffer(), request.headers.get('content-type'), 'many', 'task');
  };
  assert.equal((await normalize(501)).records.length, 501);
  await assert.rejects(() => normalize(5001), /invalid_count/);
});
