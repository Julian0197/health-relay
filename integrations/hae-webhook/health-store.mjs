import { emptyState, mergeSummary, overview, fingerprint } from './health-state.mjs';
import { buildHealthCard } from './health-card.mjs';
import { buildOverviewCard } from './overview-card.mjs';
import { buildWorkoutHistory } from './workouts.mjs';
import { SeriesStore } from './series.mjs';
import { SqlUsage } from './sql-usage.mjs';
import { PressureHistory } from './pressure-history.mjs';
import { evaluateHealthIndices } from './health-indices.mjs';
import { pressureHeadline, renderHealthSignature, RETAINED_PRESSURE_MS } from './health-signature.mjs';
import { healthProfile } from './health-profile.mjs';
import { buildDashboard, dashboardRange, indicesView } from './dashboard.mjs';
import { analyze } from './analysis.mjs';
import { buildSignatureSnapshot } from './signature.mjs';
import { evaluatePhysiology, neutralPhysiology, withLatestHeartOverview } from './physiology.mjs';
import { deliverCard } from './delivery.mjs';
import { MiaobiPublisher, planSignature, planPhysiologySignature, signatureEnabled, PHYSIOLOGY_WRITE_INTERVAL_MS, SIGNATURE_COALESCE_MS } from './miaobi.mjs';
import { DashboardCachePublisher, dashboardCacheEnabled, CACHE_HEART_BUCKET_MS } from './dashboard-cache.mjs';

const HOUR = 3600000;
const CARD_WRITE_INTERVAL_MS = 5 * 60000;
const DASHBOARD_CACHE_THROTTLE_MS = 2 * 60000;
// With no changed data, retain the published snapshot until its actual expiry or midnight.
const PRESSURE_REPLAY_BATCH = 24;
const PRESSURE_REPLAY_INTERVAL_MS = 1000;
const INDICES_CACHE_VERSION = 'health-indices-cache-v6';
const initialDelivery = () => ({ pending: false, lastSentAt: null, sentContent: null, dueAt: null, attempts: 0, error: null });
const reply = data => Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
const nextMidnight = now => Math.floor((now + 8 * HOUR) / (24 * HOUR)) * 24 * HOUR + 16 * HOUR;

export class HealthStore {
  constructor(ctx, env, send = fetch, clock = Date.now) {
    this.storage = ctx.storage;
    this.env = env;
    this.healthProfile = healthProfile(env);
    this.send = send;
    this.clock = clock;
    this.signaturePublisher = new MiaobiPublisher(env, send, clock);
    this.dashboardCachePublisher = new DashboardCachePublisher(env, send, clock);
    this.sqlUsage = new SqlUsage(this.storage.sql);
    this.series = new SeriesStore(this.sqlUsage.sql);
    this.pressureHistory = new PressureHistory(this.sqlUsage.sql);
    this.dashboardPublishInFlight = false;
  }

  async transaction(fn) {
    try { return await this.storage.transaction(fn); }
    catch (error) {
      // SQL rollback must also discard samples and review times derived from an uncommitted write.
      this.series.invalidate();
      this.reviewCache = null;
      throw error;
    }
  }

  seriesForView(now) {
    return Object.fromEntries(['hrv', 'heart', 'sleep', 'daily', 'workout'].map(kind =>
      [kind, this.series.list(kind, now - (kind === 'heart' ? 7 : 35) * 86400000)]));
  }

  workoutHeart(series, now) {
    // Read older retained heart windows only for eligible workout intervals.
    // Keep the scorer and general signal chart on their existing seven-day scope.
    const older = series.workout.filter(w => w.start >= now - 30 * 86400000 && w.start < now - 7 * 86400000 &&
      w.end <= now && (w.durationMs ?? w.end - w.start) >= 20 * 60000);
    return [...series.heart, ...older.flatMap(w => this.series.listBetween('heart', w.start, w.end))];
  }

  analysis(now) {
    return analyze(this.seriesForView(now), now);
  }

  physiologySeries(now) {
    return Object.fromEntries(['hrv', 'sleep', 'daily', 'workout'].map(kind =>
      [kind, this.series.list(kind, now - 35 * 86400000)]));
  }

  // The title depends on recorded history; it is rendered once by refreshSignaturePresentation.
  evaluateIndices(series, now, previous = null) {
    return evaluateHealthIndices(series, now, previous, { profile: this.healthProfile });
  }

  healthIndices(series, now, previous = null) {
    return this.refreshSignaturePresentation(this.evaluateIndices(series, now, previous), now);
  }

  // Read-only reuse of the decision the signature and display copy were built from.
  cachedHealthIndices(state, now) {
    const cached = state.indicesCache;
    return cached?.key === JSON.stringify([INDICES_CACHE_VERSION, this.healthProfile]) &&
      cached.revision === (state.dataRevision ?? 0) && cached.decision.evaluatedAt <= now && cached.expiresAt > now
      ? structuredClone(cached.decision) : null;
  }

  currentHealthIndices(state, now, force = false) {
    const key = JSON.stringify([INDICES_CACHE_VERSION, this.healthProfile]);
    const cached = !force && this.cachedHealthIndices(state, now);
    if (cached) return cached;
    const series = { ...this.physiologySeries(now), heart: this.series.list('heart', now - 30 * 86400000) };
    const decision = this.evaluateIndices(series, now, state.signatureDelivery?.publishedDecision);
    this.pressureHistory.record(decision, now);
    this.refreshSignaturePresentation(decision, now);
    // Do not hide an accepted interval that becomes complete after this evaluation.
    const nextEvidence = Math.min(...Object.values(series).flatMap(rows => rows.map(row => row.end).filter(time => time > now)));
    state.indicesCache = { key, revision: state.dataRevision ?? 0,
      expiresAt: Math.min(nextMidnight(now), decision.validUntil ?? Infinity, nextEvidence), decision };
    return structuredClone(decision);
  }

