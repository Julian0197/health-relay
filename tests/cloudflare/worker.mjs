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

export class HealthRelayAcceptance {
  constructor(ctx) {
    this.ctx = ctx; this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,digest TEXT NOT NULL,task_id TEXT NOT NULL,record_count INTEGER NOT NULL,received_at TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS records(task_id TEXT NOT NULL,type_id TEXT NOT NULL,record_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(task_id,type_id,record_id))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS stats(id INTEGER PRIMARY KEY CHECK(id=1),batches INTEGER NOT NULL DEFAULT 0,events INTEGER NOT NULL DEFAULT 0,last_batch_id TEXT,last_received_at TEXT)');
    this.sql.exec('INSERT OR IGNORE INTO stats(id) VALUES(1)');
  }
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/status' && request.method === 'GET') {
      const stats = this.sql.exec('SELECT batches,events,last_batch_id,last_received_at FROM stats WHERE id=1').one();
      const task = url.searchParams.get('taskId');
      const types = [...new Set(url.searchParams.getAll('type'))];
      if (types.length > 10 || types.some(type => type.length > 200) || (task?.length ?? 0) > 200) return json({ error: 'invalid_inspection' }, 400);
      const presentTypes = task ? types.filter(type => this.sql.exec('SELECT type_id FROM records WHERE task_id=? AND type_id=? LIMIT 1', task, type).toArray().length) : [];
      return json({ ok: true, environment: 'acceptance-only', ...stats, presentTypes });
    }
    if (path !== '/ingest' || request.method !== 'POST') return json({ error: 'not_found' }, 404);
    const reader = request.body?.getReader();
    if (!reader) return json({ error: 'invalid_body' }, 400);
    let size = 0, chunks = [];
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 1_048_576) { await reader.cancel(); return json({ error: 'body_too_large' }, 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let batch;
    try { batch = JSON.parse(new TextDecoder().decode(bytes)); } catch { return json({ error: 'invalid_json' }, 400); }
    if (!validateBatch(batch, request.headers.get('Idempotency-Key'))) return json({ error: 'invalid_native_batch' }, 422);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    try {
      return this.ctx.storage.transactionSync(() => {
        const previous = this.sql.exec('SELECT id,digest,record_count FROM batches WHERE id=?', batch.batchId).toArray()[0];
        if (previous) return previous.digest === digest ? json(receipt(previous)) : json({ error: 'batch_conflict' }, 409);
        for (const r of batch.records) {
          if (r.op === 'delete') this.sql.exec('DELETE FROM records WHERE task_id=? AND type_id=? AND record_id=?', batch.taskId, r.typeIdentifier, r.recordId);
          else this.sql.exec('INSERT INTO records(task_id,type_id,record_id,body) VALUES(?,?,?,?) ON CONFLICT(task_id,type_id,record_id) DO UPDATE SET body=excluded.body', batch.taskId, r.typeIdentifier, r.recordId, JSON.stringify(r));
        }
        const receivedAt = new Date().toISOString();
        this.sql.exec('INSERT INTO batches(id,digest,task_id,record_count,received_at) VALUES(?,?,?,?,?)', batch.batchId, digest, batch.taskId, batch.records.length, receivedAt);
        this.sql.exec('UPDATE stats SET batches=batches+1,events=events+?,last_batch_id=?,last_received_at=? WHERE id=1', batch.records.length, batch.batchId, receivedAt);
        return json({ batchId: batch.batchId, committed: true, accepted: batch.records.length, duplicates: 0 });
      });
    } catch { return json({ error: 'test_storage_unavailable' }, 503); }
  }
}
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/healthz') return json({ ok: true, environment: 'acceptance-only' });
    if (!env.TEST_API_KEY || request.headers.get('X-API-Key') !== env.TEST_API_KEY) return json({ error: 'unauthorized' }, 401);
    return env.TEST_STORE.getByName('acceptance').fetch(request);
  }
};
