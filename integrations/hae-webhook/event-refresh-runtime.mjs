// Synthetic data only. Real workerd/SQLite, a persisted test clock, and intercepted outbound I/O.
// Run with the Miniflare module bundled with pinned Wrangler; this file is never deployed.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(process.argv[2]).href);
const storagePath = await mkdtemp(join(tmpdir(), 'hae-event-refresh-'));
const MINUTE = 60000, HOUR = 60 * MINUTE;
// Keep real alarms in the future; drive the production alarm method through the test endpoint.
// Use tomorrow morning in Beijing: wall-clock runs near midnight must not cross a date boundary.
const began = Math.floor((Date.now() + 8 * HOUR) / (24 * HOUR)) * 24 * HOUR + 26 * HOUR;
const probe = `
import { HealthStore } from './health-store.mjs';
import { handleRequest } from './worker.mjs';
export class TestHealthStore extends HealthStore {
  constructor(ctx, env) {
    let now = Number(env.TEST_NOW);
    super(ctx, env, fetch, () => now);
    this.advance = ms => { now += ms; };
    ctx.blockConcurrencyWhile(async () => { now = await ctx.storage.get('testClock') ?? now; });
  }
  async fetch(request) {
    if (new URL(request.url).pathname === '/__probe') {
      const command = await request.json();
      if (command.advance) { this.advance(command.advance); await this.storage.put('testClock', this.clock()); }
      if (command.alarm) await this.alarm();
      const state = await this.storage.get('state');
      return Response.json({ now: this.clock(), readStats: this.series.readStats,
        nextAlarmAt: state?.nextAlarmAt, cache: state?.dashboardCache });
    }
    return super.fetch(request);
  }
}
export default { fetch(request, env) {
  if (new URL(request.url).pathname === '/__probe') return env.HEALTH_STORE.get(env.HEALTH_STORE.idFromName('personal')).fetch(request);
  return handleRequest(request, env);
} };
`;
let cacheWrites = 0, cached;
const modules = ['worker', 'health-card', 'overview-card', 'health-state', 'health-store', 'sql-usage', 'workouts', 'delivery', 'series', 'analysis',
  'signature', 'physiology', 'health-indices', 'health-profile', 'health-signature', 'dashboard',
  'pressure-history', 'dashboard-auth', 'dashboard-cache', 'signature-phrases', 'signature-holidays', 'miaobi'];