  refreshSignaturePresentation(indices, now, history = this.pressureHistory.view(now, '24h')) {
    indices.lastValidPressure = this.pressureHistory.latest(now, indices.ruleVersion, indices.pressure.source);
    const retainedUntil = indices.lastValidPressure?.evidenceAt + RETAINED_PRESSURE_MS;
    if (indices.pressure.score === null && retainedUntil > now) {
      indices.validUntil = Math.min(indices.validUntil ?? Infinity, retainedUntil);
    }
    indices.headline = pressureHeadline(indices, now, history);
    indices.title = renderHealthSignature(indices, now, history);
    return indices;
  }

  queuePressureReplay(state, since, until, now) {
    const previous = state.pressureReplay;
    if (previous?.pending) {
      since = Math.min(since, previous.since);
      until = Math.max(until, previous.until);
    }
    since = Math.max(since, now - 7 * 24 * HOUR);
    until = Math.min(until, now - 60000);
    if (since > until) return;
    state.pressureReplay = { pending: true, since, until, cursor: since - 1,
      queuedAt: now, dueAt: now + PRESSURE_REPLAY_INTERVAL_MS, processed: 0, valid: 0, reasons: {} };
  }

  async replayPressure() {
    if (!(await this.storage.get('state'))?.pressureReplay?.pending) return;
    await this.transaction(async () => {
      const state = await this.storage.get('state'), job = state.pressureReplay, now = this.clock();
      if (!job?.pending || job.dueAt > now) return;
      const series = this.seriesForView(now);
      // Each historical anchor needs its own prior seven-day HR baseline.
      series.heart = this.series.list('heart', job.since - 30 * 24 * HOUR);
      const anchors = [...new Set(series.hrv.filter(r => r.method === 'RMSSD' &&
        r.start > job.cursor && r.start <= job.until).map(r => r.start))].sort((a, b) => a - b);
      for (const anchor of anchors.slice(0, PRESSURE_REPLAY_BATCH)) {
        const indices = evaluateHealthIndices({ ...series, hrv: series.hrv.filter(r => r.start <= anchor) }, anchor + 60000, null,
          { profile: this.healthProfile, awakeOnly: true });
        this.pressureHistory.record(indices, now, 'received_records_replay');
        job.cursor = anchor;
        job.processed++;
        if (Number.isFinite(indices.pressure.score)) job.valid++;
        else {
          const reason = indices.pressure.reason;
          job.reasons[reason] = (job.reasons[reason] ?? 0) + 1;
        }
      }
      job.pending = anchors.length > PRESSURE_REPLAY_BATCH;
      job.dueAt = job.pending ? now + PRESSURE_REPLAY_INTERVAL_MS : null;
      if (!job.pending) job.completedAt = now;
      delete state.indicesCache;
      // Re-render the current decision; historical receipt times never become current evidence.
      if (signatureEnabled(this.env) && this.env.SIGNATURE_MODE === 'health-indices-v1') {
        state.signatureDelivery = this.planSignature(state, now, false, { trigger: 'replay' });
      }
      if (dashboardCacheEnabled(this.env)) {
        state.dashboardCache ??= { lastPublishedAt: null, dueAt: null, error: null };
        state.dashboardCache.dueAt = Math.min(state.dashboardCache.dueAt ?? Infinity, now + 60000);
        state.dashboardCache.revision = (state.dashboardCache.revision ?? 0) + 1;
      }
      await this.save(state, now);
    });
  }

  physiology(now, previous) {
    const decision = evaluatePhysiology(this.physiologySeries(now), now, previous, { minimumHistorySamples: this.env.SIGNATURE_MIN_HISTORY_SAMPLES === '1' ? 1 : 2 });
    return withLatestHeartOverview(decision, this.series.list('heart', now - 7 * 86400000), now);
  }

  planSignature(state, now, changed = false, context = { trigger: 'alarm' }) {
    if (this.env.SIGNATURE_MODE === 'health-indices-v1') {
      const startedAt = this.clock();
      state.signatureCorrectionDecision = null;
      state.signatureCandidate = this.currentHealthIndices(state, now, ['refresh', 'replay'].includes(context.trigger));
      const delivery = planPhysiologySignature(state.signatureDelivery, now, state.signatureCandidate);
      // Keep the origin of the exact candidate across duplicate receipts and alarm re-evaluation.
      if (!delivery.candidateTiming || delivery.desiredTitle !== state.signatureDelivery?.desiredTitle) {
        const builtAt = this.clock();
        delivery.candidateTiming = { trigger: context.trigger, receivedAt: context.receivedAt ?? null,
          builtAt, buildMs: builtAt - startedAt };
      }
      return delivery;
    }
    if (this.env.SIGNATURE_MODE !== 'physiology-v2') {
      let previous = state.signatureDelivery;
      if (previous?.mode === 'physiology-v2') {
        const changedAt = previous.changedAt ?? state.lastReceivedAt;
        previous = { ...previous, mode: 'sync-status-v1', changedAt, validUntil: changedAt + 24 * HOUR };
      }
      return planSignature(previous, now, changed);
    }
    state.physiologyDecision = this.physiology(now, state.physiologyDecision);
    delete state.signatureActivationAt; // Retire the old bootstrap path; it could hide current exercise context.
    const published = state.signatureDelivery?.publishedDecision;
    if (changed && ['relaxed', 'balanced', 'tense', 'high'].includes(published?.state) && now - published.evaluatedAt < 34 * 24 * HOUR) {
      const revised = this.physiology(published.evaluatedAt, published);
      if (revised.title !== published.title) {
        const correction = state.physiologyDecision.title ? state.physiologyDecision : revised.title ? revised
          : neutralPhysiology({ ...this.physiologySeries(now), heart: this.series.list('heart', now - 7 * 24 * HOUR) }, now);
        state.signatureCorrectionDecision = { ...correction,
          title: correction.title ?? '🧭 按自己的节奏走', corrected: true };
      }
    }
    if (state.signatureCorrectionDecision) {
      state.physiologyDecision = state.physiologyDecision.title
        ? { ...state.physiologyDecision, corrected: true } : state.signatureCorrectionDecision;
    }
    state.signatureCandidate = state.physiologyDecision;
    if (!state.physiologyDecision.title && !['relaxed', 'balanced', 'tense', 'high'].includes(published?.state)) {
      state.signatureCandidate = neutralPhysiology({ ...this.physiologySeries(now),
        heart: this.series.list('heart', now - 7 * 24 * HOUR) }, now);
    }
    return planPhysiologySignature(state.signatureDelivery, now, state.signatureCandidate);
  }

