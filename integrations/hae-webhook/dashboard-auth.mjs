// Viewer assertions for the personal health dashboard.
// The Miaobi FaaS verifies the Feishu login code server-side, checks that the
// viewer is the owner, and signs a short-lived assertion with a shared HMAC key.
// The Worker verifies that assertion without any Feishu round-trip and without
// exposing the HAE/analysis API keys to browsers. Pure Web Crypto (workerd-safe).
const encoder = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const b64urlDecode = text => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), ch => ch.charCodeAt(0));

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = encoder.encode(a), y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ (y[i] ?? 0);
  return diff === 0;
}

// Single source of truth for the assertion lifetime. The FaaS signer
// (integrations/miaobi-preview/dashboard-bridge.cjs) must mint exactly this TTL;
// the verifier rejects anything longer, so a diverging signer can never widen the window.
export const MAX_ASSERTION_TTL_MS = 5 * 60000;
const CLOCK_SKEW_MS = 60000;

export function viewerConfigured(env) {
  return Boolean(env.DASHBOARD_VIEWER_SECRET) && Boolean(env.DASHBOARD_VIEWER_OPENIDS);
}

export function allowedViewerOpenIds(env) {
  return String(env.DASHBOARD_VIEWER_OPENIDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Assertion: `${base64url(payload)}.${base64url(HMAC-SHA256(secret, payloadPart))}`
 * payload = { sub: open_id, iat: epochMs, exp: epochMs }
 * @returns {{ok: true, sub: string} | {ok: false, reason: string}}
 */
export async function verifyViewerToken(token, env, now = Date.now()) {
  if (!viewerConfigured(env)) return { ok: false, reason: 'viewer_auth_disabled' };
  if (typeof token !== 'string' || !/^[\w-]+\.[\w-]+$/.test(token) || token.length > 2048) {
    return { ok: false, reason: 'malformed_token' };
  }
  const [payloadPart, signaturePart] = token.split('.');
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadPart))); }
  catch { return { ok: false, reason: 'malformed_payload' }; }
  const sub = typeof payload?.sub === 'string' ? payload.sub : null;
  if (!sub || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) {
    return { ok: false, reason: 'malformed_payload' };
  }
  if (!allowedViewerOpenIds(env).includes(sub)) return { ok: false, reason: 'viewer_not_allowed' };
  // Short-lived, monotonic clock window. The TTL is a hard 5-minute cap shared
  // with the signer: a 10-minute assertion must be rejected at minute 6.
  const ttl = payload.exp - payload.iat;
  if (ttl <= 0 || ttl > MAX_ASSERTION_TTL_MS || payload.iat > now + CLOCK_SKEW_MS) {
    return { ok: false, reason: 'token_window_invalid' };
  }
  if (now >= payload.exp) return { ok: false, reason: 'token_expired' };

  const key = await crypto.subtle.importKey('raw', encoder.encode(env.DASHBOARD_VIEWER_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payloadPart))));
  if (!timingSafeEqual(signaturePart, expected)) return { ok: false, reason: 'bad_signature' };
  return { ok: true, sub };
}
