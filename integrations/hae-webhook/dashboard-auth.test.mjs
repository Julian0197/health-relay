import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyViewerToken, allowedViewerOpenIds, viewerConfigured } from './dashboard-auth.mjs';

const OWNER = 'ou_owner';
const OTHER = 'ou_other';
const env = {
  DASHBOARD_VIEWER_SECRET: 'unit-test-shared-secret',
  DASHBOARD_VIEWER_OPENIDS: ` ${OWNER}, ${OTHER} `,
};

const enc = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

async function sign(payload, secret = env.DASHBOARD_VIEWER_SECRET) {
  const part = b64url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(part))));
  return `${part}.${sig}`;
}
const mint = (overrides = {}, secret) => sign({ sub: OWNER, iat: 1_000_000, exp: 1_000_000 + 5 * 60000, ...overrides }, secret);
const T = 1_000_000 + 60000;

test('allowlist parses and configuration gating works', () => {
  assert.deepEqual(allowedViewerOpenIds(env), [OWNER, OTHER]);
  assert.equal(viewerConfigured(env), true);
  assert.equal(viewerConfigured({}), false);
  assert.equal(viewerConfigured({ DASHBOARD_VIEWER_SECRET: 'x' }), false);
});

test('valid assertion for an allowlisted viewer passes', async () => {
  const result = await verifyViewerToken(await mint(), env, T);
  assert.deepEqual(result, { ok: true, sub: OWNER });
});

test('unknown viewer, bad signature and tampering are rejected', async () => {
  assert.equal((await verifyViewerToken(await mint({ sub: 'ou_stranger' }), env, T)).reason, 'viewer_not_allowed');
  assert.equal((await verifyViewerToken(await mint({}, 'wrong-secret'), env, T)).reason, 'bad_signature');
  const good = await mint();
  const [, sig] = good.split('.');
  // Same valid window/allowlist, but a different payload part -> stale HMAC must fail.
  const tampered = `${b64url(enc.encode(JSON.stringify({ sub: OTHER, iat: 1_000_000, exp: 1_000_000 + 5 * 60000 })))}.${sig}`;
  assert.equal((await verifyViewerToken(tampered, env, T)).reason, 'bad_signature');
});

test('expired, future-dated, non-positive and overlong assertions are rejected', async () => {
  assert.equal((await verifyViewerToken(await mint(), env, 1_000_000 + 5 * 60000)).reason, 'token_expired');
  assert.equal((await verifyViewerToken(await mint({ iat: T + 120000, exp: T + 180000 }), env, T)).reason, 'token_window_invalid');
  assert.equal((await verifyViewerToken(await mint({ iat: 0, exp: 1_000_000 + 60000 }), env, T)).reason, 'token_window_invalid');
  // Regression: the signer must not be able to widen the window. A 10-minute
  // assertion used to pass at minute 6 because the verifier hard-coded a 10-minute cap.
  const tenMinute = await mint({ iat: 1_000_000, exp: 1_000_000 + 10 * 60000 });
  assert.equal((await verifyViewerToken(tenMinute, env, 1_000_000 + 6 * 60000)).reason, 'token_window_invalid');
  // Zero/negative lifetime is invalid even before the expiry check.
  assert.equal((await verifyViewerToken(await mint({ iat: 1_000_000, exp: 1_000_000 }), env, T)).reason, 'token_window_invalid');
});

test('malformed strings and payloads never throw', async () => {
  for (const token of ['', null, 'a.b.c', 'a.!.!', 'x'.repeat(3000), `${b64url(enc.encode('not-json'))}.sig`]) {
    const result = await verifyViewerToken(token, env, T);
    assert.equal(result.ok, false, `token=${String(token).slice(0, 12)}`);
  }
  for (const payload of [{ sub: 123, iat: T, exp: T }, { sub: OWNER }, {}]) {
    assert.equal((await verifyViewerToken(await sign(payload), env, T)).reason, 'malformed_payload');
  }
});

test('when viewer auth is unconfigured every assertion is refused', async () => {
  assert.equal((await verifyViewerToken(await mint(), { DASHBOARD_VIEWER_SECRET: '', DASHBOARD_VIEWER_OPENIDS: '' }, T)).reason, 'viewer_auth_disabled');
});
