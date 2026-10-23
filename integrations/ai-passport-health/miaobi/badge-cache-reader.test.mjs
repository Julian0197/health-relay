import assert from 'node:assert/strict';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { createBadgeCache, readBadgeCache } from '../../hae-webhook/badge.mjs';

const BASE = 'example_base';
const TABLE = 'example_table';
const RECORD = 'example_record';
const KEY = 'synthetic-badge-device-secret';
const NOW = Date.parse('2026-10-21T04:00:00Z');
const DAY = 86400000;
const digest = value => createHash('sha256').update(value).digest('hex');

function cache() {
  const value = createBadgeCache({
    healthIndices: {
      pressure: { score: 42, evidenceAt: NOW - 3600000, validUntil: NOW + 3600000 },
      sleep: { score: 82, date: '2026-10-21', endAt: NOW - 7200000 },
    },
    heart: { latest: { v: 66, s: NOW - 60000 } }, hrv: [{ v: 31, t: NOW - 120000 }],
    sleep: [{ date: '2026-10-21', end: NOW - 7200000, asleepMinutes: 391 }],
    daily: [{ date: '2026-10-21', metrics: { step_count: { v: 1234, unit: 'count' } } }],
    pressureHistory: { days: Array.from({ length: 7 }, (_, i) => ({
      date: new Date(NOW - (6 - i) * DAY).toISOString().slice(0, 10), status: 'available', median: 30 + i,
    })) },
  }, NOW, { workouts: [{ start: NOW - 3600000, end: NOW - 1800000, durationMs: 600000, activeEnergyKcal: 60 }] });
  // Preserve a genuine old wrapper while the default producer migrates to v3.
  value.version = value.payload.v = 2;
  delete value.payload.sleepWeek;
  delete value.payload.workoutTypes;
  return value;
}

function cacheV3() {
  const value = cache();
  value.version = value.payload.v = 3;
  value.payload.sleepWeek = Array.from({ length: 7 }, (_, i) => ({
    date: new Date(NOW - (6 - i) * DAY).toISOString().slice(0, 10),
    total: i === 2 ? null : 390 + i, deep: i === 2 ? null : 60,
    core: i === 2 ? null : 200 + i, rem: i === 2 ? null : 90,
    awake: i === 2 ? null : 15, unknown: i === 2 ? null : 40,
  }));
  value.payload.workoutTypes = ['Running', 'Strength'];
  return value;
}

const emptySleepNight = date => ({ date, total: null, deep: null, core: null, rem: null, awake: null, unknown: null });

function records(value = cache(), credential = digest(KEY)) {
  return { code: 0, data: { records: [{ record_id: RECORD, fields: {
    payload: JSON.stringify(value), credential_sha256: credential,
  } }] } };
}

function load(getRecords = async () => records(), { now = NOW, timers = {} } = {}) {
  const calls = [], comparisons = [];
  const sandbox = {
    module: { exports: {} }, Response, Buffer,
    Date: class extends Date { static now() { return now; } },
    setTimeout: timers.setTimeout ?? setTimeout, clearTimeout: timers.clearTimeout ?? clearTimeout,
    window: { magic: { base_records_get: (...args) => { calls.push(args); return getRecords(...args); } } },
    require(name) {
      assert.equal(name, 'node:crypto');
      return { createHash, timingSafeEqual(a, b) { comparisons.push([a.length, b.length]); return timingSafeEqual(a, b); } };
    },
  };
  vm.runInNewContext(readFileSync(new URL('./badge-cache-reader.cjs', import.meta.url), 'utf8'), sandbox);
  return { handler: sandbox.module.exports, calls, comparisons };
}

const request = (key = KEY, method = 'GET') => new Request('https://faas.test/?base=public&record=another', {
  method, headers: key === undefined ? {} : { 'X-API-Key': key },
});
async function failure(response, status, error) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { ok: false, error });
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
}

