import { timingSafeEqual } from './dashboard-auth.mjs';
import { nativeQuotaResponse } from './native-quota.mjs';
export { NativeHealthStore } from './native-health-store.mjs';
const reply = (status, error) => Response.json(error, { status, headers: { 'Cache-Control': 'no-store' } });
const MAX_BODY = 10 * 1024 * 1024;

export async function handleNativeRequest(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (path === '/healthz' && request.method === 'GET') return reply(200, { ok: true });
  const read = ['/status', '/dashboard'].includes(path);
  const write = ['/ingest', '/signature/refresh', '/dashboard-cache/refresh'].includes(path);
  if (!read && !write) return reply(404, { error: 'not_found' });
  if (request.method !== (read ? 'GET' : 'POST')) return reply(405, { error: 'method_not_allowed' });
  if (!env.NATIVE_API_KEY || !env.NATIVE_STORE) return reply(503, { error: 'not_configured' });
  if (!timingSafeEqual(request.headers.get('X-Acceptance-Key'), env.NATIVE_API_KEY)) return reply(401, { error: 'unauthorized' });
  let body;
  if (write) {
    if (Number(request.headers.get('Content-Length')) > MAX_BODY) return reply(413, { error: 'body_too_large' });
    const chunks = []; let size = 0;
    const reader = request.body?.getReader();
    if (reader) for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > MAX_BODY) { await reader.cancel(); return reply(413, { error: 'body_too_large' }); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    body = bytes;
  }
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const id = request.headers.get('Idempotency-Key'); if (id) headers.set('Idempotency-Key', id);
  try {
    const store = env.NATIVE_STORE.get(env.NATIVE_STORE.idFromName('personal'));
    return await store.fetch(new Request('https://native'+path+url.search, { method: request.method, headers, body }));
  } catch (error) { return nativeQuotaResponse(error) ?? reply(503, { error: 'storage_unavailable', retryable: true }); }
}
export default { fetch: handleNativeRequest };
