import test from 'node:test';
import assert from 'node:assert/strict';
import { DashboardCachePublisher, dashboardCacheEnabled } from './dashboard-cache.mjs';
import * as dashboard from './dashboard.mjs';

const baseEnv = {
  FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret',
  SIGNATURE_BASE_TOKEN: 'fixture-signature-base',
  DASHBOARD_CACHE_TABLE_ID: 'tblcache', DASHBOARD_CACHE_RECORD_ID: 'reccache',
};

test('reader projection removes sleep boundaries without changing private measurements or scores', () => {
  assert.equal(typeof dashboard.dashboardForReaders, 'function');
  const start = Date.parse('2026-10-07T23:30:00+08:00');
  const end = Date.parse('2026-10-08T08:10:00+08:00');
  const dto = {
    schemaVersion: 'dashboard-v1', range: '7d', contentHash: 'private',
    sleep: [{ date: '2026-10-08', start, end, stages: { core: 400 }, score: 67 }],
    healthIndices: { sleep: { date: '2026-10-08', endAt: end, score: 67 } },
    channels: { sleep: { count: 10, latestAt: end }, heart: { latestAt: end + 60000 } },
    heart: { latest: { s: end + 60000, v: 66 } },
  };
  const before = structuredClone(dto);
  const view = dashboard.dashboardForReaders(dto);
  assert.deepEqual(dto, before);
  assert.deepEqual(view.sleep, [{ date: '2026-10-08', stages: { core: 400 }, score: 67 }]);
  assert.deepEqual(view.healthIndices.sleep, { date: '2026-10-08', score: 67 });
  assert.deepEqual(view.channels.sleep, { count: 10, latestDate: '2026-10-08' });
  assert.deepEqual(view.heart, dto.heart);
  assert.deepEqual(view.channels.heart, dto.channels.heart);
  const { contentHash, ...content } = view;
  assert.equal(contentHash, dashboard.contentHash(content));
  assert.deepEqual(dashboard.dashboardForReaders(view), view);
});

test('cache publishing requires table/record plus a base token and Feishu app creds', () => {
  assert.equal(dashboardCacheEnabled(baseEnv), true);
  assert.equal(dashboardCacheEnabled({ ...baseEnv, DASHBOARD_CACHE_TABLE_ID: '' }), false);
  assert.equal(dashboardCacheEnabled({ ...baseEnv, SIGNATURE_BASE_TOKEN: '', DASHBOARD_CACHE_BASE_TOKEN: '' }), false);
  assert.equal(dashboardCacheEnabled({ ...baseEnv, DASHBOARD_CACHE_BASE_TOKEN: 'fixture-display-base' }), true);
});