test('only GET and a 16..128 printable ASCII key can initiate a private Base read', async () => {
  const { handler, calls } = load(() => assert.fail('must not read Base'));
  const post = await handler(request(KEY, 'POST'));
  assert.equal(post.headers.get('Allow'), 'GET');
  await failure(post, 405, 'method_not_allowed');
  for (const key of ['', 'a'.repeat(15), 'a'.repeat(129), 'a'.repeat(15) + '\u007f', 'a'.repeat(15) + 'é']) {
    await failure(await handler(request(key)), 401, 'unauthorized');
  }
  await failure(await handler(new Request('https://faas.test/')), 401, 'unauthorized');
  assert.equal(calls.length, 0);
});

test('reads only the fixed private record and returns exactly the 24-field projection without stored credentials', async () => {
  const reader = load();
  const response = await reader.handler(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const text = await response.text(), payload = JSON.parse(text);
  assert.deepEqual(payload, readBadgeCache(cache(), NOW));
  assert.equal(Object.keys(payload).length, 24);
  assert.ok(Buffer.byteLength(text) <= 4094);
  assert.equal(text.includes(digest(KEY)), false);
  assert.equal(text.includes('generatedAt'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(reader.calls)), [[BASE, TABLE, [RECORD]]]);
  assert.deepEqual(reader.comparisons, [[32, 32]]);
});

test('compares SHA256 bytes in constant time and refuses a wrong key before decoding health data', async () => {
  const data = records(); data.data.records[0].fields.payload = 'broken-private-health';
  const { handler, comparisons } = load(async () => data);
  await failure(await handler(request('synthetic-wrong-device-secret')), 401, 'unauthorized');
  assert.deepEqual(comparisons, [[32, 32]]);
});

test('plain and rich-text fields work for boundary-length credentials without embedding a secret', async () => {
  for (const key of ['x'.repeat(16), 'x'.repeat(128)]) {
    const data = records(cache(), digest(key));
    const fields = data.data.records[0].fields;
    fields.payload = [{ type: 'text', text: fields.payload.slice(0, 100) }, { type: 'text', text: fields.payload.slice(100) }];
    fields.credential_sha256 = [{ type: 'text', text: fields.credential_sha256 }];
    assert.equal((await load(async () => data).handler(request(key))).status, 200);
  }
});

test('Base errors, missing/wrong records and damaged credential fields return a neutral 503', async () => {
  for (const getRecords of [
    async () => { throw new Error('private permission details'); },
    async () => ({ code: 91403, msg: 'private permission details' }),
    async () => ({ code: 0, data: { records: [] } }),
    async () => { const data = records(); data.data.records[0].record_id = 'another'; return data; },
    async () => records(cache(), 'not-a-sha256'),
  ]) await failure(await load(getRecords).handler(request()), 503, 'badge_cache_unavailable');
});

test('an 8-second total deadline returns a neutral 503 and clears its timer', async () => {
  let deadline, cleared = false;
  const { handler } = load(() => new Promise(() => {}), { timers: {
    setTimeout(callback, delay) { assert.equal(delay, 8000); deadline = callback; return 1; },
    clearTimeout(id) { assert.equal(id, 1); cleared = true; },
  } });
  const pending = handler(request());
  deadline();
  await failure(await pending, 503, 'badge_cache_unavailable');
  assert.equal(cleared, true);
});

test('reads current facts on every invocation instead of keeping a health cache', async () => {
  const value = cache();
  const { handler, calls } = load(async () => records(value));
  assert.equal((await (await handler(request())).json()).steps, 1234);
  value.payload.steps = 4321;
  assert.equal((await (await handler(request())).json()).steps, 4321);
  assert.equal(calls.length, 2);
});

test('presentation stays identical to readBadgeCache at expiry, Beijing midnight and trend boundaries', async () => {
  const value = cache(), original = structuredClone(value);
  for (const time of [NOW, NOW + 3600000, Date.parse('2026-10-21T15:59:59Z'),
    Date.parse('2026-10-21T16:00:00Z'), NOW + 3 * DAY, NOW + 8 * DAY]) {
    const response = await load(async () => records(value), { now: time }).handler(request());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), readBadgeCache(value, time));
  }
  assert.deepEqual(value, original);
  const afterMidnight = await (await load(async () => records(value), { now: NOW + DAY }).handler(request())).json();
  assert.equal(afterMidnight.day, '2026-10-22');
  for (const field of ['pressure', 'sleepScore', 'sleepMinutes', 'workoutCount', 'workoutMinutes', 'workoutKcal',
    'steps', 'activeKcal', 'exerciseMinutes', 'distanceMeters']) assert.equal(afterMidnight[field], null);
  assert.equal(afterMidnight.asOf, value.payload.asOf);
  assert.equal(afterMidnight.heartAt, value.payload.heartAt);
});

