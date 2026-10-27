// Quota errors can occur during DO construction, before its fetch handler runs.
export function nativeQuotaResponse(error, now = Date.now()) {
  const match = /Exceeded allowed rows (read|written) in Durable Objects free tier/i.exec(error?.message ?? '');
  if (!match) return null;
  const day = 86400000, retry = Math.max(1, Math.ceil(((Math.floor(now/day)+1)*day-now)/1000));
  return Response.json({ error: `storage_${match[1] === 'read' ? 'read' : 'write'}_quota_exceeded`, retryable: true }, {
    status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': String(retry) },
  });
}
