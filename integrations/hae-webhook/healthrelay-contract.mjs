// Swift encoder → actual Worker parser → SQLite domain store. No external HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRequest } from './worker.mjs';
import { HealthStore } from './health-store.mjs';
import { testSql } from './sql-test-helper.mjs';

test('importable HealthRelay profiles produce accepted, deduplicated service facts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'healthrelay-contract-'));
  try {
    const path = join(directory, 'swift-exports.json');
    execFileSync('swift', ['test', '--package-path', 'packages/HealthRelayCore', '--filter', 'ServiceAutomationTests'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { ...process.env, HEALTHRELAY_SERVICE_FIXTURES: path }, stdio: 'pipe', timeout: 180_000,
    });
    return checkDocuments(JSON.parse(readFileSync(path, 'utf8'))).finally(() => rmSync(directory, { recursive: true }));
  } catch (error) { rmSync(directory, { recursive: true }); throw error; }
});

async function checkDocuments(documents) {
  let state, alarm;
  const sql = testSql();
  const storage = {
    sql, get: async () => structuredClone(state), put: async (_, value) => { state = structuredClone(value); },
    setAlarm: async value => { alarm = value; },
    transaction: async fn => {
      const before = structuredClone(state), beforeAlarm = alarm;
      sql.exec('BEGIN');
      try { const result = await fn(storage); sql.exec('COMMIT'); return result; }
      catch (error) { sql.exec('ROLLBACK'); state = before; alarm = beforeAlarm; throw error; }
    },
  };
  const env = { HAE_API_KEY: 'fixture-only', FEISHU_SIGN_SECRET: 'fixture-only',
    FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture' };
  const store = new HealthStore({ storage }, env, async () => { throw new Error('Unexpected outbound HTTP'); });
  env.HEALTH_STORE = { idFromName: () => 'fixture', get: () => store };
  try {
    assert.deepEqual(documents.map(d => d.name), ['heart', 'hrv', 'activity', 'sleep', 'workouts']);
    for (const doc of documents) {
      const request = () => new Request(`https://health.example.com${doc.path}`, { method: 'POST',
        headers: { ...doc.headers, 'X-API-Key': env.HAE_API_KEY }, body: JSON.stringify(doc.body) });
      const first = await handleRequest(request(), env), body = await first.json();
      assert.equal(first.status, 200, `${doc.name}: ${JSON.stringify(body)}`);
      assert.equal(body.stored, true);
      assert.equal(body.stats.inserted, doc.recordCount);
      assert.equal(body.sent, false, 'HTTP ingestion is separate from group delivery');
      const retry = await (await handleRequest(request(), env)).json();
      assert.equal(retry.stats.inserted, 0);
      assert.equal(retry.stats.unchanged, doc.recordCount);
    }
    const status = await (await store.fetch(new Request('https://store/status'))).json();
    for (const stream of ['heart', 'hrv', 'health', 'sleep-segments', 'workouts']) assert.ok(status.streams[stream].receivedAt);
  } finally { sql.db.close(); }
}