  // Publication facts carried into the dashboard: what is live, when it was written and from which measurement.
  publicationView(state) {
    const signature = state.signatureDelivery;
    return { mode: ['physiology-v2', 'health-indices-v1'].includes(this.env.SIGNATURE_MODE) ? this.env.SIGNATURE_MODE : 'sync-status-v1',
      sentTitle: signature?.sentTitle ?? null, lastSentAt: signature?.lastSentAt ?? null, pending: signature?.pending ?? false,
      measuredAt: signature?.publishedDecision?.asOfAt ?? null };
  }

  // Let a signature write that is about to land go first, so the display copy shows the live title.
  dashboardDueAt(state, at) {
    const signature = signatureEnabled(this.env) ? state.signatureDelivery : null;
    return signature?.pending && !signature.error && signature.dueAt <= at + PHYSIOLOGY_WRITE_INTERVAL_MS
      ? Math.max(at, signature.dueAt + 1000) : at;
  }

  dataTimes(now) {
    const times = {};
    for (const kind of ['hrv', 'heart', 'daily', 'sleep', 'workout']) {
      for (const row of this.series.list(kind, now - 35 * 86400000)) {
        const metric = row.metric ?? (kind === 'hrv' && row.method === 'RMSSD' ? 'heart_rate_variability_rmssd'
          : ({ hrv: 'heart_rate_variability', heart: 'heart_rate', sleep: 'sleep_analysis', workout: 'workouts' })[kind]);
        const field = kind === 'daily' ? 'latestDataDate' : ['sleep', 'workout'].includes(kind) ? 'latestIntervalEnd' : 'latestSampleAt';
        const value = kind === 'daily' ? new Date(row.start + 8 * HOUR).toISOString().slice(0, 10) : field === 'latestIntervalEnd' ? row.end : row.start;
        if (!times[metric] || value > times[metric][field]) times[metric] = { [field]: value };
      }
    }
    return times;
  }

  view(state, now) {
    const view = overview(state, now);
    const analysis = this.analysis(now);
    const hrvRows = this.series.list('hrv', now - 7 * 86400000).filter(r => r.start <= now);
    const hrv = hrvRows.filter(r => r.method === 'SDNN').at(-1);
    const rmssd = hrvRows.filter(r => r.method === 'RMSSD').at(-1);
    const details = [
      ['heart_rate_variability', 'HRV', hrv?.aggregation ?? 'raw', hrv?.start, hrv?.value, 'ms', 'SDNN'],
      ['heart_rate_variability_rmssd', '恢复 HRV（RMSSD）', rmssd?.aggregation ?? 'raw', rmssd?.start, rmssd?.value, 'ms', 'RMSSD'],
      ['heart_rate', '心率', 'minutes', analysis.heart.measuredAt, analysis.heart.value, '次/分', null],
    ];
    for (const [name, label, aggregation, time, value, unit, method] of details) {
      if (!Number.isFinite(time) || now - time > 7 * 86400000) continue;
      view.metrics = view.metrics.filter(m => m.name !== name);
      view.metrics.push({ name, label, aggregation, latest: { time, value: `${Math.round(value * 100) / 100} ${unit}`, details: [...(name === 'heart_rate' ? ['该分钟窗口均值'] : [`${method} · ${aggregation === 'minutes' ? '分钟汇总' : '单次记录'}`]), ...(now - time > (name === 'heart_rate' ? 1.5 : 6) * HOUR ? ['测量已过期，仅供回看'] : [])] } });
    }
    view.metrics.sort((a, b) => a.name.localeCompare(b.name));
    // Static evidence only; request time and receipt counters must not trigger a new card.
    if (this.series.hasRecords()) view.analysis = analysis;
    view.hrvSync = { receivedAt: state.streams.hrv?.receivedAt ?? null, latestSampleAt: hrv?.start ?? null, stats: state.streams.hrv?.stats ?? null };
    if (this.env.SIGNATURE_MODE === 'physiology-v2') {
      const decision = this.physiology(now, state.physiologyDecision);
      view.signatureStatus = { state: decision.state, reasons: decision.reasons, observation: decision.observation };
    }
    if (this.env.SIGNATURE_MODE === 'health-indices-v1') {
      const series = this.seriesForView(now);
      const indices = this.cachedHealthIndices(state, now) ?? this.healthIndices(
        { ...series, heart: this.series.list('heart', now - 30 * 86400000) }, now, state.signatureDelivery?.publishedDecision);
      // Share the dashboard's score presentation and workout facts, without building its charts.
      view.cardData = {
        healthIndices: indicesView(indices, now), sleep: analysis.sleep,
        heart: { latest: series.heart.filter(r => r.end <= now && r.value > 0).at(-1) },
        recoveryHrv: hrvRows.filter(r => r.method === 'RMSSD' && r.end <= now && r.value > 0).at(-1),
        workoutHistory: buildWorkoutHistory(series, now),
      };
    }
    return view;
  }