test('publisher PUTs both payloads into the configured record and reads them back', async () => {
  const calls = []; let stored;
  const publisher = new DashboardCachePublisher(baseEnv, async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/v3/tenant_access_token/internal')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant', expire: 7200 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (options.method === 'PUT') stored = JSON.parse(options.body).fields;
    return new Response(JSON.stringify({ code: 0, data: { record: { record_id: 'reccache', fields: stored } } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }, () => 1000);

  const dto = { schemaVersion: 'dashboard-v1', sleep: [{ date: '2026-10-08', start: 100, end: 200, score: 67 }] };
  const result = await publisher.publish({ payload24h: JSON.stringify({ ...dto, range: '24h' }),
    payload7d: JSON.stringify({ ...dto, range: '7d' }), generatedAt: 42 });
  assert.equal(result.ok, true);
  const put = calls.find(c => c.url.includes('/records/reccache'));
  assert.ok(put);
  assert.equal(put.options.method, 'PUT');
  assert.match(put.url, /apps\/fixture-signature-base\/tables\/tblcache\/records\/reccache/);
  assert.equal(put.options.headers.Authorization, 'Bearer tenant');
  const fields = JSON.parse(put.options.body).fields;
  assert.equal(fields.generated_at, 42);
  for (const key of ['payload_24h', 'payload_7d']) {
    assert.deepEqual(JSON.parse(fields[key]).sleep, [{ date: '2026-10-08', score: 67 }]);
  }
  assert.ok(calls.some(c => c.options.method === 'GET'));
});

test('publisher rejects an echoed write when the stored window is still old', async () => {
  const publisher = new DashboardCachePublisher(baseEnv, async (url, options) => {
    if (url.endsWith('token/internal')) return Response.json({ code: 0, tenant_access_token: 'tenant', expire: 7200 });
    const fields = options.method === 'PUT' ? JSON.parse(options.body).fields : { payload_24h: '{}', payload_7d: '{}' };
    return Response.json({ code: 0, data: { record: { record_id: 'reccache', fields } } });
  }, () => 1000);
  const result = await publisher.publish({ payload24h: '{"range":"24h"}', payload7d: '{"range":"7d"}', generatedAt: 42 });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'record_readback_mismatch');
  assert.deepEqual(result.error.fields, ['payload_24h', 'payload_7d']);
});

test('dense heart charts fit the encoded cell budget while retaining scores and gaps', async () => {
  let stored;
  const publisher = new DashboardCachePublisher(baseEnv, async (url, options) => {
    if (url.endsWith('token/internal')) return Response.json({ code: 0, tenant_access_token: 'tenant', expire: 7200 });
    if (options.method === 'PUT') stored = JSON.parse(options.body).fields;
    return Response.json({ code: 0, data: { record: { record_id: 'reccache', fields: stored } } });
  }, () => 1000);
  const points = Array.from({ length: 1440 }, (_, i) => ({ s: 1792800000000+i*60000,
    e: 1792800060000+i*60000, v: 70, min: 55, max: 120 })).filter((_, i) => i < 600 || i >= 660);
  const dto = { range: '24h', healthIndices: { sleep: { score: 85, baselineDays: 8 } }, hrv: [{ t: 100, v: 61 }],
    heart: { points, latest: points.at(-1), cap: 5000, truncated: false }, sleep: [] };
  assert.ok(new TextEncoder().encode(JSON.stringify(JSON.stringify(dto))).length > 100000);
  const result = await publisher.publish({ payload24h: JSON.stringify(dto), payload7d: '{}', generatedAt: 42 });
  assert.equal(result.ok, true);
  assert.ok(new TextEncoder().encode(JSON.stringify(stored.payload_24h)).length < 100000);
  const actual = JSON.parse(stored.payload_24h);
  assert.deepEqual(actual.healthIndices, dto.healthIndices);
  assert.deepEqual(actual.hrv, dto.hrv);
  assert.deepEqual(actual.heart.latest, dto.heart.latest);
  assert.ok(actual.heart.points.length < points.length);
  assert.ok(actual.heart.points.every(p => p.min === 55 && p.max === 120));
  assert.ok(actual.heart.points.every(p => p.e <= points[599].e || p.s >= points[600].s));
  const { contentHash, ...content } = actual;
  assert.equal(contentHash, dashboard.contentHash(content));
});

test('publisher detects a successful response that leaves a window unchanged', async () => {
  const publisher = new DashboardCachePublisher(baseEnv, async (url, options) => {
    if (url.endsWith('token/internal')) return Response.json({ code: 0, tenant_access_token: 'tenant', expire: 7200 });
    const { fields } = JSON.parse(options.body);
    return Response.json({ code: 0, data: { record: { record_id: 'reccache', fields: { ...fields, payload_7d: '{}' } } } });
  }, () => 1000);
  const result = await publisher.publish({ payload24h: '{"range":"24h"}', payload7d: '{"range":"7d"}', generatedAt: 42 });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'partial_record_response');
  assert.deepEqual(result.error.fields, ['payload_7d']);
});

test('publisher rejects a response echoing a different record', async () => {
  const publisher = new DashboardCachePublisher(baseEnv, async url =>
    new Response(JSON.stringify(url.endsWith('token/internal')
      ? { code: 0, tenant_access_token: 'tenant', expire: 7200 }
      : { code: 0, data: { record: { record_id: 'recOTHER' } } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }), () => 1000);
  const result = await publisher.publish({ payload24h: '{}', payload7d: '{}', generatedAt: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'invalid_record_response');
});