const options = { cf: false, resourcePersistencePath: storagePath, workers: [{
  name: 'hae-event-refresh-test', modules: [{ type: 'ESModule',
    path: fileURLToPath(new URL('./event-refresh-probe.mjs', import.meta.url)), contents: probe },
  ...modules.map(name => ({ type: 'ESModule', path: fileURLToPath(new URL(`./${name}.mjs`, import.meta.url)) }))],
  compatibilityDate: '2026-09-01', durableObjects: { HEALTH_STORE: { className: 'TestHealthStore', useSQLite: true } },
  bindings: { TEST_NOW: String(began), HAE_API_KEY: 'fixture', FEISHU_SIGN_SECRET: 'fixture',
    FEISHU_WEBHOOK_URL: 'https://open.larkoffice.com/open-apis/bot/v2/hook/fixture',
    SIGNATURE_ENABLED: 'true', SIGNATURE_MODE: 'health-indices-v1', FEISHU_APP_ID: 'fixture', FEISHU_APP_SECRET: 'fixture',
    SIGNATURE_BASE_TOKEN: 'base', SIGNATURE_TABLE_ID: 'signature', SIGNATURE_RECORD_ID: 'sig',
    DASHBOARD_CACHE_TABLE_ID: 'cache', DASHBOARD_CACHE_RECORD_ID: 'cache' },
  outboundService: async request => {
    const path = new URL(request.url).pathname;
    if (path === '/open-apis/auth/v3/tenant_access_token/internal') return Response.json({ code: 0, tenant_access_token: 'fixture', expire: 7200 });
    if (path === '/open-apis/bitable/v1/apps/base/tables/cache/records/cache') {
      assert.equal(request.method, 'PUT');
      const { fields } = await request.json();
      cached = JSON.parse(fields.payload_24h); cacheWrites++;
      return Response.json({ code: 0, data: { record: { record_id: 'cache', fields } } });
    }
    if (path === '/open-apis/bitable/v1/apps/base/tables/signature/records/sig') return Response.json({ code: 0, data: { record: { record_id: 'sig' } } });
    assert.equal(path, '/open-apis/bot/v2/hook/fixture');
    return Response.json({ code: 0 });
  },
}] };
let mf = new Miniflare(convertV4MiniflareOptions(options));
const headers = { 'X-API-Key': 'fixture' };
const request = async (path, body, extra = {}) => {
  const response = await mf.dispatchFetch(`http://local${path}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
};
const heart = Array.from({ length: 5000 }, (_, i) => ({ date: new Date(began - (5000 - i) * MINUTE).toISOString(),
  Avg: 65, Min: 60, Max: 70, source: 'Watch' }));
const hrv = [60, 30].map(minutes => ({ date: new Date(began - minutes * MINUTE).toISOString(), qty: 60, source: 'Watch' }));
const upload = (stream, name, units, data, mode = 'live') => request(`/ingest/${stream}`,
  { data: { metrics: [{ name, units, data }] } }, { 'X-HAE-Aggregation': stream === 'heart' ? 'minutes' : 'raw', 'X-HAE-Mode': mode });
try {
  await upload('heart', 'heart_rate', 'bpm', heart, 'backfill');
  await upload('hrv', 'heart_rate_variability', 'ms', hrv);
  const published = await request('/__probe', { advance: MINUTE, alarm: true });
  assert.equal(cacheWrites, 1);
  assert.equal(published.cache.dueAt, began + 15 * MINUTE);
  await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options));
  const early = await request('/__probe', { advance: 10 * MINUTE, alarm: true });
  assert.equal(early.readStats.rowsRead, 0, 'cold early alarm must not query historical sample rows');
  assert.equal(early.nextAlarmAt, published.nextAlarmAt);
  assert.equal(cacheWrites, 1);
  // The first live batch following backfill evaluates it; subsequent duplicates can reuse.
  await upload('heart', 'heart_rate', 'bpm', heart);
  await request('/__probe', { advance: MINUTE, alarm: true });
  await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options));
  assert.equal((await upload('hrv', 'heart_rate_variability', 'ms', hrv)).stats.unchanged, 2);
  const duplicate = await request('/__probe', {});
  assert.equal(duplicate.readStats.rowsRead, 0, 'cold duplicate must only perform keyed deduplication reads');
  const revised = await upload('heart', 'heart_rate', 'bpm', [{ ...heart.at(-1), Avg: 75, Max: 80 }]);
  assert.equal(revised.stats.updated, 1);
  const changed = await request('/__probe', { advance: MINUTE, alarm: true });
  assert.ok(changed.readStats.rowsRead > 0, 'revision must load the updated authoritative history');
  const writesBeforeExpiry = cacheWrites;
  await request('/__probe', { advance: began + 6 * HOUR - changed.now, alarm: true });
  assert.ok(cacheWrites > writesBeforeExpiry);
  assert.equal(cached.healthIndices.pressure.reason, 'expired_hrv');
  console.log(`Runtime PASS: ${JSON.stringify({ heartRows: heart.length, earlyRowsRead: early.readStats.rowsRead,
    duplicateHistoryRowsRead: duplicate.readStats.rowsRead, revisionRowsRead: changed.readStats.rowsRead,
    expiryReason: cached.healthIndices.pressure.reason, cacheWrites })}`);
} finally { await mf.dispose(); await rm(storagePath, { recursive: true, force: true }); }
