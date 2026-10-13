function reply(status, data) { return Response.json(data, { status }); }
function deliveryFailure(reason, detail = {}) {
  const data = { error: 'feishu_delivery_failed', reason, ...detail };
  console.error(JSON.stringify(data));
  return reply(502, data);
}

async function signedMessage(card, secret) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(`${timestamp}\n${secret}`),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array()));
  const sign = btoa(String.fromCharCode(...bytes));
  return { timestamp, sign, msg_type: 'interactive', card };
}

export async function deliverCard(card, env, send = fetch) {
  let failureStage = 'signing_error';
  let upstreamStatus;
  try {
    const body = await signedMessage(card, env.FEISHU_SIGN_SECRET);
    failureStage = 'network_error';
    const response = await send(env.FEISHU_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(8000),
    });
    upstreamStatus = response.status;
    if (!response.ok) return deliveryFailure('http_error', { upstream_status: upstreamStatus });
    failureStage = 'invalid_response';
    const result = await response.json();
    const code = result?.code ?? result?.StatusCode;
    if (!Number.isInteger(code)) return deliveryFailure('invalid_response', { upstream_status: upstreamStatus });
    if (code !== 0) return deliveryFailure('feishu_rejected', { upstream_status: upstreamStatus, upstream_code: code });
  } catch (error) {
    const reason = ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : failureStage;
    return deliveryFailure(reason, upstreamStatus === undefined ? {} : { upstream_status: upstreamStatus });
  }
  return reply(200, { ok: true, sent: true });
}
