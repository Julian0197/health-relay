import { NativeRepository } from './native-repository.mjs';
import { MiaobiPublisher, signatureEnabled } from './miaobi.mjs';
import { DashboardCachePublisher, CACHE_HEART_BUCKET_MS } from './dashboard-cache.mjs';
import { buildDashboard, dashboardRange, contentHash } from './dashboard.mjs';
import { nativeQuotaResponse } from './native-quota.mjs';
const DAY = 86400000, HOUR = 3600000;
const PUBLISH_INTERVAL = 5*60000, REVIEW_INTERVAL = 15*60000;
const reply = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const midnight = now => Math.floor((now + 8*HOUR)/DAY)*DAY - 8*HOUR;
const initial = () => ({ dueAt: null, attempts: 0, error: null, lastPublishedAt: null });
const fieldText = v => Array.isArray(v) ? v.map(p => p.text ?? '').join('') : v;

export class NativeHealthStore {
  constructor(ctx, env, send = fetch, clock = Date.now) {
    this.storage = ctx.storage; this.env = env; this.clock = clock;
    this.sqlUsage = { rowsRead: 0, rowsWritten: 0 };
    const execute = (sql, ...params) => {
      const cursor = this.storage.sql.exec(sql, ...params), rows = cursor.toArray();
      this.sqlUsage.rowsRead += cursor.rowsRead ?? 0;
      this.sqlUsage.rowsWritten += cursor.rowsWritten ?? 0;
      return rows;
    };
    this.repo = new NativeRepository({
      all: execute,
      run: execute,
      transaction: fn => this.storage.transactionSync(fn),
    });
    const transport = (url, options) => send(new Request(url, options));
    this.signature = new MiaobiPublisher(env, transport, clock);
    this.dashboard = new DashboardCachePublisher(env, transport, clock);
    this.signatureEnabled = signatureEnabled(env);
    this.dashboardEnabled = Boolean(env.DASHBOARD_CACHE_BASE_TOKEN && env.DASHBOARD_CACHE_TABLE_ID &&
      env.DASHBOARD_CACHE_RECORD_ID && env.FEISHU_APP_ID && env.FEISHU_APP_SECRET &&
      env.DASHBOARD_CACHE_BASE_TOKEN !== env.SIGNATURE_BASE_TOKEN);
    this.refreshing = null;
  }
  status(now = this.clock()) {
    return { ...this.repo.status(now), signatureDelivery: this.repo.state('signatureDelivery'),
      dashboardCache: this.repo.state('dashboardCache'), nextReviewAt: this.repo.state('nextReviewAt'),
      publicationEnabled: { signature: this.signatureEnabled, dashboard: this.dashboardEnabled },
      seriesReadStats: this.repo.readStats, sqlUsage: { ...this.sqlUsage } };
  }
  async fetch(request) {
    const url = new URL(request.url), now = this.clock();
    try {
      if (request.method === 'GET' && url.pathname === '/status') return reply(this.status(now));
      if (request.method === 'GET' && url.pathname === '/dashboard') {
        const range = dashboardRange(url.searchParams.get('range') ?? '24h');
        if (!range) return reply({ error: 'invalid_range' }, 400);
        return reply(this.buildView(range, this.repo.view(now, { range }), now));
      }
      if (request.method !== 'POST') return reply({ error: 'not_found' }, 404);
      if (['/signature/refresh', '/dashboard-cache/refresh'].includes(url.pathname)) {
        await this.enqueue(now, true); await this.refresh(now);
        return reply(this.status(now));
      }
      if (url.pathname !== '/ingest') return reply({ error: 'not_found' }, 404);
      const minStart = Date.parse(this.env.NATIVE_MIN_START);
      if (!Number.isFinite(minStart)) return reply({ error: 'not_configured' }, 503);
      const body = await request.text();
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))]
        .map(v => v.toString(16).padStart(2, '0')).join('');
      const result = this.repo.commit(body, request.headers.get('Idempotency-Key'), digest, now, minStart);
      // Do not acknowledge until the durable scheduler has accepted responsibility.
      // A retry of an already committed batch repairs a failed alarm write as well.
      if (result.isNew) await this.enqueue(now);
      else await this.schedule(now, true);
      return reply(result.receipt);
    } catch (error) { return nativeQuotaResponse(error, now) ?? reply({ error: error.status ? error.message : 'storage_failure' }, error.status ?? 500); }
  }
  async enqueue(now, force = false) {
    for (const [key, enabled] of [['signatureDelivery', this.signatureEnabled], ['dashboardCache', this.dashboardEnabled]]) {
      if (!enabled) continue;
      const state = this.repo.state(key) ?? initial();
      state.revision = (state.revision ?? 0) + 1;
      const due = force ? now : Math.max(now+30000, (state.lastEvaluatedAt ?? state.lastPublishedAt ?? 0)+PUBLISH_INTERVAL);
      state.dueAt = state.dueAt === null ? due : Math.min(state.dueAt, due);
      this.repo.saveState(key, state);
    }
    await this.schedule(now, true);
  }
  async schedule(now, keepEarlier = false) {
    const times = [(this.signatureEnabled || this.dashboardEnabled) ? this.repo.state('nextReviewAt') : null,
      this.signatureEnabled ? this.repo.state('signatureDelivery')?.dueAt : null,
      this.dashboardEnabled ? this.repo.state('dashboardCache')?.dueAt : null].filter(Number.isFinite);
    const existing = await this.storage.getAlarm();
    if (times.length) {
      const at = Math.max(now+1000, Math.min(...times));
      if (existing !== at && (!keepEarlier || existing === null || existing > at)) await this.storage.setAlarm(at);
    } else if (existing !== null) await this.storage.deleteAlarm();
  }
  async publishTitle(title) {
    return this.signature.withToken(async token => {
      const [base, table, record] = ['SIGNATURE_BASE_TOKEN', 'SIGNATURE_TABLE_ID', 'SIGNATURE_RECORD_ID'].map(k => encodeURIComponent(this.env[k]));
      const path = `bitable/v1/apps/${base}/tables/${table}/records/${record}`;
      const write = await this.signature.request(path, 'PUT', { fields: { title } }, token);
      if (!write.ok) return write;
      const read = await this.signature.request(path, 'GET', undefined, token);
      if (!read.ok) return read;
      const actual = read.data.data?.record;
      return actual?.record_id === this.env.SIGNATURE_RECORD_ID && fieldText(actual.fields?.title) === title
        ? { ok: true } : { ok: false, error: { reason: 'signature_readback_failed' } };
    });
  }
  buildView(range, view, now) {
    const delivery = this.repo.state('signatureDelivery'), published = this.repo.state('publication');
    const durations = view.workoutDurations;
    const series = { ...view.series, workout: view.series.workout.map(w => ({ ...w,
      ...(Number.isFinite(durations.get(w.id)) ? { durationMs: durations.get(w.id)*1000 } : {}) })) };
    const dto = buildDashboard(series, now, { range, indices: view.status.indices,
      heartBucketMs: range === '7d' ? CACHE_HEART_BUCKET_MS : 60000,
      workoutHeart: view.workoutHeart, receivedAt: view.status.lastReceivedAt, publication: { mode: 'native-sdnn',
        sentTitle: published?.title ?? null, lastSentAt: published?.publishedAt ?? null,
        pending: Boolean(delivery?.dueAt), measuredAt: this.repo.state('publishedDecision')?.asOfAt ?? null } });
    for (const day of dto.daily) {
      const end = Math.min(now, Date.parse(day.date+'T00:00:00+08:00')+DAY-1);
      const activity = view.activityAt(end);
      if (Number.isFinite(activity.steps.value)) day.metrics.step_count = {
        v: Math.round(activity.steps.value), unit: 'count', source: activity.steps.label,
        sources: 1, conflict: false };
    }
    dto.channels = view.channels; dto.dataUpdatedAt = view.dataUpdatedAt;
    dto.activity = view.status.activity;
    const { contentHash: previousHash, ...content } = dto;
    dto.contentHash = contentHash(content);
    return dto;
  }
  async refresh(now = this.clock()) {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshOnce(now).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async refreshOnce(now) {
    const reception = this.repo.state('reception');
    if (!reception.batchCount) return this.schedule(now);
    const review = this.repo.state('nextReviewAt');
    const reviewing = Number.isFinite(review) && review <= now;
    const due = [['signatureDelivery', this.signatureEnabled], ['dashboardCache', this.dashboardEnabled]]
      .some(([key, enabled]) => enabled && Number.isFinite(this.repo.state(key)?.dueAt) && this.repo.state(key).dueAt <= now);
    if (!due && !reviewing) return this.schedule(now);
    const view = this.repo.view(now, { range: '7d' });
    for (const [key, enabled] of [['signatureDelivery', this.signatureEnabled], ['dashboardCache', this.dashboardEnabled]]) {
      if (!enabled) continue;
      const state = this.repo.state(key) ?? initial();
      if (!reviewing && !(Number.isFinite(state.dueAt) && state.dueAt <= now)) continue;
      state.lastEvaluatedAt = now;
      let result = { ok: true }, changed = false;
      if (key === 'signatureDelivery') {
        changed = this.repo.state('publication')?.title !== view.status.title;
        if (changed) result = await this.publishTitle(view.status.title);
        if (result.ok && changed) {
          this.repo.saveState('publication', { title: view.status.title, publishedAt: now });
          this.repo.saveState('publishedDecision', view.status.indices);
        }
      } else {
        const dto24h = this.buildView('24h', view, now), dto7d = this.buildView('7d', view, now);
        const hash = dto24h.contentHash+'/'+dto7d.contentHash;
        changed = hash !== state.hash;
        if (changed) result = await this.dashboard.publish({ payload24h: JSON.stringify(dto24h), payload7d: JSON.stringify(dto7d), generatedAt: new Date(now).toISOString() });
        if (result.ok) state.hash = hash;
      }
      if (result.ok) {
        state.dueAt = null; state.attempts = 0; state.error = null;
        if (changed) state.lastPublishedAt = now;
      } else {
        state.attempts++; state.error = result.error;
        state.dueAt = now + Math.max(result.retryAfterMs ?? 0, Math.min(900000, 30000 * 2**Math.min(state.attempts-1, 5)));
      }
      // A concurrent upload can enqueue a newer revision while Feishu I/O yields.
      // The completed write describes the old snapshot, so retain the newer work.
      const latest = this.repo.state(key);
      if (latest && (latest.revision !== state.revision || this.repo.state('reception').batchCount !== view.status.batchCount)) {
        state.revision = latest.revision;
        state.dueAt = result.ok
          ? Math.max(latest.dueAt ?? now+30000, now+PUBLISH_INTERVAL)
          : Math.max(state.dueAt, latest.dueAt ?? 0);
      }
      this.repo.saveState(key, state);
    }
    const boundaries = [midnight(now)+DAY, view.status.indices.validUntil,
      this.repo.state('publishedDecision')?.pressure?.evidenceAt + 7*DAY];
    // Window roll-off is grouped; actual state expiry and Beijing midnight stay exact.
    let rolloff = Infinity;
    for (const rows of Object.values(view.series)) for (const row of rows) for (const window of [DAY, 7*DAY]) {
      const at = row.end+window+1;
      if (at > now) rolloff = Math.min(rolloff, at);
    }
    if (Number.isFinite(rolloff)) boundaries.push(Math.ceil(rolloff/REVIEW_INTERVAL)*REVIEW_INTERVAL);
    this.repo.saveState('nextReviewAt', Math.min(...boundaries.filter(t => Number.isFinite(t) && t > now)));
    await this.schedule(now);
  }
  async alarm() { await this.refresh(); }
}
