import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { deliverCard } from './delivery.mjs';
import { summarizeHealth, buildHealthCard } from './health-card.mjs';
const env = {
  HAE_API_KEY: 'fixture-ingest-key',
  FEISHU_WEBHOOK_URL: 'https://open.larkoffice.com/open-apis/bot/v2/hook/fixture',
  FEISHU_SIGN_SECRET: 'fixture-sign-secret',
};
const payload = { data: { metrics: [
  { name: 'resting_heart_rate', units: 'count/min', data: [
    { date: '2026-09-23 09:00:00 +0800', qty: 60 },
    { date: '2026-09-22 09:00:00 +0800', qty: 70 },
  ] },
  { name: 'heart_rate_variability', units: 'ms', data: [{ date: '2026-09-23T01:00:00Z', qty: 45.5 }] },
  { name: 'heart_rate', units: 'bpm', data: [{ date: '2026-09-23T01:00:00Z', Avg: 72, Min: 60, Max: 90 }] },
] } };
const request = () => buildHealthCard(summarizeHealth(payload));
const handleRequest = deliverCard;

test('one signed message uses latest samples, supports qty/Avg, and never leaks secrets', async () => {
  let sent = 0;
  const response = await handleRequest(request(), env, async (url, options) => {
    sent++;
    assert.equal(url, env.FEISHU_WEBHOOK_URL);
    assert.equal(options.redirect, 'manual');
    const body = JSON.parse(options.body);
    assert.equal(body.sign, createHmac('sha256', `${body.timestamp}\n${env.FEISHU_SIGN_SECRET}`).update('').digest('base64'));
    assert.equal(body.msg_type, 'interactive');
    assert.equal(body.card.schema, '2.0');
    const cardText = JSON.stringify(body.card);
    assert.match(cardText, /静息心率：60/);
    assert.match(cardText, /HRV：45.5/);
    assert.match(cardText, /心率：72/);
    assert.doesNotMatch(cardText, /fixture|静息心率：70/);
    return Response.json({ code: 0 });
  });
  assert.equal(sent, 1);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sent, true);
});

test('Feishu business failure, HTTP failure and timeout remain upload failures', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const send of [async () => Response.json({ code: 19021 }),
    async () => new Response('error', { status: 500 }),
    async () => Response.json({}), async () => { throw new Error(env.FEISHU_WEBHOOK_URL); }]) {
    const response = await handleRequest(request(), env, send);
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /fixture|open.larkoffice/);
  }
});

test('delivery diagnostics distinguish failures without exposing upstream messages or secrets', async (t) => {
  const logs = [];
  t.mock.method(console, 'error', (entry) => logs.push(JSON.parse(entry)));
  const cases = [
    [async () => Response.json({ code: 19021, msg: env.FEISHU_SIGN_SECRET }),
      { reason: 'feishu_rejected', upstream_status: 200, upstream_code: 19021 }],
    [async () => new Response(env.FEISHU_WEBHOOK_URL, { status: 403 }),
      { reason: 'http_error', upstream_status: 403 }],
    [async () => new Response('', { status: 302, headers: { Location: env.FEISHU_WEBHOOK_URL } }),
      { reason: 'http_error', upstream_status: 302 }],
    [async () => new Response('<html>blocked</html>'),
      { reason: 'invalid_response', upstream_status: 200 }],
    [async () => Response.json(null),
      { reason: 'invalid_response', upstream_status: 200 }],
    [async () => { throw new DOMException(env.FEISHU_WEBHOOK_URL, 'TimeoutError'); },
      { reason: 'timeout' }],
    [async () => { throw new Error(env.FEISHU_WEBHOOK_URL); },
      { reason: 'network_error' }],
  ];
  for (const [send, detail] of cases) {
    const response = await handleRequest(request(), env, send);
    const expected = { error: 'feishu_delivery_failed', ...detail };
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), expected);
    assert.deepEqual(logs.at(-1), expected);
  }
  assert.doesNotMatch(JSON.stringify(logs), /fixture|open.larkoffice|blocked/);
});
