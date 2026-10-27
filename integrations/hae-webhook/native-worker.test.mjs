import test from 'node:test';
import assert from 'node:assert/strict';

// Missing native routing must be an assertion failure, not an import crash.
const native = await import('./native-worker.mjs').catch(() => ({}));
const env = () => ({ NATIVE_API_KEY: 'fixture-only', NATIVE_STORE: {
  idFromName: name => { assert.equal(name, 'personal'); return name; },
  get: () => ({ fetch: async request => Response.json({ path: new URL(request.url).pathname,
    key: request.headers.get('Idempotency-Key'), body: request.method === 'POST' ? await request.text() : null }) }),
} });

test('native ingestion works without group secrets and forwards the exact immutable body', async () => {
  assert.equal(typeof native.handleNativeRequest, 'function', 'native receiver is not implemented');
  const body = '{ "schemaVersion":1, "batchId":"one", "records":[] }';
  const response = await native.handleNativeRequest(new Request('https://fixture/ingest', {
    method: 'POST', headers: { 'X-Acceptance-Key': 'fixture-only', 'Idempotency-Key': 'one' }, body,
  }), env());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { path: '/ingest', key: 'one', body });
});

test('native diagnostics require authentication and healthz never implies business readiness', async () => {
  assert.equal(typeof native.handleNativeRequest, 'function', 'native receiver is not implemented');
  for (const path of ['/status', '/dashboard?range=7d']) {
    assert.equal((await native.handleNativeRequest(new Request('https://fixture'+path), env())).status, 401);
  }
  assert.equal((await native.handleNativeRequest(new Request('https://fixture/healthz'), {})).status, 200);
  assert.equal((await native.handleNativeRequest(new Request('https://fixture/ingest', { method: 'POST' }), {})).status, 503);
});

test('a Free storage quota failure asks clients to retain batches until the UTC reset', async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-27T10:00:00Z'));
  const bindings = env();
  bindings.NATIVE_STORE.get = () => ({ fetch: async () => { throw new Error('Exceeded allowed rows read in Durable Objects free tier.'); } });
  const response = await native.handleNativeRequest(new Request('https://fixture/status', { headers: { 'X-Acceptance-Key': 'fixture-only' } }), bindings);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Retry-After'), '50400');
  assert.deepEqual(await response.json(), { error: 'storage_read_quota_exceeded', retryable: true });
});
