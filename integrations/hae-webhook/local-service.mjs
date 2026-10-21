// Durable LAN receiver. Configuration and credentials live outside the repository.
import { createServer } from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeStore } from './native-store.mjs';
const exec = promisify(execFile);
export function createHandler(store, { authKey, maxBytes = 10485760, onCommit = () => {} }) {
  if (!authKey) throw Error('auth_key_required');
  const expected = Buffer.from(authKey);
  return async (request, response) => {
    const reply = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    if (request.method === 'GET' && request.url === '/healthz') return reply(200, { ok: true });
    const supplied = Buffer.from(request.headers['x-acceptance-key'] ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401, { error: 'unauthorized' });
    if (request.method === 'GET' && request.url === '/status') return reply(200, store.status());
    if (request.method !== 'POST' || request.url !== '/ingest') return reply(404, { error: 'not_found' });
    if (Number(request.headers['content-length']) > maxBytes) { request.resume(); return reply(413, { error: 'body_too_large' }); }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBytes) { reply(413, { error: 'body_too_large' }); return; }
        chunks.push(chunk);
      }
      const receipt = store.ingest(Buffer.concat(chunks).toString('utf8'), request.headers['idempotency-key']);
      reply(200, receipt); onCommit();
    } catch (error) { if (!response.headersSent) reply(error.status ?? 500, { error: error.status ? error.message : 'storage_failure' }); }
  };
}
export function cliPublisher(binding, execute = exec) {
  const { cli, baseToken, tableId, recordId } = binding;
  if (![cli, baseToken, tableId, recordId].every(v => typeof v === 'string' && v)) throw Error('signature_binding_required');
  const common = ['--base-token', baseToken, '--table-id', tableId, '--as', 'user'];
  const call = async args => {
    let output;
    try { output = await execute(cli, ['base', ...args, ...common], { timeout: 20000, maxBuffer: 1048576,
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } }); }
    catch { throw Error('signature_cli_failed'); }
    const result = JSON.parse(output.stdout);
    if (!result.ok || result.data?.ignored_fields?.length) throw Error('signature_write_failed');
    return result.data;
  };
  return async title => {
    await call(['+record-batch-update', '--json', JSON.stringify({ update_records: { [recordId]: { title } } })]);
    const data = await call(['+record-get', '--record-id', recordId, '--field-id', 'title', '--format', 'json']);
    const row = data?.record_id_list?.indexOf(recordId), column = data?.fields?.indexOf('title');
    if (!(row >= 0 && column >= 0 && data.data?.[row]?.[column] === title)) throw Error('signature_readback_failed');
  };
}
export function startLocalService(config) {
  process.umask(0o077);
  const store = new NativeStore(config.database);
  const authKey = readFileSync(config.authFile, 'utf8').trim();
  const publish = config.signature ? cliPublisher(config.signature) : null;
  let running = null, lastAttempt = 0, retryAt = 0, failures = 0, stopping = false;
  const refresh = () => {
    const now = Date.now();
    if (!publish || running || stopping || now < retryAt || now-lastAttempt < 30000) return;
    lastAttempt = now;
    running = store.publish(publish, now).then(changed => {
      failures = 0; retryAt = 0;
      if (changed) console.log('Signature publication verified');
    }).catch(() => {
      failures++; retryAt = Date.now() + Math.min(900000, 30000 * 2**Math.min(failures-1, 5));
      console.error('Signature publication failed; retry scheduled');
    }).finally(() => { running = null; });
  };
  const server = createServer({ cert: readFileSync(config.cert), key: readFileSync(config.key) },
    createHandler(store, { authKey, onCommit: refresh }));
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  const timer = setInterval(refresh, 30000); timer.unref();
  server.listen(config.port ?? 18443, config.bind ?? '127.0.0.1', () => { console.log('HealthRelay durable HTTPS receiver ready'); refresh(); });
  const close = async () => {
    stopping = true; clearInterval(timer);
    await new Promise(resolve => server.close(resolve)); await running; store.close();
  };
  return { server, store, close };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const service = startLocalService(config);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { service.close().then(() => process.exit(0)); });
}
