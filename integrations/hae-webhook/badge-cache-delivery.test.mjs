import test from 'node:test';
import assert from 'node:assert/strict';
import { HealthStore } from './health-store.mjs';
import { testSql } from './sql-test-helper.mjs';

const app = { FEISHU_APP_ID: 'fixture-app', FEISHU_APP_SECRET: 'fixture-secret' };
const web = { ...app, SIGNATURE_BASE_TOKEN: 'fixture-web-base', DASHBOARD_CACHE_TABLE_ID: 'fixture-web-table', DASHBOARD_CACHE_RECORD_ID: 'fixture-web-record' };
const badge = { ...app, BADGE_API_KEY: 'fixture-device-key', BADGE_CACHE_BASE_TOKEN: 'fixture-private-base',
  BADGE_CACHE_TABLE_ID: 'fixture-private-table', BADGE_CACHE_RECORD_ID: 'fixture-private-record' };
function fixture(env = {}) {
  let now = Date.parse('2026-10-21T04:00:00Z'), state, alarm;
  const storage = { sql: testSql(), get: async () => structuredClone(state),
    put: async (_, value) => { state = structuredClone(value); }, setAlarm: async value => { alarm = value; },
    transaction: async fn => {
      const before = structuredClone(state), beforeAlarm = alarm;
      storage.sql.exec('BEGIN');
      try { const result = await fn(); storage.sql.exec('COMMIT'); return result; }
      catch (error) { storage.sql.exec('ROLLBACK'); state = before; alarm = beforeAlarm; throw error; }
    } };
  const store = new HealthStore({ storage }, env, () => { throw new Error('test must stub all outbound publication'); }, () => now);
  store.series.put([{ kind: 'daily', metric: 'step_count', start: now - 3600000, end: now - 3600000,
    value: 1200, unit: 'count', source: 'fixture-watch' }], now);
  state = { metrics: [], workouts: [], streams: {}, lastReceivedAt: now, dataRevision: 1,
    delivery: { pending: false, dueAt: null }, dashboardCache: { lastPublishedAt: null, dueAt: now, error: null } };
  return { store, storage, now: () => now, advance: ms => { now += ms; }, state: () => structuredClone(state),
    alarm: () => alarm, replace: value => { state = structuredClone(value); } };
}

test('without private configuration existing publication has no extra delivery state, calls or timing changes', async () => {
  const f = fixture(web); let webCalls = 0, privateCalls = 0;
  f.store.dashboardCachePublisher.publish = async () => { webCalls++; return { ok: true }; };
  f.store.badgeCachePublisher = { publish: async () => { privateCalls++; throw new Error('disabled'); } };
  await f.store.publishDashboardCache({ force: true });
  assert.equal(webCalls, 1); assert.equal(privateCalls, 0);
  assert.equal(f.state().badgeCacheDelivery, undefined);
  assert.equal(f.state().dashboardCache.lastPublishedAt, f.now());
  assert.equal(f.alarm(), f.state().nextAlarmAt);
});

test('disabled private configuration ignores a leftover retry when scheduling ordinary work', async () => {
  const f = fixture(web), state = f.state();
  state.badgeCacheDelivery = { pending: true, dueAt: f.now() - 1000 };
  state.nextAlarmAt = f.now() + 60000; f.replace(state);
  f.store.badgeCachePublisher = { publish: async () => { throw new Error('private disabled'); } };
  await f.store.alarm();
  assert.equal(f.alarm(), state.nextAlarmAt);
});

test('private-only force refresh initializes the exact compact wrapper from already accepted facts', async () => {
  const f = fixture(badge); let webCalls = 0, payload;
  const initial = f.state(); delete initial.dashboardCache; f.replace(initial);
  f.store.dashboardCachePublisher.publish = async () => { webCalls++; throw new Error('web disabled'); };
  f.store.badgeCachePublisher = { publish: async cache => { payload = cache; return { ok: true }; } };
  const response = await f.store.fetch(new Request('https://store/dashboard-cache/refresh', { method: 'POST' }));
  assert.equal(response.status, 200); assert.equal(webCalls, 0);
  assert.equal(payload.version, 3); assert.equal(Object.keys(payload.payload).length, 26);
  assert.equal(payload.payload.steps, 1200); assert.deepEqual(payload, f.state().badgeCache);
  assert.equal(f.state().badgeCacheDelivery.pending, false);
  assert.equal(f.state().badgeCacheDelivery.lastPublishedAt, f.now());
});