test('rejects invalid wrappers, impossible dates, wrong field counts and out-of-range values', async () => {
  const mutations = [
    value => { value.version = 1; },
    value => { value.generatedAt = NOW + 1000; },
    value => { value.generatedAt = null; },
    value => { value.pressureValidUntil = 'tomorrow'; },
    value => { value.extra = 'not-in-contract'; },
    value => { value.payload.day = '2026-10-20'; },
    value => { value.payload.day = '2026-02-30'; },
    value => { value.payload.sleepDate = '2026-02-30'; },
    value => { value.payload.sleepDate = '2026-10-20'; },
    value => { delete value.payload.steps; },
    value => { value.payload.extra = 1; },
    value => { value.payload.pressure = 101; },
    value => { value.payload.heart = 0; },
    value => { value.payload.steps = 1.5; },
    value => { value.payload.online = 'yes'; },
    value => { value.payload.demo = true; },
    value => { value.payload.retained = 1; },
    value => { value.payload.hrvMethod = 'other'; },
    value => { value.payload.asOf = '10/21 25:01'; },
    value => { value.payload.trend = [30]; },
    value => { value.payload.trend[0] = -1; },
  ];
  for (const mutate of mutations) {
    const value = cache(); mutate(value);
    await failure(await load(async () => records(value)).handler(request()), 503, 'badge_cache_unavailable');
  }
});

test('invalid JSON and an oversized saved wrapper do not reach the device', async () => {
  for (const payload of ['{invalid-json', JSON.stringify(cache()) + ' '.repeat(4095)]) {
    const data = records(); data.data.records[0].fields.payload = payload;
    await failure(await load(async () => data).handler(request()), 503, 'badge_cache_unavailable');
  }
});

test('accepts the v3 26-field projection and still reads a v2 wrapper during migration', async () => {
  for (const value of [cache(), cacheV3()]) {
    const response = await load(async () => records(value)).handler(request());
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), value.payload);
    assert.equal(Object.keys(JSON.parse(body)).length, value.version === 3 ? 26 : 24);
    assert.ok(Buffer.byteLength(body) < 4094);
    assert.equal(body.includes('generatedAt'), false);
    assert.equal(body.includes(digest(KEY)), false);
  }
});

test('v3 retains the last pressure and its original time across Beijing midnight', async () => {
  const value = cacheV3(), original = structuredClone(value);
  for (const now of [Date.parse('2026-10-21T16:00:00Z'), NOW + DAY, NOW + 8 * DAY]) {
    const response = await load(async () => records(value), { now }).handler(request());
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.day, new Date(now + 8 * 3600000).toISOString().slice(0, 10));
    assert.equal(payload.pressure, value.payload.pressure);
    assert.equal(payload.pressureAt, value.payload.pressureAt);
    assert.equal(payload.retained, true);
    assert.equal(payload.asOf, value.payload.asOf);
    for (const field of ['sleepScore', 'sleepMinutes', 'workoutCount', 'workoutMinutes', 'workoutKcal',
      'steps', 'activeKcal', 'exerciseMinutes', 'distanceMeters']) assert.equal(payload[field], null);
    assert.equal(payload.sleepDate, '');
    assert.deepEqual(payload.workoutTypes, []);
    assert.deepEqual(payload.trend, now >= NOW + 8 * DAY ? Array(7).fill(null) : [...value.payload.trend.slice(1), null]);
  }
  assert.deepEqual(value, original);
});

