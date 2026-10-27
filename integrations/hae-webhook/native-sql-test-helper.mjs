// Node SQLite adapter for isolated cloud repository tests.
// The production local receiver keeps its existing NativeStore and RMSSD behavior.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { NativeRepository } from './native-repository.mjs';
export class NativeCloudTestStore extends NativeRepository {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(file);
    if (file !== ':memory:') chmodSync(file, 0o600);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    super({ all: (sql, ...params) => db.prepare(sql).all(...params),
      run: (sql, ...params) => db.prepare(sql).run(...params),
      transaction: fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; }
        catch (error) { db.exec('ROLLBACK'); throw error; } } });
    this.db = db;
  }
  close() { this.db.close(); }
  ingest(body, id, now = Date.now()) {
    return this.commit(body, id, createHash('sha256').update(body).digest('hex'), now).receipt;
  }
}
