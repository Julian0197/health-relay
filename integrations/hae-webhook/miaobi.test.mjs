import test from 'node:test';
import assert from 'node:assert/strict';
import { MiaobiPublisher, planSignature, planPhysiologySignature, signatureEnabled } from './miaobi.mjs';
const now = Date.parse('2026-09-27T02:00:00Z');
const env = { SIGNATURE_ENABLED: 'true', FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret', SIGNATURE_BASE_TOKEN: 'base', SIGNATURE_TABLE_ID: 'table', SIGNATURE_RECORD_ID: 'record' };

test('physiology publication retains full dated title on missing data; corrections bypass throttle', () => {
  const decision = { state: 'balanced', title: '🔵 状态正常 · 沿着自己的节奏向前\nHRV60·静息55｜09/27 09:30', validUntil: now + 3600000 };
  const first = planPhysiologySignature(null, now, decision);
  assert.equal(first.desiredTitle, decision.title);
  assert.equal(first.dueAt, now + 30000);
  assert.equal(planPhysiologySignature(first, now + 60000, decision).validUntil, decision.validUntil);
  const sent = { ...first, sentTitle: first.desiredTitle, lastSentAt: now, dueAt: null };
  const retained = planPhysiologySignature(sent, now + 7200000, { state: 'stale', title: null, validUntil: null });
  assert.equal(retained.pending, false);
  assert.equal(retained.desiredTitle, decision.title);
  const corrected = planPhysiologySignature(sent, now + 120000,
    { state: 'insufficient', title: '🫀 健康记录', corrected: true, validUntil: null });
  assert.equal(corrected.dueAt, now + 120000);
  assert.equal(planPhysiologySignature(null, now, { title: null }).pending, false);
});

test('signature requires explicit enable and complete configuration', () => {
  assert.equal(signatureEnabled(env), true);
  assert.equal(signatureEnabled({ ...env, SIGNATURE_ENABLED: 'false' }), false);
  assert.equal(signatureEnabled({ ...env, FEISHU_APP_SECRET: '' }), false);
});
test('coalesces live content changes; duplicate receipt cannot refresh title or expiry', () => {
  const first = planSignature(null, now, true);
  assert.equal(first.desiredTitle, '⌚ 健康数据已同步 · 09-27 10:00');
  assert.equal(first.dueAt, now + 60000);
  const duplicate = planSignature(first, now + 3600000, false);
  assert.equal(duplicate.changedAt, first.changedAt);
  assert.equal(duplicate.validUntil, first.validUntil);
  assert.equal(duplicate.desiredTitle, first.desiredTitle);
  assert.equal(planSignature(null, now, false), null);
  const latest = planSignature(first, now + 120000, true);
  assert.equal(latest.dueAt, first.dueAt);
  assert.match(latest.desiredTitle, /10:02/);
});
test('expiry queues a fallback without new uploads and bypasses normal write interval', () => {
  const first = planSignature(null, now, true);
  const sent = { ...first, pending: false, dueAt: null, sentTitle: first.desiredTitle, lastSentAt: first.validUntil - 1000 };
  const stale = planSignature(sent, first.validUntil, false);
  assert.equal(stale.desiredTitle, '⌚ 健康数据待更新 · 最近同步 09-27 10:00');
  assert.equal(stale.dueAt, first.validUntil);
  assert.equal(stale.pending, true);
});
test('updates only configured record title; token cached and API business status checked', async () => {
  const calls = [];
  const p = new MiaobiPublisher(env, async (url, opts) => {
    calls.push({ url, ...opts });
    return Response.json(url.endsWith('/internal') ? { code: 0, tenant_access_token: 'test-token', expire: 7200 } : { code: 0, data: { record: { record_id: 'record' } } });
  }, () => now);
  assert.deepEqual(await p.publish('test A'), { ok: true });
  assert.deepEqual(await p.publish('test B'), { ok: true });
  assert.equal(calls.length, 3);
  assert.equal(calls[1].method, 'PUT');
  assert.equal(calls[1].redirect, 'manual');
  assert.equal(calls[1].url, 'https://open.feishu.cn/open-apis/bitable/v1/apps/base/tables/table/records/record');
  assert.deepEqual(JSON.parse(calls[1].body), { fields: { title: 'test A' } });
});
test('token invalidation retries once; failures expose codes without bodies or credentials', async () => {
  let tokens = 0, writes = 0;
  const p = new MiaobiPublisher(env, async url => {
    if (url.endsWith('/internal')) { tokens++; return Response.json({ code: 0, tenant_access_token: 'private', expire: 7200 }); }
    writes++; return Response.json({ code: writes === 1 ? 99991663 : 91403, msg: 'private health data' });
  }, () => now);
  const result = await p.publish('test');
  assert.equal(tokens, 2); assert.equal(writes, 2);
  assert.equal(result.ok, false); assert.equal(result.error.code, 91403);
  assert.doesNotMatch(JSON.stringify(result), /private|secret/);
});
test('network errors and rate limits are retryable without exposing response bodies', async () => {
  const p = new MiaobiPublisher(env, async () => { throw new Error('secret'); });
  assert.equal((await p.publish('test')).error.reason, 'network_error');
  const q = new MiaobiPublisher(env, async () => new Response('private', { status: 429, headers: { 'Retry-After': '120' } }));
  const result = await q.publish('test');
  assert.equal(result.error.status, 429); assert.equal(result.retryAfterMs, 120000);
});

test('native Worker fetch is invoked without a publisher receiver', async () => {
  const p = new MiaobiPublisher(env, async function (url) {
    assert.equal(this, undefined, 'Workers fetch rejects an arbitrary this receiver');
    return Response.json(url.endsWith('/internal') ? { code: 0, tenant_access_token: 'token', expire: 7200 } : { code: 0, data: { record: { record_id: 'record' } } });
  });
  assert.equal((await p.publish('test')).ok, true);
});


test('numeric signatures coalesce for thirty seconds and limit writes to every two minutes', () => {
  const sent = { sentTitle: 'old', lastSentAt: now, dueAt: null, pending: false };
  const decision = { state: 'neutral', title: 'new', validUntil: null };
  const waiting = planPhysiologySignature(sent, now + 60000, decision);
  assert.equal(waiting.dueAt, now + 2 * 60000);
  const coalesced = planPhysiologySignature(waiting, now + 80000, { ...decision, title: 'newer' });
  assert.equal(coalesced.dueAt, waiting.dueAt);
  assert.equal(coalesced.desiredTitle, 'newer');
  assert.equal(planPhysiologySignature(sent, now + 6 * 60000, decision).dueAt, now + 6 * 60000 + 30000);
});

test('new timing brings an old five-minute queue forward without overriding failure backoff', () => {
  const previous = { sentTitle: 'old', lastSentAt: now, dueAt: now + 300000, pending: true, attempts: 0, error: null };
  const decision = { mode: 'health-indices-v1', title: 'new', validUntil: null };
  assert.equal(planPhysiologySignature(previous, now + 10000, decision).dueAt, now + 120000);
  const failed = { ...previous, attempts: 1, error: { reason: 'http_error', status: 429 } };
  assert.equal(planPhysiologySignature(failed, now + 10000, decision).dueAt, previous.dueAt);
});