test('v3 moves seven dated sleep nights forward and preserves unknown or conflicted nights as null', async () => {
  const value = cacheV3();
  for (const elapsed of [0, 1, 3, 7, 8]) {
    const response = await load(async () => records(value), { now: NOW + elapsed * DAY }).handler(request());
    assert.equal(response.status, 200);
    const payload = await response.json();
    const expected = Array.from({ length: 7 }, (_, i) => {
      const date = new Date(NOW + (elapsed - 6 + i) * DAY).toISOString().slice(0, 10);
      return value.payload.sleepWeek.find(night => night.date === date) ?? emptySleepNight(date);
    });
    assert.deepEqual(payload.sleepWeek, expected);
    assert.equal(payload.sleepWeek.length, 7);
  }
  const missing = value.payload.sleepWeek[2];
  assert.deepEqual(missing, emptySleepNight(missing.date));
});

test('v3 accepts explicit zero stages, unknown stages and distinct printable ASCII workout labels at the limits', async () => {
  const value = cacheV3();
  Object.assign(value.payload.sleepWeek[0], { total: 0, deep: 0, core: 0, rem: 0, awake: 0, unknown: 0 });
  Object.assign(value.payload.sleepWeek[1], { total: 1440, deep: null, core: null, rem: null, awake: null, unknown: 1440 });
  value.payload.workoutTypes = Array.from({ length: 8 }, (_, i) => `${i}${'x'.repeat(23)}`);
  const response = await load(async () => records(value)).handler(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), value.payload);
});

test('v3 rejects mismatched versions, malformed sleep history and invalid workout labels', async () => {
  const mutations = [
    value => { value.version = 2; },
    value => { value.payload.v = 2; },
    value => { delete value.payload.sleepWeek; },
    value => { delete value.payload.workoutTypes; },
    value => { value.payload.extra = true; },
    value => { value.payload.sleepWeek = null; },
    value => { value.payload.sleepWeek.pop(); },
    value => { value.payload.sleepWeek.push(emptySleepNight('2026-10-22')); },
    value => { value.payload.sleepWeek[0] = null; },
    value => { value.payload.sleepWeek[0].date = '2026-02-30'; },
    value => { value.payload.sleepWeek[0].date = '2026-10-22'; },
    value => { value.payload.sleepWeek[0].date = value.payload.sleepWeek[1].date; },
    value => { value.payload.sleepWeek.reverse(); },
    value => { delete value.payload.sleepWeek[0].unknown; },
    value => { value.payload.sleepWeek[0].conflict = true; },
    value => { value.payload.sleepWeek[0].total = 1441; },
    value => { value.payload.sleepWeek[0].deep = -1; },
    value => { value.payload.sleepWeek[0].core = 0.5; },
    value => { value.payload.sleepWeek[0].rem = '90'; },
    value => { value.payload.workoutTypes = null; },
    value => { value.payload.workoutTypes = ['Running', 'Running']; },
    value => { value.payload.workoutTypes = ['']; },
    value => { value.payload.workoutTypes = ['跑步']; },
    value => { value.payload.workoutTypes = ['Run\n']; },
    value => { value.payload.workoutTypes = ['x'.repeat(25)]; },
    value => { value.payload.workoutTypes = Array.from({ length: 9 }, (_, i) => `Type ${i}`); },
  ];
  for (const mutate of mutations) {
    const value = cacheV3(); mutate(value);
    await failure(await load(async () => records(value)).handler(request()), 503, 'badge_cache_unavailable');
  }
});

test('v3 does not mark absent pressure as retained and keeps the strict 4094-byte boundary', async () => {
  const value = cacheV3();
  value.payload.pressure = null; value.payload.pressureAt = ''; value.payload.retained = false;
  const response = await load(async () => records(value), { now: NOW + DAY }).handler(request());
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.pressure, null); assert.equal(payload.retained, false); assert.equal(payload.pressureAt, '');
  for (const size of [4093, 4094]) {
    const data = records(value), fields = data.data.records[0].fields;
    fields.payload += ' '.repeat(size - Buffer.byteLength(fields.payload));
    const result = await load(async () => data).handler(request());
    if (size === 4093) assert.equal(result.status, 200);
    else await failure(result, 503, 'badge_cache_unavailable');
  }
});

