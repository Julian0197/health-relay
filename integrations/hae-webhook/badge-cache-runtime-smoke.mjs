// Local workerd/SQLite integration only. Every outbound request is intercepted.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(process.argv[2]).href);
const directory = await mkdtemp(join(tmpdir(), 'badge-private-runtime-'));
const names = ['worker', 'health-card', 'overview-card', 'health-state', 'health-store', 'delivery', 'series', 'sql-usage',
  'workouts', 'analysis', 'signature', 'physiology', 'health-indices', 'health-profile', 'health-signature', 'dashboard',
  'pressure-history', 'dashboard-auth', 'dashboard-cache', 'signature-phrases', 'signature-holidays', 'miaobi', 'badge', 'badge-cache-publisher'];
let webWrites = 0, privateWrites = 0;
const options = { cf: false, resourcePersistencePath: directory, workers: [{ name: 'badge-private-test',
  modulesRoot: fileURLToPath(new URL('.', import.meta.url)),
  modules: names.map(name => ({ type: 'ESModule', path: fileURLToPath(new URL(`./${name}.mjs`, import.meta.url)) })),
  compatibilityDate: '2026-09-01', durableObjects: { HEALTH_STORE: { className: 'HealthStore', useSQLite: true } },
  bindings: { HAE_API_KEY: 'fixture-owner', BADGE_API_KEY: 'fixture-device', FEISHU_SIGN_SECRET: 'fixture',
    FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture', FEISHU_APP_ID: 'fixture', FEISHU_APP_SECRET: 'fixture',
    SIGNATURE_ENABLED: 'false', SIGNATURE_BASE_TOKEN: 'fixture-web-base', DASHBOARD_CACHE_TABLE_ID: 'fixture-web-table', DASHBOARD_CACHE_RECORD_ID: 'fixture-web-record',
    BADGE_CACHE_BASE_TOKEN: 'fixture-private-base', BADGE_CACHE_TABLE_ID: 'fixture-private-table', BADGE_CACHE_RECORD_ID: 'fixture-private-record' },
  outboundService: async request => {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'fixture', expire: 7200 });
    assert.equal(request.method, 'PUT');
    const { fields } = await request.json();
    if (path.endsWith('/tables/fixture-web-table/records/fixture-web-record')) {
      webWrites++; return Response.json({ code: 0, data: { record: { record_id: 'fixture-web-record', fields } } });
    }
    assert.match(path, /\/apps\/fixture-private-base\/tables\/fixture-private-table\/records\/fixture-private-record$/);
    privateWrites++;
    assert.deepEqual(Object.keys(fields).sort(), ['credential_sha256', 'payload']);
    const wrapper = JSON.parse(fields.payload);
    assert.equal(wrapper.version, 3); assert.equal(Object.keys(wrapper.payload).length, 26);
    assert.match(fields.credential_sha256, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(fields).includes('fixture-device'), false);
    if (privateWrites === 1) return new Response('synthetic unavailable', { status: 503 });
    return Response.json({ code: 0, data: { record: { record_id: 'fixture-private-record', fields } } });
  },
}] };
const headers = { 'X-API-Key': 'fixture-owner' };
let runtime = new Miniflare(convertV4MiniflareOptions(options));
try {
  const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const upload = await runtime.dispatchFetch('http://local/ingest/health', { method: 'POST',
    headers: { ...headers, 'X-HAE-Aggregation': 'days', 'X-HAE-Mode': 'backfill' },
    body: JSON.stringify({ data: { metrics: [{ name: 'step_count', units: 'count', data: [{ date, qty: 1200 }] }] } }) });
  assert.equal(upload.status, 200, await upload.text());
  const refresh = await runtime.dispatchFetch('http://local/dashboard-cache/refresh', { method: 'POST', headers });
  assert.equal(refresh.status, 200, await refresh.text());
  assert.equal(webWrites, 1); assert.equal(privateWrites, 1);
  const before = await (await runtime.dispatchFetch('http://local/status', { headers })).json();
  const webSchedule = before.dashboardCache;
  assert.ok(webSchedule.dueAt - Date.now() > 60000);
  await runtime.dispose(); runtime = new Miniflare(convertV4MiniflareOptions(options));
  console.log('Private runtime: web write succeeded, private write failed once; restarted SQLite and waiting for the real 60-second private retry.');
  const deadline = Date.now() + 80000;
  while (privateWrites < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(privateWrites, 2, 'real alarm must retry the pending private record after restart');
  assert.equal(webWrites, 1, 'private retry must not repeat the successful web Base write');
  const after = await (await runtime.dispatchFetch('http://local/status', { headers })).json();
  assert.deepEqual(after.dashboardCache, webSchedule);
  console.log('Private runtime PASS: compact wrapper/digest only, independent durable 60-second retry across restart, original web publication cadence preserved.');
} finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
