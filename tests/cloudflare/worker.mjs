// Isolated acceptance fixture; never bind this class to a production namespace.
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const receipt = row => ({ batchId: row.id, committed: true, accepted: row.record_count, duplicates: 0 });
export function validateBatch(batch, idempotencyKey) {
  if (batch?.schemaVersion !== 1 || typeof batch.batchId !== 'string' || batch.batchId !== idempotencyKey ||
      typeof batch.taskId !== 'string' || !Array.isArray(batch.records) || !batch.records.length || batch.records.length > 500) return false;
  return batch.records.every(r => r && ['upsert', 'delete'].includes(r.op) &&
    typeof r.typeIdentifier === 'string' && r.typeIdentifier.length <= 200 &&
    typeof r.recordId === 'string' && r.recordId.length <= 200 &&
    (r.op === 'delete' || (Number.isFinite(Date.parse(r.start)) && Number.isFinite(Date.parse(r.end)) &&
      typeof r.source?.id === 'string' && r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload))));
}

// Acceptance adapter only. This verifies the chosen HEA profile, not every HEA receiver.
export function normalizeHEA(document, batchId, taskId) {
  const data = document?.data;
  const families = ['workouts', 'symptoms', 'cycleTracking', 'ecg', 'heartRateNotifications', 'stateOfMind', 'medications'];
  if (!batchId || !taskId || !data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).some(key => key !== 'metrics' && !families.includes(key))) throw new Error('invalid_hea');
  const records = [];
  if (data.metrics !== undefined) {
    if (!Array.isArray(data.metrics)) throw new Error('invalid_hea');
    for (const metric of data.metrics) {
      if (typeof metric?.name !== 'string' || !Array.isArray(metric.data)) throw new Error('invalid_metric');
      for (const point of metric.data) {
        const date = point?.date ?? point?.startDate;
        const quantity = [point?.qty, point?.Avg, point?.Min, point?.Max, point?.totalSleep].some(Number.isFinite);
        const pressure = Number.isFinite(point?.systolic) && Number.isFinite(point?.diastolic);
        const categorical = ['Unspecified', 'Protection Used', 'Protection Not Used'].some(key => Number.isFinite(point?.[key]));
        if (typeof date !== 'string' || !date || !(quantity || pressure || categorical)) throw new Error('invalid_point');
        records.push({ op: 'upsert', typeIdentifier: metric.name,
          recordId: JSON.stringify([date, point.endDate ?? '', point.source ?? '', point.value ?? '']),
          payload: { ...point, unit: metric.units } });
      }
    }
  }
  for (const family of families) {
    if (data[family] === undefined) continue;
    if (!Array.isArray(data[family])) throw new Error('invalid_family');
    for (const point of data[family]) {
      if (!point || typeof point.start !== 'string' || !point.start ||
          (point.end != null && typeof point.end !== 'string') ||
          (point.id !== undefined && (typeof point.id !== 'string' || !point.id))) throw new Error('invalid_entry');
      records.push({ op: 'upsert', typeIdentifier: family,
        recordId: point.id ?? JSON.stringify([point.start, point.end ?? '', point.name ?? point.displayText ?? '',
                                             point.source ?? '', point.kind ?? '', point.scheduledDate ?? '']),
        payload: point });
    }
  }
  if (!records.length || records.length > 5000) throw new Error('invalid_count');
  return { batchId, taskId, records };
}

export function csvRows(text) {
  const rows = []; let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\n')) {
      row.push(value.replace(/\r$/, '')); value = '';
      if (char === '\n') { if (row.some(Boolean)) rows.push(row); row = []; }
    } else value += char;
  }
  if (quoted) throw new Error('invalid_csv');
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}
export async function normalizeCSV(bytes, contentType, batchId, taskId) {
  if (!batchId || !taskId) throw new Error('invalid_headers');
  const form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData();
  const records = [];
  for (const file of form.getAll('file')) {
    if (typeof file === 'string' || !file.name.endsWith('.csv')) throw new Error('invalid_file');
    const [columns, ...rows] = csvRows(await file.text());
    if (!columns || !rows.length) throw new Error('empty_csv');
    for (const row of rows) {
      if (row.length !== columns.length) throw new Error('invalid_row');
      const point = Object.fromEntries(columns.map((key, index) => [key, row[index]]));
      const date = point.Date ?? point['Start Date'];
      if (!date) throw new Error('missing_date');
      records.push({ op: 'upsert', typeIdentifier: file.name.slice(0, -4),
        recordId: JSON.stringify([date, point['End Date'] ?? '', point.Source ?? '', point.Stage ?? '']), payload: point });
    }
  }
  if (!records.length || records.length > 500) throw new Error('invalid_count');
  return { batchId, taskId, records };
}

