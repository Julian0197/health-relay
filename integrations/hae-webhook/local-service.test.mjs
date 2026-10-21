import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeStore } from './native-store.mjs';
import { createHandler } from './local-service.mjs';
test('local ingress authenticates, commits real SQLite data, and protects status', async t => {
  assert.equal(typeof createHandler, 'function', 'local native HTTP handler must exist');
  const dir = mkdtempSync(join(tmpdir(), 'healthrelay-http-')), store = new NativeStore(join(dir, 'health.sqlite'));
  const server = createServer(createHandler(store, { authKey: 'private-test-key', maxBytes: 4096 }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url+'/status')).status, 401);
  const headers = { 'X-Acceptance-Key': 'private-test-key', 'Idempotency-Key': 'b' };
  const body = JSON.stringify({ schemaVersion: 1, batchId: 'b', records: [{ op: 'upsert', typeIdentifier: 'HKQuantityTypeIdentifierHeartRate',
    recordId: 'h', start: new Date(Date.now()-60000).toISOString(), end: new Date(Date.now()-60000).toISOString(), source: { id: 'watch' }, payload: { value: 72, unit: 'count/min' } }] });
  assert.equal((await fetch(url+'/ingest', { method: 'POST', body })).status, 401);
  const response = await fetch(url+'/ingest', { method: 'POST', headers, body });
  assert.equal(response.status, 200); assert.equal((await response.json()).committed, true);
  const state = await (await fetch(url+'/status', { headers })).json();
  assert.equal(state.recordCount, 1); assert.equal(state.indices.displayedHeart.value, 72);
  assert.match(state.title, /^⚪ 状态暂无｜睡眠暂无｜心率72次\/分｜今日步数暂无｜今日锻炼暂无｜同步时间: \d{2}\/\d{2} \d{2}:\d{2}｜详情 ↗$/);
  assert.equal((await fetch(url+'/ingest', { method: 'POST', headers, body: 'x'.repeat(5000) })).status, 413);
  assert.equal((await fetch(url+'/other', { headers })).status, 404);
});

test('CLI publisher updates only title and requires verified readback', async () => {
  const mod = await import('./local-service.mjs');
  assert.equal(typeof mod.cliPublisher, 'function', 'CLI publisher must exist');
  const calls = [];
  const execute = async (file, args) => {
    calls.push({ file, args });
    if (args.includes('+record-batch-update')) return { stdout: JSON.stringify({ ok: true, data: {} }) };
    return { stdout: JSON.stringify({ ok: true, data: { record_id_list: ['rec1'], fields: ['title'], data: [['心率72']] } }) };
  };
  const publish = mod.cliPublisher({ cli: '/test/lark-cli', baseToken: 'base', tableId: 'tbl1', recordId: 'rec1' }, execute);
  await publish('心率72');
  const args = calls[0].args;
  assert.deepEqual(JSON.parse(args[args.indexOf('--json')+1]), { update_records: { rec1: { title: '心率72' } } });
  const wrong = mod.cliPublisher({ cli: '/test/lark-cli', baseToken: 'base', tableId: 'tbl1', recordId: 'rec1' }, async () => ({ stdout: '{"ok":true,"data":{}}' }));
  await assert.rejects(wrong('title'), /signature_readback_failed/);
});
