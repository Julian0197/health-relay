import test from 'node:test';
import assert from 'node:assert/strict';
import { BadgeCachePublisher, badgeCacheEnabled } from './badge-cache-publisher.mjs';

const env = { FEISHU_APP_ID: 'fixture-app', FEISHU_APP_SECRET: 'fixture-secret', BADGE_API_KEY: 'fixture-device-key',
  BADGE_CACHE_BASE_TOKEN: 'fixture-private-base', BADGE_CACHE_TABLE_ID: 'fixture-private-table', BADGE_CACHE_RECORD_ID: 'fixture-private-record' };
const cache = { version: 2, generatedAt: 1000, pressureValidUntil: null,
  payload: { v: 2, day: '2026-10-21', pressure: null } };
const auth = () => Response.json({ code: 0, tenant_access_token: 'fixture-tenant', expire: 7200 });

test('private publishing is enabled only with all dedicated record coordinates and existing app/device credentials', () => {
  assert.equal(badgeCacheEnabled(env), true);
  for (const key of Object.keys(env)) assert.equal(badgeCacheEnabled({ ...env, [key]: '' }), false, key);
  assert.equal(badgeCacheEnabled({}), false);
});

test('publisher updates exactly one configured private record with wrapper and a credential digest, never a raw key', async () => {
  const calls = [];
  const publisher = new BadgeCachePublisher(env, async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('token/internal')) return auth();
    const { fields } = JSON.parse(options.body);
    return Response.json({ code: 0, data: { record: { record_id: env.BADGE_CACHE_RECORD_ID, fields } } });
  }, () => 1000);
  assert.deepEqual(await publisher.publish(cache), { ok: true });
  const updates = calls.filter(call => !call.url.endsWith('token/internal'));
  assert.equal(updates.length, 1); assert.equal(updates[0].options.method, 'PUT');
  assert.match(updates[0].url, /apps\/fixture-private-base\/tables\/fixture-private-table\/records\/fixture-private-record$/);
  const { fields } = JSON.parse(updates[0].options.body);
  assert.deepEqual(Object.keys(fields).sort(), ['credential_sha256', 'payload']);
  assert.equal(fields.payload, JSON.stringify(cache));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.BADGE_API_KEY));
  assert.equal(fields.credential_sha256, Buffer.from(digest).toString('hex'));
  assert.equal(updates[0].options.body.includes(env.BADGE_API_KEY), false);
  assert.equal(updates[0].options.redirect, 'manual');
});

test('private publisher detects changed wrapper or digest echoes and wrong record without exposing field values', async () => {
  for (const corrupt of ['payload', 'credential_sha256', 'record_id']) {
    const publisher = new BadgeCachePublisher(env, async (url, options) => {
      if (url.endsWith('token/internal')) return auth();
      const { fields } = JSON.parse(options.body);
      return Response.json({ code: 0, data: { record: { record_id: corrupt === 'record_id' ? 'wrong' : env.BADGE_CACHE_RECORD_ID,
        fields: { ...fields, ...(corrupt === 'record_id' ? {} : { [corrupt]: 'wrong' }) } } } });
    });
    const result = await publisher.publish(cache);
    assert.equal(result.ok, false);
    assert.equal(result.error.reason, corrupt === 'record_id' ? 'invalid_record_response' : 'partial_record_response');
    assert.equal(JSON.stringify(result).includes(env.BADGE_API_KEY), false);
  }
});

test('private publisher propagates transport retry timing through the existing token transport', async () => {
  const publisher = new BadgeCachePublisher(env, async url => url.endsWith('token/internal') ? auth()
    : new Response('busy', { status: 429, headers: { 'Retry-After': '120' } }));
  const result = await publisher.publish(cache);
  assert.equal(result.ok, false); assert.equal(result.retryAfterMs, 120000);
  assert.deepEqual(result.error, { reason: 'http_error', status: 429 });
});
