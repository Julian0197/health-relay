// Synthetic before/after benchmark on real workerd + SQLite. Every outbound request is intercepted.
// node bench-runtime.mjs <bundled-miniflare-path> [module-root] [--json]
// module-root defaults to this directory; pass another checkout (e.g. a HEAD worktree) for a baseline.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(process.argv[2]).href);
const root = resolve(process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : fileURLToPath(new URL('.', import.meta.url)));
const asJson = process.argv.includes('--json');
const storagePath = await mkdtemp(join(tmpdir(), 'hae-bench-'));
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
// A Beijing afternoon two days ahead: identical inputs for runs on the same day, and real workerd
// alarms stay in the future so only the probe drives the production alarm method.
const began = Math.floor(Date.now() / DAY) * DAY + 2 * DAY + 6.5 * HOUR;
const probe = `
import { HealthStore } from './health-store.mjs';
import { handleRequest } from './worker.mjs';
const category = q => q.includes('pressure_') ? 'pressure' : q.includes('sample_day_cache') ? 'day_cache'
  : q.includes('sample_counts') ? 'counts' : q.startsWith('SELECT key,payload FROM samples WHERE key IN') ? 'deduplication'
  : q.startsWith('SELECT payload FROM samples') ? 'raw_history' : q.startsWith('SELECT start FROM samples') ? 'history_bounds'
  : q.startsWith('INSERT INTO samples') ? 'ingestion' : 'other';
export class BenchStore extends HealthStore {
  constructor(ctx, env) {
    let now = Number(env.TEST_NOW);
    super(ctx, env, fetch, () => now);
    this.advance = ms => { now += ms; };
    ctx.blockConcurrencyWhile(async () => { now = await ctx.storage.get('testClock') ?? now; });
    this.calls = {}; this.sqlReads = {};
    const sql = this.sqlUsage.sql, exec = sql.exec;
    sql.exec = (query, ...args) => {
      const cursor = exec(query, ...args), key = category(query);
      const totals = this.sqlReads[key] ??= { queries: 0, rowsRead: 0 };
      totals.queries++; totals.rowsRead += cursor.rowsRead ?? 0;
      return cursor;
    };
    for (const name of ['view', 'analysis', 'healthIndices', 'currentHealthIndices', 'save', 'seriesForView']) {
      if (typeof this[name] !== 'function') continue;
      const original = this[name].bind(this);
      this[name] = (...args) => { this.calls[name] = (this.calls[name] ?? 0) + 1; return original(...args); };
    }
    for (const name of ['view', 'latest', 'record']) {
      const original = this.pressureHistory[name].bind(this.pressureHistory);
      this.pressureHistory[name] = (...args) => { this.calls['pressure.' + name] = (this.calls['pressure.' + name] ?? 0) + 1; return original(...args); };
    }
  }
  async fetch(request) {
    if (new URL(request.url).pathname !== '/__probe') return super.fetch(request);
    const command = await request.json();
    if (command.reset) { this.calls = {}; this.sqlReads = {}; this.series.invalidate(); }
    if (command.advance) { this.advance(command.advance); await this.storage.put('testClock', this.clock()); }
    if (command.alarm) await this.alarm();
    const state = await this.storage.get('state');
    return Response.json({ now: this.clock(), calls: this.calls, sqlReads: this.sqlReads,
      signature: state?.signatureDelivery ?? null, cache: state?.dashboardCache ?? null });
  }
}
export default { fetch(request, env) {
  if (new URL(request.url).pathname === '/__probe') return env.HEALTH_STORE.get(env.HEALTH_STORE.idFromName('personal')).fetch(request);
  return handleRequest(request, env);
} };
`;
const { readdirSync } = await import('node:fs');
const modules = readdirSync(root).filter(name => name.endsWith('.mjs') && !/\.test\.mjs$|-runtime\.mjs$|runtime-smoke|healthrelay-contract|sql-test-helper|gateway|signature-replay/.test(name));
const published = { signature: [], cache: [] };
let failNextSignature = false;
const options = { cf: false, resourcePersistencePath: storagePath, workers: [{
  name: 'hae-bench', compatibilityDate: '2026-09-01',
  modules: [{ type: 'ESModule', path: join(root, 'bench-probe.mjs'), contents: probe },
    ...modules.map(name => ({ type: 'ESModule', path: join(root, name) }))],
  durableObjects: { HEALTH_STORE: { className: 'BenchStore', useSQLite: true } },
  bindings: { TEST_NOW: String(began), HAE_API_KEY: 'fixture', FEISHU_SIGN_SECRET: 'fixture',
    FEISHU_WEBHOOK_URL: 'https://open.larkoffice.com/open-apis/bot/v2/hook/fixture',
    SIGNATURE_ENABLED: 'true', SIGNATURE_MODE: 'health-indices-v1', FEISHU_APP_ID: 'fixture', FEISHU_APP_SECRET: 'fixture',
    SIGNATURE_BASE_TOKEN: 'base', SIGNATURE_TABLE_ID: 'signature', SIGNATURE_RECORD_ID: 'sig',
    DASHBOARD_CACHE_TABLE_ID: 'cache', DASHBOARD_CACHE_RECORD_ID: 'cache' },
  outboundService: async request => {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'fixture', expire: 7200 });
    if (path.endsWith('/tables/cache/records/cache')) {
      const { fields } = await request.json();
      if (process.env.BENCH_TRACE) console.error('cache write', JSON.parse(fields.payload_24h).generatedAt - began, JSON.parse(fields.payload_24h).publication?.pending);
      published.cache.push({ payload24hChars: fields.payload_24h.length, payload7dChars: fields.payload_7d.length,
        publication: JSON.parse(fields.payload_24h).publication,
        bucket24h: JSON.parse(fields.payload_24h).heart.bucketMinutes, bucket7d: JSON.parse(fields.payload_7d).heart.bucketMinutes });
      return Response.json({ code: 0, data: { record: { record_id: 'cache', fields } } });
    }
    if (path.endsWith('/tables/signature/records/sig')) {
      if (failNextSignature) { failNextSignature = false; return new Response('unavailable', { status: 500 }); }
      published.signature.push((await request.json()).fields.title);
      if (process.env.BENCH_TRACE) console.error('signature write', published.signature.at(-1));
      return Response.json({ code: 0, data: { record: { record_id: 'sig' } } });
    }
    return Response.json({ code: 0 });
  },
}] };
const mf = new Miniflare(convertV4MiniflareOptions(options));
const iso = t => new Date(t).toISOString();
const post = async (path, data, headers) => {
  const response = await mf.dispatchFetch(`http://local${path}`, { method: 'POST',
    headers: { 'X-API-Key': 'fixture', ...headers }, body: JSON.stringify({ data }) });
  const body = await response.json();
  if (response.status !== 200) throw new Error(`${path} ${response.status} ${JSON.stringify(body)}`);
  return body;
};
const probeCall = async command => (await mf.dispatchFetch('http://local/__probe', { method: 'POST', body: JSON.stringify(command) })).json();
// Deterministic synthetic physiology: a daily rhythm plus a small pseudo-random wobble.
const wobble = i => ((i * 2654435761) >>> 0) % 7 - 3;
const beijingHour = t => new Date(t + 8 * HOUR).getUTCHours();
const awake = t => beijingHour(t) >= 8 && beijingHour(t) < 23;
const heartRows = (from, to) => {
  const rows = [];
  for (let t = Math.ceil(from / MINUTE) * MINUTE; t < to; t += MINUTE) {
    const v = (awake(t) ? 72 : 56) + wobble(t / MINUTE);
    rows.push({ date: iso(t), Avg: v, Min: v - 4, Max: v + 5, source: 'Watch' });
  }
  return rows;
};
const rmssdRows = (from, to) => {
  const rows = [];
  for (let t = Math.ceil(from / (5 * MINUTE)) * 5 * MINUTE; t < to; t += 5 * MINUTE) {
    if (awake(t)) rows.push({ date: iso(t), qty: 42 + wobble(t / MINUTE) * 2, source: 'Watch' });
  }
  return rows;
};
const heart = (data, mode = 'live') => post('/ingest/heart', { metrics: [{ name: 'heart_rate', units: 'bpm', data }] },
  { 'X-HAE-Aggregation': 'minutes', 'X-HAE-Mode': mode });