  renderCard(view, context) {
    return view.cardData ? buildOverviewCard(view.cardData, { ...context,
      dashboardUrl: this.env.HEALTH_DASHBOARD_URL, deviceLabel: this.env.HEALTH_DEVICE_LABEL }) : buildHealthCard(view, context);
  }

  contentFingerprint(view, now) {
    // Hash exactly what is displayed, with a fixed receipt timestamp.
    return fingerprint(this.renderCard({ ...view, hrvSync: view.hrvSync ? { ...view.hrvSync, receivedAt: null, stats: null } : undefined }, { now, syncedAt: 0 }));
  }

  nextReview(view, now) {
    return Math.min(nextMidnight(now), ...this.reviewTimes(view).filter(time => time > now));
  }

  // Candidate review times come from stored facts only; times already past are ignored by
  // nextReview. One alarm commits several times, so reuse them while the facts are unchanged.
  reviewAt(state, now, view) {
    const key = JSON.stringify([state.dataRevision ?? 0, new Date(now + 8 * HOUR).toISOString().slice(0, 10),
      state.metrics.map(m => [m.name, m.latest.time]), state.workouts.map(w => [w.id, w.end])]);
    if (view || this.reviewCache?.key !== key) {
      this.reviewCache = { key, times: this.reviewTimes(view ?? this.view(state, now)) };
    }
    return Math.min(nextMidnight(now), ...this.reviewCache.times.filter(time => time > now));
  }

  reviewTimes(view) {
    const times = [];
    for (const m of view.metrics) {
      const hours = m.name === 'heart_rate' ? 1.5 : ['heart_rate_variability', 'heart_rate_variability_rmssd'].includes(m.name) ? 6 : null;
      if (hours) times.push(m.latest.time + hours * HOUR + 1);
    }
    if (view.analysis?.daytime.measuredAt) times.push(view.analysis.daytime.measuredAt + 6 * HOUR + 1);
    if (view.analysis?.nightly.end) times.push(view.analysis.nightly.end + 36 * HOUR + 1);
    for (const w of view.workouts) times.push(w.end + HOUR + 1);
    return times;
  }

  async save(state, now, view = null) {
    const reviewAt = this.reviewAt(state, now, view);
    const signature = signatureEnabled(this.env) ? state.signatureDelivery : null;
    state.nextAlarmAt = Math.min(state.delivery.dueAt ?? Infinity, reviewAt,
      signature?.dueAt ?? Infinity, signature?.validUntil > now ? signature.validUntil : Infinity,
      state.dashboardCache?.dueAt ?? Infinity, state.pressureReplay?.dueAt ?? Infinity);
    // Keep the personal summary below Durable Object KV's per-value limit.
    if (new TextEncoder().encode(JSON.stringify(state)).length > 100 * 1024) throw new Error('summary_capacity_exceeded');
    await this.storage.put('state', state);
    await this.storage.setAlarm(state.nextAlarmAt);
    return reviewAt;
  }

  async fetch(request) {
    try { return await this.handleFetch(request); }
    finally { this.sqlUsage.flush(this.clock()); }
  }

