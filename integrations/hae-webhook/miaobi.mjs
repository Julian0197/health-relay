// Publication transport and scheduling. Physiology decisions are computed separately.
const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
export const SIGNATURE_COALESCE_MS = 30000;
export const PHYSIOLOGY_WRITE_INTERVAL_MS = 2 * MINUTE;
const stamp = time => new Date(time + 8 * 3600000).toISOString().slice(5, 16).replace('T', ' ');
export const signatureEnabled = env => env.SIGNATURE_ENABLED === 'true' &&
  ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'SIGNATURE_BASE_TOKEN', 'SIGNATURE_TABLE_ID', 'SIGNATURE_RECORD_ID'].every(key => Boolean(env[key]));

export function planPhysiologySignature(previous, now, decision) {
  const state = previous ? { ...previous } : { lastSentAt: null, sentTitle: null, dueAt: null, attempts: 0, error: null };
  state.mode = decision.mode ?? 'physiology-v2';
  state.decisionState = decision.state;
  state.validUntil = decision.validUntil;
  // Missing / expired evidence leaves the complete published title and its measurement time alone.
  state.desiredTitle = decision.title ?? state.sentTitle;
  state.pending = Boolean(decision.title && state.desiredTitle !== state.sentTitle);
  state.urgent = state.pending && Boolean(decision.corrected || state.urgent);
  if (!state.pending) { state.dueAt = null; state.urgent = false; }
  else if (state.urgent && !state.error) state.dueAt = now;
  else if (state.dueAt === null || !state.error) state.dueAt = Math.min(state.dueAt ?? Infinity,
    Math.max(now + SIGNATURE_COALESCE_MS, (state.lastSentAt ?? 0) + PHYSIOLOGY_WRITE_INTERVAL_MS));
  return state;
}

export function planSignature(previous, now, changed) {
  if (!previous && !changed) return null;
  const state = previous ? { ...previous } : { lastSentAt: null, sentTitle: null, dueAt: null, attempts: 0, error: null };
  if (changed) { state.changedAt = now; state.validUntil = now + DAY; }
  const expired = now >= state.validUntil;
  state.desiredTitle = expired ? `⌚ 健康数据待更新 · 最近同步 ${stamp(state.changedAt)}` : `⌚ 健康数据已同步 · ${stamp(state.changedAt)}`;
  state.pending = state.desiredTitle !== state.sentTitle;
  if (!state.pending) state.dueAt = null;
  else if (state.dueAt === null) state.dueAt = expired ? now : Math.max(now + MINUTE, (state.lastSentAt ?? 0) + 30 * MINUTE);
  return state;
}

export class MiaobiPublisher {
  constructor(env, send = fetch, clock = Date.now) {
    this.env = env; this.send = send; this.clock = clock; this.token = null;
  }

  async request(path, method, body, token) {
    let response;
    try {
      const send = this.send; // Workers native fetch requires its global receiver.
      response = await send(`https://open.feishu.cn/open-apis/${path}`, {
        method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(8000),
      });
    } catch { return { ok: false, error: { reason: 'network_error' } }; }
    if (!response.ok) {
      const retry = response.headers.get('Retry-After');
      const delay = retry && (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - this.clock());
      return { ok: false, error: { reason: 'http_error', status: response.status },
        ...(Number.isFinite(delay) && delay > 0 ? { retryAfterMs: delay } : {}) };
    }
    let data;
    try { data = await response.json(); } catch { return { ok: false, error: { reason: 'invalid_response' } }; }
    if (data.code !== 0) return { ok: false, error: { reason: 'feishu_rejected', ...(Number.isInteger(data.code) ? { code: data.code } : {}) } };
    return { ok: true, data };
  }

  async publish(title) {
    return this.withToken(async token => {
      const [base, table, record] = ['SIGNATURE_BASE_TOKEN', 'SIGNATURE_TABLE_ID', 'SIGNATURE_RECORD_ID'].map(k => encodeURIComponent(this.env[k]));
      const result = await this.request(`bitable/v1/apps/${base}/tables/${table}/records/${record}`, 'PUT', { fields: { title } }, token);
      if (!result.ok) return result;
      if (result.data.data?.record?.record_id !== this.env.SIGNATURE_RECORD_ID) return { ok: false, error: { reason: 'invalid_record_response' } };
      return { ok: true };
    });
  }

  // Runs a Feishu OpenAPI call with a cached tenant token, refreshing it once on auth errors.
  async withToken(run) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.token || this.token.expiresAt <= this.clock()) {
        const auth = await this.request('auth/v3/tenant_access_token/internal', 'POST', { app_id: this.env.FEISHU_APP_ID, app_secret: this.env.FEISHU_APP_SECRET });
        if (!auth.ok) return auth;
        if (!auth.data.tenant_access_token || !Number.isFinite(auth.data.expire) || auth.data.expire <= 60) return { ok: false, error: { reason: 'invalid_token_response' } };
        this.token = { value: auth.data.tenant_access_token, expiresAt: this.clock() + (auth.data.expire - 60) * 1000 };
      }
      const result = await run(this.token.value);
      if (result.error && [99991661, 99991663, 99991664, 99991668].includes(result.error.code) && attempt === 0) {
        this.token = null;
        continue;
      }
      return result;
    }
  }
}