const rmssd = (data, mode = 'live') => post('/ingest/hrv', { metrics: [{ name: 'heart_rate_variability_rmssd', units: 'ms', data }] },
  { 'X-HAE-Aggregation': 'raw', 'X-HAE-Mode': mode });
const timed = async run => { const started = performance.now(); const result = await run(); return { ms: performance.now() - started, result }; };
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const report = {};
try {
  // Seed: 7 days of minute heart, 5-minute awake RMSSD, nightly sleep stages, daily totals and workouts.
  for (let d = 7; d >= 1; d--) await heart(heartRows(began - d * DAY, began - (d - 1) * DAY), 'backfill');
  await rmssd(rmssdRows(began - 14 * DAY, began), 'backfill');
  const nights = [];
  for (let d = 7; d >= 0; d--) {
    const wake = Date.parse(iso(began - d * DAY).slice(0, 10) + 'T23:30:00Z') - DAY; // 07:30 Beijing
    nights.push({ startDate: iso(wake - 8 * HOUR), endDate: iso(wake - 5 * HOUR), value: 'Core', source: 'Watch' },
      { startDate: iso(wake - 5 * HOUR), endDate: iso(wake - 4 * HOUR), value: 'Deep', source: 'Watch' },
      { startDate: iso(wake - 4 * HOUR), endDate: iso(wake - 4 * HOUR + 10 * MINUTE), value: 'Awake', source: 'Watch' },
      { startDate: iso(wake - 4 * HOUR + 10 * MINUTE), endDate: iso(wake), value: 'REM', source: 'Watch' });
  }
  await post('/ingest/sleep-segments', { metrics: [{ name: 'sleep_analysis', units: 'hr', data: nights }] }, { 'X-HAE-Aggregation': 'raw', 'X-HAE-Mode': 'backfill' });
  const days = Array.from({ length: 8 }, (_, i) => iso(began + 8 * HOUR - i * DAY).slice(0, 10));
  await post('/ingest/health', { metrics: [
    { name: 'step_count', units: 'count', data: days.map((date, i) => ({ date, qty: 6000 + i * 431, source: 'Watch' })) },
    { name: 'active_energy', units: 'kcal', data: days.map((date, i) => ({ date, qty: 400 + i * 17, source: 'Watch' })) },
  ] }, { 'X-HAE-Aggregation': 'days', 'X-HAE-Mode': 'backfill' });
  await post('/ingest/workouts', { workouts: [1, 3, 5].map(d => ({ id: `run-${d}`, name: 'Running',
    start: iso(began - d * DAY - 3 * HOUR), end: iso(began - d * DAY - 2 * HOUR), duration: 3600 })) }, { 'X-HAE-Aggregation': 'days', 'X-HAE-Mode': 'backfill' });
  // Bring the object to steady state: one live batch and the alarms that publish it.
  await heart(heartRows(began - 30 * MINUTE, began));
  await rmssd(rmssdRows(began - 30 * MINUTE, began));
  for (let i = 0; i < 4; i++) await probeCall({ advance: 2 * MINUTE, alarm: true });
  const settle = await probeCall({});
  let clock = settle.now;

  // Scenario 1: a live 10-minute batch arrives (heart, then RMSSD); one minute after the alarm that
  // publishes it, the next minute of data arrives (a burst), then the following alarms run.
  const ingest = [], alarm = [], duplicate = [], dashboard = [];
  let consistentRounds = 0;
  for (let round = 0; round < 5; round++) {
    const from = clock - 10 * MINUTE;
    // Round 2: the first signature write fails once and succeeds on its backoff retry.
    failNextSignature = round === 2;
    await probeCall({ reset: true });
    const h = await timed(() => heart(heartRows(from, clock)));
    const r = await timed(() => rmssd(rmssdRows(from, clock)));
    const ingestProbe = await probeCall({});
    ingest.push({ ms: h.ms + r.ms, calls: ingestProbe.calls, sqlReads: ingestProbe.sqlReads });
    await probeCall({ reset: true });
    // Run every alarm in the next six minutes (coalescing, signature, dashboard cache and card).
    let alarmMs = 0;
    for (let step = 0; step < 6; step++) {
      const at = (await probeCall({})).now;
      if (step === 1) { await heart(heartRows(at - 2 * MINUTE, at)); await rmssd(rmssdRows(at - 5 * MINUTE, at)); }
      alarmMs += (await timed(() => probeCall({ advance: MINUTE, alarm: true }))).ms;
      if (process.env.BENCH_TRACE) { const p = await probeCall({}); console.error('alarm', round, step, p.now - began, 'cacheDue', p.cache?.dueAt - began, 'sigDue', p.signature?.dueAt && p.signature.dueAt - began, 'sigPending', p.signature?.pending); }
    }
    const alarmProbe = await probeCall({});
    alarm.push({ ms: alarmMs, calls: alarmProbe.calls, sqlReads: alarmProbe.sqlReads });
    const shown = published.cache.at(-1)?.publication;
    if (shown?.sentTitle === alarmProbe.signature?.sentTitle && shown?.pending === false) consistentRounds++;
    // Scenario 2: the exporter retries the same batch.
    await probeCall({ reset: true });
    const dup = await timed(() => rmssd(rmssdRows(from, clock)));
    const dupProbe = await probeCall({});
    duplicate.push({ ms: dup.ms, calls: dupProbe.calls, sqlReads: dupProbe.sqlReads });
    // Scenario 3: a private dashboard read.
    await probeCall({ reset: true });
    const dash = await timed(() => mf.dispatchFetch('http://local/dashboard?range=7d', { headers: { 'X-API-Key': 'fixture' } }).then(r => r.json()));
    const dashProbe = await probeCall({});
    dashboard.push({ ms: dash.ms, calls: dashProbe.calls, sqlReads: dashProbe.sqlReads });
    clock = (await probeCall({ advance: 4 * MINUTE })).now;
  }
  const summarize = runs => ({ medianMs: Math.round(median(runs.map(r => r.ms))), calls: runs.at(-1).calls,
    sqlRowsRead: runs.at(-1).sqlReads, sqlRowsReadTotal: Object.values(runs.at(-1).sqlReads).reduce((n, v) => n + v.rowsRead, 0) });
  Object.assign(report, { ingest: summarize(ingest), alarmCycle: summarize(alarm), duplicate: summarize(duplicate), dashboard7d: summarize(dashboard) });
  // Behavior: does the display copy describe the signature that is actually live?
  const final = await probeCall({});
  const lastCache = published.cache.at(-1);
  report.behavior = {
    signatureWrites: published.signature.length, cacheWrites: published.cache.length,
    lastSignature: published.signature.at(-1),
    cacheShowsLiveSignature: lastCache?.publication?.sentTitle === final.signature?.sentTitle && lastCache?.publication?.pending === false,
    roundsEndingWithLiveSignatureInCache: `${consistentRounds}/5`,
    cachePublication: lastCache?.publication, payloadChars: { '24h': lastCache?.payload24hChars, '7d': lastCache?.payload7dChars },
    heartBucketMinutes: { '24h': lastCache?.bucket24h, '7d': lastCache?.bucket7d },
  };
  console.log(asJson ? JSON.stringify(report) : JSON.stringify(report, null, 2));
} finally { await mf.dispose(); await rm(storagePath, { recursive: true, force: true }); }