  async handleFetch(request) {
    const path = new URL(request.url).pathname;
    const now = this.clock();
    if (request.method === 'GET') {
      const state = await this.storage.get('state') ?? { ...emptyState(), delivery: initialDelivery() };
      if (path === '/analysis') return reply({ ...this.analysis(now), lastReceivedAt: state.lastReceivedAt, evaluatedAt: now });
      if (path === '/snapshot') {
        const series = this.seriesForView(now);
        return reply({ ...await buildSignatureSnapshot(series, now),
          healthIndices: this.healthIndices(series, now, state.signatureDelivery?.publishedDecision),
          indicesReplay: series.hrv.slice(-8).map(row => this.healthIndices(series, Math.min(now, row.start + 16 * 60000))),
          physiology: this.physiology(now, state.physiologyDecision),
          hrvObservation: neutralPhysiology(series, now).hrvComparison ?? null,
          publication: { mode: ['physiology-v2', 'health-indices-v1'].includes(this.env.SIGNATURE_MODE) ? this.env.SIGNATURE_MODE : 'sync-status-v1',
            sentTitle: state.signatureDelivery?.sentTitle ?? null, lastSentAt: state.signatureDelivery?.lastSentAt ?? null,
            publishedDecision: state.signatureDelivery?.publishedDecision ?? null, pending: state.signatureDelivery?.pending ?? false,
            dueAt: state.signatureDelivery?.dueAt ?? null, error: state.signatureDelivery?.error ?? null } });
      }
      if (path === '/dashboard') {
        const range = dashboardRange(new URL(request.url).searchParams.get('range') ?? '24h');
        if (!range) return Response.json({ error: 'invalid_range', allowed: ['24h', '7d'] },
          { status: 400, headers: { 'Cache-Control': 'no-store' } });
        const series = this.seriesForView(now);
        const history = this.pressureHistory.view(now, range);
        const scorerSeries = { ...series, heart: this.series.list('heart', now - 30 * 86400000) };
        // Show the decision the signature was built from; evaluate read-only when it is not current.
        const indices = this.cachedHealthIndices(state, now) ?? this.refreshSignaturePresentation(
          this.evaluateIndices(scorerSeries, now, state.signatureDelivery?.publishedDecision), now,
          range === '24h' ? history : undefined);
        const body = buildDashboard(series, now, { range, indices, publication: this.publicationView(state),
          workoutHeart: this.workoutHeart(series, now), pressureHistory: history, receivedAt: state.lastReceivedAt ?? null });
        // ETag is the rendered-content hash: same content returns 304 even when
        // re-requested at a later generatedAt; a corrected same-timestamp row changes it.
        const etag = `"${body.contentHash}"`;
        const headers = { 'Cache-Control': 'no-store', ETag: etag };
        if (request.headers.get('If-None-Match') === etag) {
          return new Response(null, { status: 304, headers });
        }
        return Response.json(body, { headers });
      }
      const view = this.view(state, now);
      if (path === '/card') return reply(this.renderCard(view, { now, syncedAt: state.lastReceivedAt ?? now }));
      const { sentContent, ...delivery } = state.delivery;
      return reply({ ok: true, date: view.date, metrics: view.metrics.length, workouts: view.workouts.length,
        signature: { ...(state.signatureDelivery ?? {}), enabled: signatureEnabled(this.env),
          policy: { coalesceMs: ['physiology-v2', 'health-indices-v1'].includes(this.env.SIGNATURE_MODE) ? SIGNATURE_COALESCE_MS : 60000,
            minWriteIntervalMs: ['physiology-v2', 'health-indices-v1'].includes(this.env.SIGNATURE_MODE) ? PHYSIOLOGY_WRITE_INTERVAL_MS : 30 * 60000 },
          mode: ['physiology-v2', 'health-indices-v1'].includes(this.env.SIGNATURE_MODE) ? this.env.SIGNATURE_MODE : 'sync-status-v1' },
        dataTimes: this.dataTimes(now), series: this.series.counts(), retentionDays: 35, completeness: 'received_records_only', streams: state.streams, lastReceivedAt: state.lastReceivedAt,
        seriesReadStats: { scope: 'series_list_since_object_start', ...this.series.readStats },
        sqlReadUsage: this.sqlUsage.view(now),
        lastIngestError: state.lastIngestError ?? null, pressureReplay: state.pressureReplay ?? null,
        nextAlarmAt: state.nextAlarmAt ?? null,
        dashboardCache: state.dashboardCache ? { ...state.dashboardCache, refreshStrategy: 'data_or_expiry' } : null, delivery });
    }
    if (path === '/signature/refresh') {
      if (!signatureEnabled(this.env)) return Response.json({ error: 'signature_disabled' }, { status: 503 });
      return this.transaction(async () => {
        const state = await this.storage.get('state') ?? { ...emptyState(), delivery: initialDelivery() };
        if (new URL(request.url).searchParams.get('rebuildPressure') === '1') {
          this.queuePressureReplay(state, now - 7 * 24 * HOUR, now, now);
        }
        state.signatureDelivery = this.planSignature(state, now, true, { trigger: 'refresh' });
        await this.save(state, now);
        return reply({ ok: true, signature: state.signatureDelivery, pressureReplay: state.pressureReplay ?? null,
          decision: this.env.SIGNATURE_MODE === 'health-indices-v1' ? state.signatureCandidate : state.physiologyDecision });
      });
    }
    if (path === '/dashboard-cache/refresh') {
      if (!dashboardCacheEnabled(this.env)) return Response.json({ error: 'dashboard_cache_disabled' }, { status: 503 });
      await this.transaction(async () => {
        const state = await this.storage.get('state') ?? { ...emptyState(), delivery: initialDelivery() };
        state.dashboardCache ??= { lastPublishedAt: null, dueAt: null, error: null };
        state.dashboardCache.dueAt = now;
        state.dashboardCache.revision = (state.dashboardCache.revision ?? 0) + 1;
        await this.save(state, now);
      });
      await this.publishDashboardCache({ force: true });
      const state = await this.storage.get('state');
      return reply({ ok: true, dashboardCache: state.dashboardCache ?? null });
    }
    if (path === '/ingest-error') {
      // Internal Worker diagnostics must not advance receipt times, measurements or alarms.
      const { stream, aggregation, nativeAggregation, error } = await request.json();
      await this.transaction(async () => {
        const state = await this.storage.get('state') ?? { ...emptyState(), delivery: initialDelivery() };
        state.lastIngestError = { at: now, stream, aggregation, nativeAggregation, error, stage: 'request_validation' };
        await this.storage.put('state', state);
      });
      return reply({ ok: true });
    }
    const { summary, stream, aggregation, records = [], mode = 'live' } = await request.json();
    try {
      return await this.transaction(async () => {
        const old = await this.storage.get('state') ?? { ...emptyState(), delivery: initialDelivery() };
        const pruned = this.series.prune(now);
        const accepted = this.series.put(records, now);
        const state = mergeSummary(old, summary, { stream, aggregation, now });
        if (state.lastIngestError?.stream === stream && summary.samples > 0) state.lastIngestError = null;
        // This batch's measurement range is independent of receipt time and previously stored facts.
        const dataRange = records.length ? {
          startAt: Math.min(...records.map(row => row.start)),
          endAt: Math.max(...records.map(row => row.end)),
        } : null;
        state.streams[stream].dataRange = dataRange;
        state.streams[stream].mode = mode;
        state.streams[stream].lastContentChangedAt = accepted.stats.inserted + accepted.stats.updated > 0
          ? now : old.streams[stream]?.lastContentChangedAt ?? null;
        state.streams[stream].stats = { ...accepted.stats, skippedInput: summary.skipped };
        const response = () => reply({ ok: true, stored: true, sent: false,
          notification: mode === 'backfill' ? 'backfill_silent' : state.delivery.pending ? 'queued' : 'unchanged',
          signature: !signatureEnabled(this.env) ? 'disabled' : mode === 'backfill' ? 'backfill_silent' : state.signatureDelivery?.pending ? 'queued' : 'unchanged',
          receivedAt: now, stream, aggregation, mode, dataRange,
          acceptedRecords: accepted.stored, expiredRecords: accepted.expired, stats: state.streams[stream].stats, completeness: 'received_records_only',
          nextNotificationAt: state.delivery.dueAt, samples: summary.samples, skipped: summary.skipped });
        const summaryChanged = await fingerprint({ metrics: state.metrics, workouts: state.workouts }) !==
          await fingerprint({ metrics: old.metrics, workouts: old.workouts });
        if (summaryChanged || pruned || accepted.stats.inserted + accepted.stats.updated > 0) {
          state.dataRevision = (old.dataRevision ?? 0) + 1;
          delete state.indicesCache;
        }
        const sameSignatureMode = !signatureEnabled(this.env) || (old.signatureDelivery &&
          (old.signatureDelivery.mode ?? 'sync-status-v1') === (this.env.SIGNATURE_MODE ?? 'sync-status-v1'));
        if (mode !== 'backfill' && !summaryChanged && !pruned && accepted.stats.inserted + accepted.stats.updated === 0 &&
            old.nextAlarmAt > now && old.delivery.sentContent && sameSignatureMode &&
            (old.evaluatedRevision ?? -1) === (old.dataRevision ?? 0)) {
          // Receipt/deduplication facts changed; already published decisions did not.
          // Keep pending work and its alarm. Facts stored silently since the last live
          // evaluation (backfill, retention) still need one.
          await this.storage.put('state', state);
          return response();
        }
        if (mode !== 'backfill' && this.env.SIGNATURE_MODE === 'health-indices-v1' && dataRange &&
            ['hrv', 'heart', 'sleep-segments', 'workouts'].includes(stream) &&
            accepted.stats.inserted + accepted.stats.updated > 0) {
          // Include the trailing RMSSD window and the workout recovery exclusion hour.
          const exclusionTail = stream === 'workouts' ? HOUR : 0;
          this.queuePressureReplay(state, accepted.changedRange.startAt, accepted.changedRange.endAt + exclusionTail + 20 * 60000, now);
        }
        // Plan once before rendering, so the card and signature share the decision and its build timing.
        let signaturePlanned = false;
        if (mode !== 'backfill' && this.env.SIGNATURE_MODE === 'health-indices-v1' && this.series.hasRecords()) {
          if (signatureEnabled(this.env)) {
            state.signatureDelivery = this.planSignature(state, now, true, { trigger: 'ingest', receivedAt: now });
            signaturePlanned = true;
          } else this.currentHealthIndices(state, now);
        }
        const view = this.view(state, now);
        const content = await this.contentFingerprint(view, now);
        const hasData = view.metrics.length || view.workouts.length || view.analysis?.sleep.some(s => now - s.end < 7 * 86400000);
        const delivery = state.delivery;
        if (mode !== 'backfill') {
          delivery.pending = Boolean(hasData && content !== delivery.sentContent);
          if (delivery.pending && delivery.dueAt === null) {
            delivery.dueAt = Math.max(now + 60000, (delivery.lastSentAt ?? 0) + CARD_WRITE_INTERVAL_MS);
            delivery.attempts = 0;
          } else if (!delivery.pending) delivery.dueAt = null;
        }
        const shouldPlanSignature = signatureEnabled(this.env) && mode !== 'backfill' && hasData;
        if (shouldPlanSignature && !signaturePlanned) {
          state.signatureDelivery = this.planSignature(state, now,
            !old.signatureDelivery || summaryChanged || accepted.stats.inserted + accepted.stats.updated > 0,
            { trigger: 'ingest', receivedAt: now });
        }
        // Base-relayed dashboard: refresh the cache record shortly after live data lands.
        if (dashboardCacheEnabled(this.env) && mode !== 'backfill' &&
            accepted.stats.inserted + accepted.stats.updated > 0) {
          state.dashboardCache ??= { lastPublishedAt: null, dueAt: null, error: null };
          state.dashboardCache.dueAt = Math.min(state.dashboardCache.dueAt ?? Infinity, this.dashboardDueAt(state, now + 60000));
          state.dashboardCache.revision = (state.dashboardCache.revision ?? 0) + 1;
        }
        // Numeric signature planning already evaluates and records this live observation.
        const pressureRecorded = (signaturePlanned || shouldPlanSignature) && this.env.SIGNATURE_MODE === 'health-indices-v1';
        if (!pressureRecorded && mode !== 'backfill' && this.series.hasRecords()) {
          this.currentHealthIndices(state, now);
        }
        if (mode !== 'backfill') state.evaluatedRevision = state.dataRevision ?? 0;
        await this.save(state, now, view);
        return response();
      });
    } catch (error) {
      if (['daily_aggregation_required', 'too_many_metrics', 'too_many_workouts', 'summary_capacity_exceeded', 'future_series_time', 'conflicting_records_in_batch'].includes(error.message)) {
        if (error.details) {
          // The rejected transaction rolled back. Record only safe diagnostic metadata;
          // leave accepted measurements, delivery state and alarms untouched.
          await this.transaction(async () => {
            const state = await this.storage.get('state') ?? { ...emptyState(), delivery: initialDelivery() };
            state.lastIngestError = { at: now, stream, error: error.message, ...error.details };
            await this.storage.put('state', state);
          });
        }
        return Response.json({ error: error.message, ...(error.details ? { details: error.details } : {}) }, { status: 422 });
      }
      throw error;
    }
  }