test('v3 rejects a complete stage breakdown that contradicts the total asleep minutes', async () => {
  for (const total of [0, 389, 391]) {
    const value = cacheV3();
    value.payload.sleepWeek[0].total = total;
    await failure(await load(async () => records(value)).handler(request()), 503, 'badge_cache_unavailable');
  }
});

test('v3 workout labels use the firmware plain ASCII alphabet without JSON escapes', async () => {
  for (const label of ['Run"ning', 'Run\\ning', 'Run/Walk', 'Run_Walk', 'Run+Walk']) {
    const value = cacheV3(); value.payload.workoutTypes = [label];
    await failure(await load(async () => records(value)).handler(request()), 503, 'badge_cache_unavailable');
  }
  const value = cacheV3(); value.payload.workoutTypes = ['Type 2-Run'];
  assert.equal((await load(async () => records(value)).handler(request())).status, 200);
});

test('reader matches the selected cloud module for both versions at date and expiry boundaries', async () => {
  const cloud = process.env.BADGE_V3_MODULE
    ? await import(pathToFileURL(resolve(process.env.BADGE_V3_MODULE)).href)
    : { createBadgeCache, readBadgeCache };
  const version = cloud.createBadgeCache({}, NOW).version;
  if (process.env.BADGE_V3_MODULE) assert.equal(version, 3, 'explicit parity target must implement v3');
  const values = version === 3 ? [cache(), cacheV3()] : [cache()];
  const produced = cloud.createBadgeCache({
    healthIndices: { pressure: { score: 41, evidenceAt: NOW - DAY, retained: true },
      sleep: { score: 82, date: '2026-10-21', endAt: NOW - 7200000 } },
    sleep: [{ date: '2026-10-21', end: NOW - 7200000, asleepMinutes: 390.5,
      awakeMinutes: 17, stages: { deep: 70.4, core: 250.4, rem: 40.2, asleep: 29.5 } }],
  }, NOW, { workouts: [{ name: '跑步', start: NOW - 3600000, end: NOW - 1800000,
    durationMs: 600000, activeEnergyKcal: 60 }] });
  values.push(produced);
  if (version === 3) {
    assert.deepEqual(produced.payload.workoutTypes, ['Running']);
    const night = produced.payload.sleepWeek[6];
    assert.equal(night.deep + night.core + night.rem + night.unknown, night.total);
    assert.equal(produced.payload.pressure, 41);
    assert.equal(produced.payload.retained, true);
  }
  const times = [NOW, NOW + 3600000, Date.parse('2026-10-21T15:59:59.999Z'),
    Date.parse('2026-10-21T16:00:00Z'), NOW + DAY, NOW + 3 * DAY, NOW + 7 * DAY, NOW + 8 * DAY];
  for (const value of values) {
    for (const now of times) {
      const response = await load(async () => records(value), { now }).handler(request());
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), cloud.readBadgeCache(value, now));
    }
  }
});

test('v3 sleep dates remain consecutive through leap days and the year boundary', async () => {
  for (const dayEnd of ['2028-02-28T15:59:59.999Z', '2028-02-29T15:59:59.999Z', '2026-12-31T15:59:59.999Z']) {
    const generatedAt = Date.parse(dayEnd), now = generatedAt + 1;
    const value = cacheV3();
    value.generatedAt = generatedAt;
    value.pressureValidUntil = now + 3600000;
    value.payload.day = new Date(generatedAt + 8 * 3600000).toISOString().slice(0, 10);
    value.payload.sleepDate = value.payload.day;
    value.payload.sleepWeek.forEach((night, i) => {
      night.date = new Date(generatedAt + 8 * 3600000 - (6 - i) * DAY).toISOString().slice(0, 10);
    });
    const response = await load(async () => records(value), { now }).handler(request());
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.sleepWeek.slice(0, 6), value.payload.sleepWeek.slice(1));
    const day = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
    assert.equal(payload.day, day);
    assert.deepEqual(payload.sleepWeek[6], emptySleepNight(day));
    assert.equal(payload.retained, true);
  }
});