test('private failure never changes successful web cadence; restart retries only saved wrapper without SQL history', async () => {
  const f = fixture({ ...web, ...badge }); let webCalls = 0, privateCalls = 0;
  f.store.dashboardCachePublisher.publish = async () => { webCalls++; return { ok: true }; };
  f.store.badgeCachePublisher = { publish: async () => { privateCalls++; return { ok: false, error: { reason: 'synthetic' } }; } };
  await f.store.publishDashboardCache({ force: true });
  const prepared = f.state(), webSchedule = prepared.dashboardCache;
  assert.equal(webCalls, 1); assert.equal(privateCalls, 1);
  assert.equal(prepared.badgeCacheDelivery.pending, true);
  assert.equal(prepared.badgeCacheDelivery.dueAt, f.now() + 60000);
  assert.equal(prepared.dashboardCache.lastPublishedAt, f.now());
  const nextNormal = prepared.nextAlarmAt;
  assert.ok(nextNormal > f.now() + 60000);
  assert.equal(f.alarm(), f.now() + 60000);
  const restarted = new HealthStore({ storage: f.storage }, { ...web, ...badge }, undefined, f.now);
  restarted.badgeCachePublisher = { publish: async cache => { privateCalls++; assert.deepEqual(cache, prepared.badgeCache); return { ok: true }; } };
  restarted.dashboardCachePublisher.publish = async () => { throw new Error('must not repeat successful web write'); };
  restarted.seriesForView = () => { throw new Error('private retry must not scan series'); };
  restarted.currentHealthIndices = () => { throw new Error('private retry must not score'); };
  restarted.save = () => { throw new Error('private retry must not reschedule normal publication'); };
  const exec = f.storage.sql.exec, attemptedSql = [];
  f.storage.sql.exec = (query, ...args) => {
    attemptedSql.push(query);
    assert.match(query, /^(?:BEGIN|COMMIT|ROLLBACK)/, 'private retry uses no SQL'); return exec(query, ...args);
  };
  f.advance(60000); await restarted.alarm();
  assert.ok(attemptedSql.every(query => /^(?:BEGIN|COMMIT|ROLLBACK)/.test(query)), 'private retry must not flush the SQL meter');
  assert.equal(privateCalls, 2); assert.equal(webCalls, 1);
  assert.deepEqual(f.state().dashboardCache, webSchedule);
  assert.equal(f.state().nextAlarmAt, nextNormal); assert.equal(f.alarm(), nextNormal);
  assert.equal(f.state().badgeCacheDelivery.pending, false);
  assert.equal(f.state().badgeCacheDelivery.error, null);
});

test('a newer prepared wrapper remains pending when an older private write completes', async () => {
  const f = fixture(badge); let release, first;
  f.store.badgeCachePublisher = { publish: async cache => { first = cache; return new Promise(resolve => { release = resolve; }); } };
  const work = f.store.publishDashboardCache({ force: true });
  const deadline = Date.now() + 1000;
  while (!release && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.ok(release, 'configured private publisher must receive the prepared wrapper');
  const newer = f.state(); newer.badgeCache = { ...newer.badgeCache, generatedAt: newer.badgeCache.generatedAt + 1,
    payload: { ...newer.badgeCache.payload, steps: 1300 } };
  newer.badgeCacheDelivery.pending = true; newer.badgeCacheDelivery.dueAt = f.now(); f.replace(newer);
  release({ ok: true }); await work;
  assert.equal(first.payload.steps, 1200); assert.equal(f.state().badgeCache.payload.steps, 1300);
  assert.equal(f.state().badgeCacheDelivery.pending, true);
  f.store.badgeCachePublisher.publish = async cache => { assert.equal(cache.payload.steps, 1300); return { ok: true }; };
  await f.store.publishBadgeCache(); assert.equal(f.state().badgeCacheDelivery.pending, false);
});