  async publishSignature() {
    if (!signatureEnabled(this.env)) return;
    const snapshot = await this.transaction(async () => {
      const state = await this.storage.get('state');
      if (!state?.signatureDelivery) return null;
      const now = this.clock();
      let signature = state.signatureDelivery = this.planSignature(state, now);
      const due = signature.pending && signature.dueAt <= now;
      // A durable retry is scheduled before network I/O, including a process crash.
      if (due) signature.dueAt = now + 60000;
      await this.save(state, now);
      return due ? { title: signature.desiredTitle, decision: state.signatureCandidate,
        candidateTiming: signature.candidateTiming, correctionTitle: state.signatureCorrectionDecision?.title } : null;
    });
    if (!snapshot) return;
    const startedAt = this.clock();
    const result = await this.signaturePublisher.publish(snapshot.title);
    const finishedAt = this.clock();
    await this.transaction(async () => {
      const state = await this.storage.get('state');
      const now = this.clock();
      let signature = state.signatureDelivery = this.planSignature(state, now);
      const timing = snapshot.candidateTiming;
      signature.publicationTiming = { ok: result.ok, trigger: timing?.trigger ?? null, receivedAt: timing?.receivedAt ?? null,
        candidateBuiltAt: timing?.builtAt ?? null, candidateBuildMs: timing?.buildMs ?? null,
        startedAt, finishedAt, queueMs: timing ? startedAt - timing.builtAt : null, writeMs: finishedAt - startedAt,
        receiptToFinishedMs: timing?.receivedAt != null ? finishedAt - timing.receivedAt : null };
      if (result.ok) {
        signature.sentTitle = snapshot.title;
        if (snapshot.decision) {
          signature.publishedDecision = snapshot.decision;
          if (state.signatureCorrectionDecision?.title === snapshot.correctionTitle) state.signatureCorrectionDecision = null;
          // A write that completes after natural expiry remains a dated historical publication.
          if (!state.signatureCandidate?.title) signature.desiredTitle = snapshot.title;
        }
        signature.lastSentAt = now;
        // Reconcile against the acknowledged decision: uploads can change evidence during network I/O.
        if (snapshot.decision) signature = state.signatureDelivery = this.planSignature(state, now, true);
        signature.pending = signature.desiredTitle !== snapshot.title;
        const expired = Number.isFinite(signature.validUntil) && now >= signature.validUntil;
        const interval = ['physiology-v2', 'health-indices-v1'].includes(signature.mode) ? PHYSIOLOGY_WRITE_INTERVAL_MS : 30 * 60000;
        signature.dueAt = signature.pending ? (signature.urgent || expired ? now : now + interval) : null;
        if (!signature.pending) signature.urgent = false;
        signature.attempts = 0;
        signature.error = null;
        const cache = dashboardCacheEnabled(this.env) ? state.dashboardCache : null;
        if (cache?.lastPublishedAt && cache.publishedSignature !== signature.sentTitle) {
          cache.dueAt = Math.min(cache.dueAt ?? Infinity, now);
          cache.revision = (cache.revision ?? 0) + 1;
        }
      } else {
        signature.pending = true;
        signature.attempts++;
        signature.error = result.error;
        signature.dueAt = now + Math.max(result.retryAfterMs ?? 0, Math.min(300000 * 2 ** Math.min(signature.attempts - 1, 4), HOUR));
      }
      await this.save(state, now);
    });
  }