export class HealthRelayAcceptance {
  constructor(ctx) {
    this.ctx = ctx; this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,digest TEXT NOT NULL,task_id TEXT NOT NULL,record_count INTEGER NOT NULL,received_at TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS records(task_id TEXT NOT NULL,type_id TEXT NOT NULL,record_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(task_id,type_id,record_id))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS stats(id INTEGER PRIMARY KEY CHECK(id=1),batches INTEGER NOT NULL DEFAULT 0,events INTEGER NOT NULL DEFAULT 0,last_batch_id TEXT,last_received_at TEXT)');
    this.sql.exec('INSERT OR IGNORE INTO stats(id) VALUES(1)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS faults(task_id TEXT PRIMARY KEY,remaining INTEGER NOT NULL,retry_after INTEGER NOT NULL,expires_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,batch_id TEXT NOT NULL,digest TEXT NOT NULL,status INTEGER NOT NULL,record_count INTEGER NOT NULL,received_at TEXT NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS attempts_task ON attempts(task_id,id)');

  }
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/faults' && request.method === 'POST') {
      let control;
      try { const body = await request.text(); if (body.length > 1024) throw new Error('too_large'); control = JSON.parse(body); }
      catch { return json({ error: 'invalid_fault' }, 400); }
      const { taskId, failures, retryAfterSeconds, expiresInSeconds } = control ?? {};
      if (typeof taskId !== 'string' || !taskId || taskId.length > 200 ||
          !Number.isInteger(failures) || failures < 0 || failures > 3 ||
          !Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 1 || retryAfterSeconds > 300 ||
          !Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 1800) return json({ error: 'invalid_fault' }, 400);
      const expiresAt = Date.now() + expiresInSeconds * 1000;
      this.sql.exec('INSERT INTO faults(task_id,remaining,retry_after,expires_at) VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET remaining=excluded.remaining,retry_after=excluded.retry_after,expires_at=excluded.expires_at', taskId, failures, retryAfterSeconds, expiresAt);
      return json({ environment: 'acceptance-only', taskId, remaining: failures, expiresAt });
    }
    if (path === '/attempts' && request.method === 'GET') {
      const task = url.searchParams.get('taskId');
      if (!task || task.length > 200) return json({ error: 'invalid_inspection' }, 400);
      const attempts = this.sql.exec('SELECT batch_id AS batchId,digest,status,record_count AS recordCount,received_at AS receivedAt FROM attempts WHERE task_id=? ORDER BY id DESC LIMIT 20', task).toArray();
      const fault = this.sql.exec('SELECT remaining,retry_after AS retryAfterSeconds,expires_at AS expiresAt FROM faults WHERE task_id=?', task).toArray()[0] ?? null;
      return json({ environment: 'acceptance-only', attempts, fault });
    }
    if (path === '/status' && request.method === 'GET') {
      const stats = this.sql.exec('SELECT batches,events,last_batch_id,last_received_at FROM stats WHERE id=1').one();
      const task = url.searchParams.get('taskId');
      const types = [...new Set(url.searchParams.getAll('type'))];
      if (types.length > 10 || types.some(type => type.length > 200) || (task?.length ?? 0) > 200) return json({ error: 'invalid_inspection' }, 400);
      const presentTypes = task ? types.filter(type => this.sql.exec('SELECT type_id FROM records WHERE task_id=? AND type_id=? LIMIT 1', task, type).toArray().length) : [];
      return json({ ok: true, environment: 'acceptance-only', ...stats, presentTypes });
    }
    if (path === '/inspect' && request.method === 'GET') {
      const task = url.searchParams.get('taskId'), type = url.searchParams.get('type');
      if (!task || !type || task.length > 200 || type.length > 200) return json({ error: 'invalid_inspection' }, 400);
      const rows = this.sql.exec('SELECT record_id,body FROM records WHERE task_id=? AND type_id=? ORDER BY record_id DESC LIMIT 5', task, type).toArray();
      return json({ environment: 'acceptance-only', records: rows.map(row => JSON.parse(row.body)) });
    }
    if (!['/ingest', '/ingest/hea', '/ingest/hea-csv'].includes(path) || request.method !== 'POST') return json({ error: 'not_found' }, 404);
    const reader = request.body?.getReader();
    if (!reader) return json({ error: 'invalid_body' }, 400);
    let size = 0, chunks = [];
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 10_485_760) { await reader.cancel(); return json({ error: 'body_too_large' }, 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let batch;
    try {
      if (path === '/ingest/hea-csv') {
        batch = await normalizeCSV(bytes, request.headers.get('Content-Type'), request.headers.get('Idempotency-Key'), request.headers.get('automation-id'));
      } else {
        const document = JSON.parse(new TextDecoder().decode(bytes));
        batch = path === '/ingest/hea' ? normalizeHEA(document, request.headers.get('Idempotency-Key'), request.headers.get('automation-id')) : document;
        if (path === '/ingest' && !validateBatch(batch, request.headers.get('Idempotency-Key'))) return json({ error: 'invalid_native_batch' }, 422);
      }
    } catch { return json({ error: 'invalid_export' }, 422); }
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    try {
      return this.ctx.storage.transactionSync(() => {
        const previous = this.sql.exec('SELECT id,digest,record_count FROM batches WHERE id=?', batch.batchId).toArray()[0];
        if (previous) {
          const status = previous.digest === digest ? 200 : 409;
          this.recordAttempt(batch, digest, status);
          return status === 200 ? json(receipt(previous)) : json({ error: 'batch_conflict' }, 409);
        }
        const fault = this.sql.exec('SELECT remaining,retry_after,expires_at FROM faults WHERE task_id=?', batch.taskId).toArray()[0];
        if (fault?.remaining > 0 && fault.expires_at > Date.now()) {
          this.sql.exec('UPDATE faults SET remaining=remaining-1 WHERE task_id=?', batch.taskId);
          this.recordAttempt(batch, digest, 503);
          return Response.json({ error: 'acceptance_injected_failure' }, { status: 503, headers: { 'Retry-After': String(fault.retry_after), 'Cache-Control': 'no-store' } });
        }
        for (const r of batch.records) {
          if (r.op === 'delete') this.sql.exec('DELETE FROM records WHERE task_id=? AND type_id=? AND record_id=?', batch.taskId, r.typeIdentifier, r.recordId);
          else this.sql.exec('INSERT INTO records(task_id,type_id,record_id,body) VALUES(?,?,?,?) ON CONFLICT(task_id,type_id,record_id) DO UPDATE SET body=excluded.body', batch.taskId, r.typeIdentifier, r.recordId, JSON.stringify(r));
        }
        const receivedAt = new Date().toISOString();
        this.sql.exec('INSERT INTO batches(id,digest,task_id,record_count,received_at) VALUES(?,?,?,?,?)', batch.batchId, digest, batch.taskId, batch.records.length, receivedAt);
        this.sql.exec('UPDATE stats SET batches=batches+1,events=events+?,last_batch_id=?,last_received_at=? WHERE id=1', batch.records.length, batch.batchId, receivedAt);
        this.recordAttempt(batch, digest, 200);
        return json({ batchId: batch.batchId, committed: true, accepted: batch.records.length, duplicates: 0 });
      });
    } catch { return json({ error: 'test_storage_unavailable' }, 503); }
  }
  recordAttempt(batch, digest, status) {
    this.sql.exec('INSERT INTO attempts(task_id,batch_id,digest,status,record_count,received_at) VALUES(?,?,?,?,?,?)', batch.taskId, batch.batchId, digest, status, batch.records.length, new Date().toISOString());
    this.sql.exec('DELETE FROM attempts WHERE id <= (SELECT MAX(id)-1000 FROM attempts)');
  }
}
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/healthz') return json({ ok: true, environment: 'acceptance-only' });
    if (!env.TEST_API_KEY || request.headers.get('X-API-Key') !== env.TEST_API_KEY) return json({ error: 'unauthorized' }, 401);
    return env.TEST_STORE.getByName('acceptance').fetch(request);
  }
};