  async publishDashboardCache({ force = false } = {}) {
    if (!dashboardCacheEnabled(this.env) || this.dashboardPublishInFlight) return;
    // One external writer per object. A persisted retry survives a crash during I/O.
    this.dashboardPublishInFlight = true;
    try {
      const snapshot = await this.transaction(async () => {
        const state = await this.storage.get('state');
        if (!state?.dashboardCache) return null;
        const now = this.clock(), cache = state.dashboardCache;
        if (!force && (cache.dueAt == null || cache.dueAt > now)) return null;
        const nextAllowed = (cache.lastPublishedAt ?? 0) + DASHBOARD_CACHE_THROTTLE_MS;
        if (!force && now < nextAllowed) { cache.dueAt = nextAllowed; await this.save(state, now); return null; }
        cache.dueAt = now + 60000;
        const series = this.seriesForView(now);
        const indices = this.currentHealthIndices(state, now, force);
        const publication = this.publicationView(state);
        const workoutHeart = this.workoutHeart(series, now);
        const payload = range => {
          // Leave headroom for HRV and monthly facts in the Base text field.
          // Preserve extrema and the latest minute, with at most hourly chart buckets.
          let bucket = range === '7d' ? CACHE_HEART_BUCKET_MS : 120000;
          const history = this.pressureHistory.view(now, range);
          history.totalPoints = history.points.length;
          history.sampled = history.points.length > 240;
          if (history.sampled) {
            const all = history.points;
            history.points = Array.from({ length: 240 }, (_, i) => all[Math.round(i * (all.length - 1) / 239)]);
          }
          let value;
          do {
            value = JSON.stringify(buildDashboard(series, now, { range, indices, publication,
              pressureHistory: history, heartBucketMs: bucket, workoutHeart, receivedAt: state.lastReceivedAt ?? null }));
            if (value.length <= 80000 || bucket >= 3600000) break;
            bucket = Math.min(bucket * 2, 3600000);
          } while (true);
          if (value.length > 99000) throw new Error('dashboard_payload_too_large');
          return value;
        };
        const result = { revision: cache.revision ?? 0, payload24h: payload('24h'), payload7d: payload('7d'), generatedAt: now,
          signatureTitle: publication.sentTitle };
        const reviewAt = await this.save(state, now);
        return { ...result, refreshAt: Math.min(reviewAt, indices.validUntil ?? Infinity) };
      });
      if (!snapshot) return;
      let result;
      try { result = await this.dashboardCachePublisher.publish(snapshot); }
      catch { result = { ok: false, error: { reason: 'network_error' } }; }
      await this.transaction(async () => {
        const latest = await this.storage.get('state');
        const cache = latest.dashboardCache, finishedAt = this.clock();
        if (result.ok) {
          cache.lastPublishedAt = finishedAt;
          cache.publishedSignature = snapshot.signatureTitle;
          cache.error = null;
          cache.attempts = 0;
          // If I/O crossed the boundary, immediately regenerate the expired snapshot.
          const refreshAt = Math.max(finishedAt + 1, snapshot.refreshAt);
          // Never overwrite an upload/manual refresh that arrived during the external write.
          cache.dueAt = (cache.revision ?? 0) !== snapshot.revision
            ? Math.min(cache.dueAt ?? refreshAt, refreshAt) : refreshAt;
        } else {
          cache.attempts = (cache.attempts ?? 0) + 1;
          cache.error = result.error;
          cache.dueAt = finishedAt + Math.max(result.retryAfterMs ?? 0,
            Math.min(30000 * 2 ** Math.min(cache.attempts - 1, 4), HOUR));
        }
        await this.save(latest, finishedAt);
      });
    } catch {
      // Preparation/storage errors must not abort the unrelated card alarm chain.
      await this.transaction(async () => {
        const state = await this.storage.get('state');
        if (!state?.dashboardCache) return;
        const cache = state.dashboardCache, now = this.clock();
        cache.attempts = (cache.attempts ?? 0) + 1;
        cache.error = { reason: 'cache_preparation_failed' };
        cache.dueAt = now + Math.min(30000 * 2 ** Math.min(cache.attempts - 1, 4), HOUR);
        await this.save(state, now);
      });
    } finally { this.dashboardPublishInFlight = false; }
  }

  async alarm() {
    try { return await this.handleAlarm(); }
    finally { this.sqlUsage.flush(this.clock()); }
  }

  async handleAlarm() {
    const state = await this.storage.get('state'), scheduled = state?.nextAlarmAt;
    const modeChanged = signatureEnabled(this.env) &&
      (state?.signatureDelivery?.mode ?? 'sync-status-v1') !== (this.env.SIGNATURE_MODE ?? 'sync-status-v1');
    if (scheduled > this.clock() && !modeChanged) {
      // A stale/duplicate alarm after eviction must not load the unchanged history.
      await this.storage.setAlarm(scheduled);
      return;
    }
    await this.replayPressure();
    await this.publishSignature();
    await this.publishDashboardCache();
    const now = this.clock();
    // Storage and scheduling commit before network I/O. New uploads can arrive during delivery.
    const snapshot = await this.transaction(async () => {
      const state = await this.storage.get('state');
      if (!state) return null;
      if (this.series.prune(now)) {
        state.dataRevision = (state.dataRevision ?? 0) + 1;
        delete state.indicesCache;
      }
      const view = this.view(state, now);
      state.metrics = state.metrics.filter(m => new Date(m.latest.time + 8 * HOUR).toISOString().slice(0, 10) >=
        new Date(now - 6 * 24 * HOUR + 8 * HOUR).toISOString().slice(0, 10));
      state.workouts = view.workouts;
      // Only re-evaluate an already published live card. Silent backfill alone stays silent.
      if (!state.delivery.pending && state.delivery.sentContent &&
          await this.contentFingerprint(view, now) !== state.delivery.sentContent) {
        state.delivery.pending = true;
        state.delivery.dueAt = Math.max(now, (state.delivery.lastSentAt ?? 0) + CARD_WRITE_INTERVAL_MS);
      }
      const due = state.delivery.pending && state.delivery.dueAt <= now;
      if (!view.metrics.length && !view.workouts.length && !view.analysis?.sleep.some(s => now - s.end < 7 * 86400000)) {
        state.delivery.pending = false;
        state.delivery.dueAt = null;
        state.delivery.sentContent = null;
      }
      await this.save(state, now, view);
      return due && state.delivery.pending ? { view, now, syncedAt: state.lastReceivedAt } : null;
    });
    if (!snapshot) return;
    const response = await deliverCard(this.renderCard(snapshot.view, { now: snapshot.now, syncedAt: snapshot.syncedAt }), this.env, this.send);
    const result = await response.json();
    await this.transaction(async () => {
      const state = await this.storage.get('state');
      const delivery = state.delivery;
      const finishedAt = this.clock();
      const view = this.view(state, finishedAt);
      if (response.ok) {
        delivery.lastSentAt = finishedAt;
        delivery.sentContent = await this.contentFingerprint(snapshot.view, snapshot.now);
        delivery.pending = await this.contentFingerprint(view, finishedAt) !== delivery.sentContent;
        delivery.dueAt = delivery.pending ? finishedAt + CARD_WRITE_INTERVAL_MS : null;
        delivery.attempts = 0;
        delivery.error = null;
      } else {
        delivery.pending = true;
        delivery.attempts++;
        delivery.error = result;
        delivery.dueAt = finishedAt + Math.min(5 * 60000 * 2 ** Math.min(delivery.attempts - 1, 4), HOUR);
      }
      await this.save(state, finishedAt, view);
    });
  }
}
