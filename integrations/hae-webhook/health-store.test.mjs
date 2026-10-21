import test from 'node:test';
import assert from 'node:assert/strict';
import { HealthStore } from './health-store.mjs';
import { testSql } from './sql-test-helper.mjs';
import { parseSeries } from './series.mjs';
import { summarizeHealth } from './health-card.mjs';
import { evaluateHealthIndices } from './health-indices.mjs';
import { handleRequest } from './worker.mjs';

// Transaction fake is only for domain tests; runtime smoke verifies actual DO storage/alarms.
function fixture(send = async () => Response.json({ code: 0 }), extraEnv = {}) {
  let now = Date.parse('2026-09-24T02:00:00Z');
  let data, alarm;
  const storage = {
    sql: testSql(),
    get: async () => structuredClone(data),
    put: async (_, value) => { data = structuredClone(value); },
    setAlarm: async time => { alarm = time; },
    transaction: async fn => {
      const previous = structuredClone(data), previousAlarm = alarm;
      storage.sql.exec('BEGIN');
      try { const result = await fn(storage); storage.sql.exec('COMMIT'); return result; }
      catch (error) { storage.sql.exec('ROLLBACK'); data = previous; alarm = previousAlarm; throw error; }
    },
  };
  const env = { FEISHU_SIGN_SECRET: 'test', FEISHU_WEBHOOK_URL: 'https://open.larkoffice.com/open-apis/bot/v2/hook/test' };
  Object.assign(env, extraEnv);
  const store = new HealthStore({ storage }, env, send, () => now);
  const upload = async (qty = 1000, stream = 'health') => store.fetch(new Request('https://store/ingest', {
    method: 'POST', body: JSON.stringify({ stream, aggregation: 'days', summary: summarizeHealth({ data: { metrics: [
      { name: 'step_count', units: 'count', data: [{ date: '2026-09-24', qty }] },
    ] } }) }),
  }));
  return { store, upload, storage, advance: ms => { now += ms; }, now: () => now, data: () => data, nextAlarm: () => alarm };
}

test('dashboard month workout summaries use retained heart windows while general charts keep their seven-day scope', async () => {
  const f = fixture(), start = f.now() - 20 * 86400000;
  f.store.series.put([
    { kind: 'workout', name: '游泳', start, end: start + 3600000, source: 'Watch', durationMs: 3600000, activeEnergyKcal: 300 },
    { kind: 'heart', start, end: start + 60000, value: 120, max: 150, source: 'Watch' },
  ], f.now());
  const dto = await (await f.store.fetch(new Request('https://store/dashboard?range=24h'))).json();
  assert.ok(dto.workoutHistory?.records[0]?.heart, 'older heart windows missing');
  assert.equal(dto.workoutHistory.records[0].heart.avg, 120);
  assert.equal(dto.workoutHistory.records[0].heart.max, 150);
  assert.equal(dto.heart.points.length, 0);
  assert.equal(dto.range, '24h');
});

test('persist first, coalesce initial uploads, deduplicate across object restart', async () => {
  let sends = 0;
  const f = fixture(async () => { sends++; return Response.json({ code: 0 }); });
  const result = await (await f.upload()).json();
  assert.equal(result.stored, true);
  assert.equal(result.notification, 'queued');
  assert.equal(sends, 0);
  assert.equal(f.nextAlarm(), f.now() + 60000);
  f.advance(60000); await f.store.alarm();
  assert.equal(sends, 1);
  const duplicate = await (await f.upload()).json();
  assert.equal(duplicate.notification, 'unchanged');
  await f.store.alarm(); assert.equal(sends, 1);
  const restarted = new HealthStore({ storage: f.storage }, {}, () => { throw new Error('do not send'); }, f.now);
  const status = await (await restarted.fetch(new Request('https://store/status'))).json();
  assert.equal(status.metrics, 1);
  assert.equal(status.delivery.lastSentAt, f.now());
});

test('combined minute HRV survives request parsing, storage and overview without relabeling RMSSD', async () => {
  const f = fixture();
  const body = { data: { metrics: [
    { name: 'heart_rate_variability', units: 'ms', data: [{ date: '2026-09-24T01:00:00Z', qty: 50 }] },
    { name: 'heart_rate_variability_rmssd', units: 'ms', data: [{ date: '2026-09-24T01:05:00Z', qty: 35 }] },
  ] } };
  const env = { HAE_API_KEY: 'fixture-ingest-key', FEISHU_WEBHOOK_URL: 'https://open.larkoffice.com/open-apis/bot/v2/hook/test',
    FEISHU_SIGN_SECRET: 'test', HEALTH_STORE: { idFromName: () => 'personal',
    get: () => ({ fetch: request => f.store.fetch(request) }) } };
  const post = () => handleRequest(new Request('https://demo.test/ingest/hrv', { method: 'POST',
    headers: { 'X-API-Key': env.HAE_API_KEY, 'X-HAE-Aggregation': 'minutes', 'automation-aggregation': 'minutes' },
    body: JSON.stringify(body) }), env);
  const first = await post();
  assert.equal(first.status, 200);
  assert.equal((await first.json()).stats.inserted, 2);
  const status = await (await f.store.fetch(new Request('https://store/status'))).json();
  assert.equal(status.dataTimes.heart_rate_variability.latestSampleAt, Date.parse('2026-09-24T01:00:00Z'));
  assert.equal(status.dataTimes.heart_rate_variability_rmssd.latestSampleAt, Date.parse('2026-09-24T01:05:00Z'));
  const view = f.store.view(f.data(), f.now());
  const sdnn = view.metrics.find(m => m.name === 'heart_rate_variability');
  const rmssd = view.metrics.find(m => m.name === 'heart_rate_variability_rmssd');
  assert.equal(sdnn.latest.value, '50 ms');
  assert.equal(rmssd.latest.value, '35 ms');
  assert.equal(rmssd.aggregation, 'minutes');
  assert.match(rmssd.latest.details.join(' '), /RMSSD/);
  assert.doesNotMatch(rmssd.latest.details.join(' '), /SDNN|单次记录/);
  assert.equal((await (await post()).json()).stats.unchanged, 2);
});

test('numeric signature ingestion evaluates and records pressure only once', async t => {
  const f = signatureFixture(undefined, 'health-indices-v1');
  const seriesRead = t.mock.method(f.store, 'physiologySeries');
  const record = t.mock.method(f.store.pressureHistory, 'record');
  assert.equal((await detailUpload(f)).status, 200);
  assert.equal(seriesRead.mock.callCount(), 1);
  assert.equal(record.mock.callCount(), 1);
});

test('signature publication reuses its persisted decision across a cold restart before expiry', async () => {
  const f = signatureFixture(undefined, 'health-indices-v1');
  await detailUpload(f);
  const before = f.data().signatureCandidate;
  f.advance(60000);
  const restarted = new HealthStore({ storage: f.storage }, f.store.env, undefined, f.now);
  restarted.physiologySeries = () => { throw new Error('unchanged decision must not reload history'); };
  restarted.signaturePublisher.publish = async () => ({ ok: true });
  await restarted.publishSignature();
  assert.equal(f.data().signatureDelivery.sentTitle, before.title);
  assert.equal(f.data().signatureCandidate.evaluatedAt, before.evaluatedAt);
});

test('a cached decision from the workout-exclusion rule is recomputed after upgrade', async () => {
  const f = signatureFixture(undefined, 'health-indices-v1');
  await detailUpload(f);
  const state = f.data();
  state.indicesCache.key = JSON.stringify(['health-indices-cache-v5', f.store.healthProfile]);
  state.indicesCache.decision.ruleVersion = 'health-indices-v3-nightly';
  state.indicesCache.decision.pressure.reason = 'sleep_or_workout';
  const result = f.store.currentHealthIndices(state, f.now());
  assert.equal(result.ruleVersion, 'health-indices-v4-nightly');
  assert.notEqual(result.pressure.reason, 'sleep_or_workout');
});

test('signature and read-only snapshot use recorded daily pressure while the current pair is missing', async () => {
  const f = signatureFixture(undefined, 'health-indices-v1');
  const ruleVersion = evaluateHealthIndices({ hrv: [], heart: [], sleep: [], workout: [] }, f.now()).ruleVersion;
  for (let hours = 1; hours <= 3; hours++) f.store.pressureHistory.record({ ruleVersion,
    pressure: { context: 'awake_sample', evidenceAt: f.now() - hours * 3600000, source: 'Watch', score: 45 } }, f.now());
  await detailUpload(f);
  assert.equal(f.data().signatureCandidate.pressure.score, null);
  assert.match(f.data().signatureDelivery.desiredTitle, /^🔵 状态正常/);
  const before = f.store.pressureHistory.view(f.now(), '24h').points.length;
  const snapshot = await (await f.store.fetch(new Request('https://store/snapshot'))).json();
  assert.equal(snapshot.healthIndices.title, f.data().signatureDelivery.desiredTitle);
  assert.equal(f.store.pressureHistory.view(f.now(), '24h').points.length, before, 'reads do not create observations');
});

test('signature refresh and restart display a retained score without recording it as current', async () => {
  const f = signatureFixture(undefined, 'health-indices-v1');
  await detailUpload(f);
  const indices = f.data().signatureCandidate, at = f.now() - 26 * 3600000;
  f.store.pressureHistory.record({ ruleVersion: indices.ruleVersion, pressure: {
    source: indices.pressure.source, evidenceAt: at, score: 45, context: 'awake_sample',
  } }, f.now());
  const count = f.store.storage.sql.exec('SELECT COUNT(*) AS n FROM pressure_observations').one().n;
  await f.store.fetch(new Request('https://store/signature/refresh', { method: 'POST' }));
  // The signature names the state only; the dashboard headline records that it is historical.
  assert.match(f.data().signatureDelivery.desiredTitle, /^🔵 状态正常 睡眠 - ｜/);
  assert.equal(f.data().signatureCandidate.headline.basis, 'retained');
  assert.equal(f.data().signatureCandidate.headline.evidenceAt, at);
  assert.equal(f.data().signatureCandidate.pressure.score, null);
  assert.equal(f.data().signatureCandidate.lastValidPressure.evidenceAt, at);
  const restarted = new HealthStore({ storage: f.storage }, f.store.env, undefined, f.now);
  const snapshot = await (await restarted.fetch(new Request('https://store/snapshot'))).json();
  assert.match(snapshot.healthIndices.title, /^🔵 状态正常 睡眠 - ｜/);
  assert.equal(snapshot.healthIndices.lastValidPressure.score, 45);
  assert.equal(f.store.storage.sql.exec('SELECT COUNT(*) AS n FROM pressure_observations').one().n, count);
});

test('live ingestion still records pressure when numeric signature publication is disabled', async t => {
  const f = fixture();
  const record = t.mock.method(f.store.pressureHistory, 'record');
  assert.equal((await detailUpload(f)).status, 200);
  assert.equal(record.mock.callCount(), 1);
  await detailUpload(f, 'backfill');
  assert.equal(record.mock.callCount(), 1, 'backfill must not fabricate historical pressure');
});

test('successful card delivery builds one current view for reconciliation and alarm planning', async t => {
  const f = fixture();
  await f.upload();
  const view = t.mock.method(f.store, 'view');
  f.advance(60000); await f.store.alarm();
  assert.equal(f.data().delivery.pending, false);
  assert.equal(view.mock.callCount(), 2, 'one send snapshot and one post-delivery view');
});

test('rejected daily upload exposes safe diagnostics and preserves accepted data until a successful retry', async () => {
  const f = fixture();
  await f.upload(1000);
  const before = f.data();
  const rejected = await f.upload(-1);
  assert.equal(rejected.status, 422);
  assert.deepEqual(await rejected.json(), { error: 'daily_aggregation_required', details: { reason: 'negative_steps', metric: 'step_count' } });
  const status = await (await f.store.fetch(new Request('https://store/status'))).json();
  assert.deepEqual(status.lastIngestError, { at: f.now(), stream: 'health', error: 'daily_aggregation_required', reason: 'negative_steps', metric: 'step_count' });
  assert.deepEqual(f.data().metrics, before.metrics);
  assert.deepEqual(f.data().delivery, before.delivery);
  assert.doesNotMatch(JSON.stringify(status.lastIngestError), /184|source|2026/);
  await detailUpload(f, 'backfill');
  assert.equal(f.data().lastIngestError.reason, 'negative_steps', 'other streams must not clear this failure');
  await f.store.fetch(new Request('https://store/ingest', { method: 'POST', body: JSON.stringify({
    stream: 'health', aggregation: 'days', summary: summarizeHealth({ data: { metrics: [] } }),
  }) }));
  assert.equal(f.data().lastIngestError.reason, 'negative_steps', 'empty daily uploads must not clear this failure');
  await f.upload(1100);
  assert.equal((await (await f.store.fetch(new Request('https://store/status'))).json()).lastIngestError, null);
});

test('worker rejection survives restart without advancing measurements or delivery, then clears on valid retry', async () => {
  const f = fixture();
  const env = { HAE_API_KEY: 'fixture-ingest-key', FEISHU_WEBHOOK_URL: 'https://open.larkoffice.com/open-apis/bot/v2/hook/test',
    FEISHU_SIGN_SECRET: 'test', HEALTH_STORE: { idFromName: () => 'personal', get: () => ({ fetch: r => f.store.fetch(r) }) } };
  const post = (date, key = env.HAE_API_KEY, min = 60) => handleRequest(new Request('https://demo.test/ingest/heart', {
    method: 'POST', headers: { 'X-API-Key': key, 'X-HAE-Aggregation': 'minutes', 'automation-aggregation': 'minutes' },
    body: JSON.stringify({ data: { metrics: [{ name: 'heart_rate', units: 'bpm', data: [{ date, Avg: 65, Min: min }] }] } }),
  }), env);
  assert.equal((await post('2026-09-24T01:00:00Z')).status, 200);
  const before = structuredClone(f.data()), alarm = f.nextAlarm(), counts = f.store.series.counts();
  f.advance(30000);
  assert.equal((await post('2026-09-24T01:01:09Z', 'invalid-key')).status, 401);
  assert.deepEqual(f.data(), before, 'unauthenticated requests cannot write diagnostics');
  assert.equal((await post('2026-09-24T01:01:09Z', env.HAE_API_KEY, 90)).status, 422);
  const restarted = new HealthStore({ storage: f.storage }, {}, undefined, f.now);
  const status = await (await restarted.fetch(new Request('https://store/status'))).json();
  assert.deepEqual(status.lastIngestError, { at: f.now(), stream: 'heart', aggregation: 'minutes',
    nativeAggregation: 'minutes', error: 'invalid_heart_window', stage: 'request_validation' });
  assert.deepEqual({ ...f.data(), lastIngestError: undefined }, { ...before, lastIngestError: undefined });
  assert.deepEqual(status.series, counts);
  assert.equal(f.nextAlarm(), alarm);
  assert.equal((await post('2026-09-24T01:01:00Z')).status, 200);
  assert.equal(f.data().lastIngestError, null);
  assert.equal(f.data().streams.heart.receivedAt, f.now());
});

test('minute heart uploads preserve second-offset timestamps and stay idempotent across restart', async () => {
  const f = fixture();
  const env = { HAE_API_KEY: 'fixture-ingest-key', FEISHU_WEBHOOK_URL: 'https://open.larkoffice.com/open-apis/bot/v2/hook/test',
    FEISHU_SIGN_SECRET: 'test', HEALTH_STORE: { idFromName: () => 'personal', get: () => ({ fetch: r => f.store.fetch(r) }) } };
  const points = ['2026-09-24T01:00:09Z', '2026-09-24T01:01:09Z'].map(date => ({ date, Avg: 65, Min: 60, Max: 70 }));
  const post = () => handleRequest(new Request('https://demo.test/ingest/heart', {
    method: 'POST', headers: { 'X-API-Key': env.HAE_API_KEY, 'X-HAE-Aggregation': 'minutes', 'automation-aggregation': 'minutes' },
    body: JSON.stringify({ data: { metrics: [{ name: 'heart_rate', units: 'bpm', data: points }] } }),
  }), env);
  const response = await post();
  assert.equal(response.status, 200);
  const accepted = await response.json();
  assert.equal(accepted.stats.inserted, 2);
  assert.deepEqual(accepted.dataRange, { startAt: Date.parse(points[0].date), endAt: Date.parse(points[1].date) + 60000 });
  const restarted = new HealthStore({ storage: f.storage }, {}, undefined, f.now);
  const rows = restarted.series.list('heart');
  assert.deepEqual(rows.map(r => r.start), points.map(p => Date.parse(p.date)));
  assert.ok(rows.every(r => r.end - r.start === 60000 && r.value === 65 && r.min === 60 && r.max === 70));
  assert.ok(rows.every(r => r.source === 'unknown'), 'iOS may omit the source; do not invent one');
  assert.equal((await (await post()).json()).stats.unchanged, 2);
});

test('burst updates wait five minutes, coalesce and send the newest content', async () => {
  const cards = [];
  const f = fixture(async (_, options) => { cards.push(JSON.parse(options.body).card); return Response.json({ code: 0 }); });
  await f.upload(); f.advance(60000); await f.store.alarm();
  f.advance(60000); await f.upload(2000);
  assert.equal(f.nextAlarm(), f.data().delivery.lastSentAt + 300000);
  f.advance(60000); await f.upload(3000); await f.store.alarm();
  assert.equal(cards.length, 1);
  f.advance(180000); await f.store.alarm();
  assert.equal(cards.length, 2);
  assert.match(JSON.stringify(cards[1]), /3000/);
});

test('failed delivery remains pending and retries without requiring phone re-upload', async (t) => {
  t.mock.method(console, 'error', () => {});
  let fail = true;
  const f = fixture(async () => Response.json({ code: fail ? 19021 : 0, msg: 'never expose this' }));
  await f.upload(); f.advance(60000); await f.store.alarm();
  assert.equal(f.data().delivery.pending, true);
  assert.equal(f.data().delivery.lastSentAt, null);
  assert.equal(f.data().delivery.error.reason, 'feishu_rejected');
  assert.doesNotMatch(JSON.stringify(f.data().delivery), /never expose/);
  fail = false; f.advance(300000); await f.store.alarm();
  assert.equal(f.data().delivery.pending, false);
  assert.equal(f.data().delivery.error, null);
});

test('upload during external delivery remains pending for the next card', async () => {
  let f;
  f = fixture(async () => { await f.upload(2000); return Response.json({ code: 0 }); });
  await f.upload(); f.advance(60000); await f.store.alarm();
  assert.equal(f.data().delivery.pending, true);
  assert.match(f.data().metrics[0].latest.value, /2000/);
  assert.equal(f.data().delivery.dueAt, f.data().delivery.lastSentAt + 300000);
});

test('storage failure cannot be reported as accepted', async () => {
  const f = fixture();
  f.storage.put = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(() => f.upload(), /storage unavailable/);
});

test('daily cleanup expires retained summaries without publishing an empty card', async () => {
  let sends = 0;
  const f = fixture(async () => { sends++; return Response.json({ code: 0 }); });
  await f.upload(); f.advance(60000); await f.store.alarm();
  f.advance(8 * 86400000); await f.store.alarm();
  assert.equal(f.data().metrics.length, 0);
  assert.equal(f.data().delivery.sentContent, null);
  assert.equal(sends, 1);
});

const detailPayload = { data: { metrics: [{ name: 'heart_rate_variability', units: 'ms', data: [
  { date: '2026-09-24T01:00:00Z', qty: 50, source: 'Watch' },
  { date: '2026-09-24T01:30:00Z', qty: 60, source: 'Watch' },
] }] } };
const detailUpload = (f, mode = 'live') => f.store.fetch(new Request('https://store/ingest', { method: 'POST', body: JSON.stringify({
  stream: 'hrv', aggregation: 'raw', mode, records: parseSeries(detailPayload, 'hrv'), summary: summarizeHealth(detailPayload),
}) }));
test('detail rows persist, silent backfill does not queue, analysis reports actual coverage', async () => {
  const f = fixture();
  assert.equal((await (await detailUpload(f, 'backfill')).json()).notification, 'backfill_silent');
  assert.equal(f.data().delivery.pending, false);
  await detailUpload(f, 'backfill');
  const status = await (await f.store.fetch(new Request('https://store/status'))).json();
  assert.equal(status.series.hrv, 2);
  const analysis = await (await f.store.fetch(new Request('https://store/analysis'))).json();
  assert.equal(analysis.daytime.status, 'baseline_building');
  assert.equal(analysis.daytime.baseline.days, 0);
  assert.equal((await (await detailUpload(f)).json()).notification, 'queued');
});
test('SQL and summary roll back together on storage failure', async () => {
  const f = fixture();
  f.storage.put = async () => { throw new Error('disk failed'); };
  await assert.rejects(() => detailUpload(f), /disk failed/);
  assert.equal(f.storage.sql.exec('SELECT COUNT(*) AS n FROM samples').one().n, 0);
});

test('sleep detail alone appears in the merged card and revisions are recomputed', async () => {
  const f = fixture();
  const payload = { data: { metrics: [{ name: 'sleep_analysis', units: 'hr', data: [
    { id: 'sleep', source: 'Watch', value: 'Core', startDate: '2026-09-23T16:00:00Z', endDate: '2026-09-24T00:00:00Z' },
  ] }] } };
  const upload = () => f.store.fetch(new Request('https://store/ingest', { method: 'POST', body: JSON.stringify({
    stream: 'sleep-segments', aggregation: 'raw', records: parseSeries(payload, 'sleep-segments'),
    summary: { samples: 1, skipped: 0, metrics: [], workouts: [], workoutReceived: null },
  }) }));
  await upload();
  let card = JSON.stringify(await (await f.store.fetch(new Request('https://store/card'))).json());
  assert.match(card, /主睡眠/); assert.match(card, /8 小时/);
  payload.data.metrics[0].data[0].endDate = '2026-09-23T23:00:00Z';
  await upload();
  card = JSON.stringify(await (await f.store.fetch(new Request('https://store/card'))).json());
  assert.match(card, /7 小时/); assert.doesNotMatch(card, /8 小时/);
  assert.equal(f.storage.sql.exec("SELECT COUNT(*) AS n FROM samples WHERE kind='sleep'").one().n, 1);
});

test('repeated uploads refresh receipt but preserve measurement and content-change times', async () => {
  const f = fixture();
  const first = await (await detailUpload(f)).json();
  assert.equal(first.stats.inserted, 2);
  const changedAt = f.now();
  f.advance(60000); await f.store.alarm();
  f.advance(60000);
  const second = await (await detailUpload(f)).json();
  assert.equal(second.stats.unchanged, 2);
  assert.equal(second.notification, 'unchanged');
  const status = await (await f.store.fetch(new Request('https://store/status'))).json();
  assert.equal(status.streams.hrv.lastContentChangedAt, changedAt);
  assert.equal(status.streams.hrv.receivedAt, f.now());
  assert.equal(status.dataTimes.heart_rate_variability.latestSampleAt, Date.parse('2026-09-24T01:30:00Z'));
});

test('measurement expiry wakes without upload and publishes historical label', async () => {
  const cards = [];
  const f = fixture(async (_, options) => { cards.push(JSON.parse(options.body).card); return Response.json({ code: 0 }); });
  await detailUpload(f); f.advance(60000); await f.store.alarm();
  assert.ok(f.nextAlarm() < Date.parse('2026-09-24T16:00:00Z'));
  f.advance(6 * 3600000); await f.store.alarm();
  assert.equal(cards.length, 2);
  assert.match(JSON.stringify(cards[1]), /测量已过期/);
  assert.ok(f.nextAlarm() > f.now());
});

test('silent backfill is not published by a later freshness alarm', async () => {
  let sends = 0;
  const f = fixture(async () => { sends++; return Response.json({ code: 0 }); });
  await detailUpload(f, 'backfill'); f.advance(7 * 3600000); await f.store.alarm();
  assert.equal(sends, 0);
});

const signatureEnv = { SIGNATURE_ENABLED: 'true', FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret', SIGNATURE_BASE_TOKEN: 'base', SIGNATURE_TABLE_ID: 'table', SIGNATURE_RECORD_ID: 'record' };
function signatureFixture(write = async () => Response.json({ code: 0, data: { record: { record_id: 'record' } } }), mode) {
  const writes = [];
  const f = fixture(async (url, options) => {
    if (url.endsWith('/internal')) return Response.json({ code: 0, tenant_access_token: 'token', expire: 7200 });
    if (options.method === 'PUT') { writes.push(JSON.parse(options.body).fields.title); return write(); }
    return Response.json({ code: 0 });
  }, { ...signatureEnv, ...(mode ? { SIGNATURE_MODE: mode } : {}) });
  return { ...f, writes };
}

function delayedPressureRecords(now) {
  const records = [], minute = 60000, day = 86400000;
  // Eight days: the current day plus the seven prior days a v6 RMSSD baseline needs.
  for (let d = 0; d <= 7; d++) {
    for (const hours of [5, 3, 1]) {
      const anchor = now - d * day - hours * 3600000;
      for (const i of [0, 5, 10]) records.push({ kind: 'hrv', method: 'RMSSD', aggregation: 'minutes',
        start: anchor - i * minute, end: anchor - i * minute + minute, value: 40, source: 'Watch' });
      for (let i = 0; i < 20; i++) records.push({ kind: 'heart', start: anchor - i * minute,
        end: anchor - i * minute + minute, value: 60, source: 'Watch' });
    }
  }
  records.push({ kind: 'hrv', method: 'RMSSD', aggregation: 'minutes', start: now - 5 * minute,
    end: now - 4 * minute, value: 40, source: 'Watch' });
  return records;
}

async function finishPressureReplay(f) {
  for (let i = 0; i < 10 && f.data()?.pressureReplay?.pending; i++) {
    f.advance(1000); await f.store.alarm();
  }
  assert.equal(f.data().pressureReplay.pending, false);
}

test('explicit rebuild recovers delayed qualified windows without making the sparse latest window fresh', async () => {
  const f = signatureFixture(undefined, 'health-indices-v1');
  f.store.series.put(delayedPressureRecords(f.now()), f.now());
  await f.upload();
  assert.equal(f.data().signatureCandidate.pressure.reason, 'insufficient_samples');
  await f.store.fetch(new Request('https://store/signature/refresh?rebuildPressure=1', { method: 'POST' }));
  assert.equal(f.data().pressureReplay?.pending, true);
  assert.equal(f.store.pressureHistory.view(f.now(), '24h').points.length, 0);
  await finishPressureReplay(f);
  const history = f.store.pressureHistory.view(f.now(), '24h');
  assert.ok(history.days.at(-1).count >= 3);
  assert.equal(history.days.at(-1).status, 'available');
  assert.ok(history.points.every(p => p.basis === 'received_records_replay'));
  const before = JSON.stringify(history.points);
  const snapshot = await (await f.store.fetch(new Request('https://store/snapshot'))).json();
  assert.equal(snapshot.healthIndices.pressure.score, null);
  assert.equal(snapshot.healthIndices.pressure.reason, 'insufficient_samples');
  assert.match(snapshot.healthIndices.title, /^🔵 状态正常/);
  assert.equal(JSON.stringify(f.store.pressureHistory.view(f.now(), '24h').points), before, 'read-only snapshots do not rebuild');
});

test('heart arriving after HRV queues affected windows and duplicate uploads do not restart replay', async () => {
  const f = signatureFixture(undefined, 'health-indices-v1'), records = delayedPressureRecords(f.now());
  f.store.series.put(records.filter(r => r.kind === 'hrv'), f.now());
  await f.upload();
  const heart = records.filter(r => r.kind === 'heart');
  const post = mode => f.store.fetch(new Request('https://store/ingest', { method: 'POST', body: JSON.stringify({
    stream: 'heart', aggregation: 'minutes', mode, records: heart,
    summary: { samples: heart.length, skipped: 0, metrics: [], workouts: [], workoutReceived: null },
  }) }));
  assert.equal((await post('live')).status, 200);
  assert.equal(f.data().pressureReplay?.pending, true);
  await finishPressureReplay(f);
  assert.equal(f.store.pressureHistory.view(f.now(), '24h').days.at(-1).status, 'available');
  const finished = f.data().pressureReplay;
  assert.equal((await post('live')).status, 200);
  assert.deepEqual(f.data().pressureReplay, finished);
  const quiet = signatureFixture(undefined, 'health-indices-v1');
  await quiet.store.fetch(new Request('https://store/ingest', { method: 'POST', body: JSON.stringify({
    stream: 'hrv', aggregation: 'minutes', mode: 'backfill', records,
    summary: { samples: records.length, skipped: 0, metrics: [], workouts: [], workoutReceived: null },
  }) }));
  assert.equal(quiet.data().pressureReplay, undefined);
});

test('pressure replay is bounded, resumes after restart and never counts duplicate or sleeping samples', async () => {
  const f = signatureFixture(undefined, 'health-indices-v1'), records = delayedPressureRecords(f.now());
  f.store.series.put(records, f.now());
  f.store.series.put([{ kind: 'sleep', start: f.now() - 6 * 3600000, end: f.now() - 4 * 3600000,
    stage: 'core', source: 'Watch' }], f.now());
  await f.upload();
  await f.store.fetch(new Request('https://store/signature/refresh?rebuildPressure=1', { method: 'POST' }));
  f.advance(1000); await f.store.alarm();
  assert.ok((f.data().pressureReplay?.processed ?? Infinity) <= 24);
  assert.equal(f.data().pressureReplay.pending, true);
  const restarted = new HealthStore({ storage: f.storage }, f.store.env, f.store.send, f.now);
  f.store = restarted;
  await finishPressureReplay(f);
  const points = f.store.pressureHistory.view(f.now(), '24h').points;
  assert.ok(points.every(p => p.t < f.now() - 6 * 3600000 || p.t > f.now() - 4 * 3600000));
  assert.equal(new Set(points.map(p => p.t)).size, points.length);
  assert.ok(f.data().pressureReplay.reasons.sleeping > 0);
});

test('replay evaluates exactly its anchor when an RMSSD measurement exists in the following minute', async () => {
  const f = signatureFixture(undefined, 'health-indices-v1'), anchor = f.now() - 60000;
  const rows = delayedPressureRecords(f.now());
  for (const offset of [0, 5, 10]) rows.push({ kind: 'hrv', method: 'RMSSD', aggregation: 'minutes',
    start: anchor - offset * 60000, end: anchor - offset * 60000 + 60000, value: 40, source: 'Watch' });
  rows.push({ kind: 'hrv', method: 'RMSSD', aggregation: 'minutes', start: f.now(),
    end: f.now() + 60000, value: 40, source: 'Watch' });
  for (let i = 0; i < 20; i++) rows.push({ kind: 'heart', start: anchor - i * 60000,
    end: anchor - i * 60000 + 60000, value: 60, source: 'Watch' });
  f.store.series.put(rows, f.now());
  await f.upload();
  const state = f.data();
  f.store.queuePressureReplay(state, anchor, anchor, f.now());
  await f.storage.put('state', state);
  f.advance(1000); await f.store.replayPressure();
  assert.equal(f.data().pressureReplay.processed, 1);
  assert.ok(f.store.pressureHistory.view(f.now(), '24h').points.some(p => p.t === anchor));
  assert.ok(!f.store.pressureHistory.view(f.now(), '24h').points.some(p => p.t > anchor && p.basis === 'received_records_replay'));
});

test('late workout preserves replayed pressure during exercise and the following hour', async () => {
  const f = signatureFixture(undefined, 'health-indices-v1');
  f.store.series.put(delayedPressureRecords(f.now()), f.now());
  await f.upload();
  await f.store.fetch(new Request('https://store/signature/refresh?rebuildPressure=1', { method: 'POST' }));
  await finishPressureReplay(f);
  const workout = { kind: 'workout', id: 'late', name: 'Running',
    start: f.now() - 2 * 3600000, end: f.now() - 105 * 60000, source: 'Watch' };
  const affected = () => f.store.pressureHistory.view(f.now(), '24h').points.filter(p =>
    p.t >= workout.start && p.t <= workout.end + 3600000);
  assert.ok(affected().length > 0);
  const before = affected().map(p => ({ t: p.t, score: p.score }));
  await f.store.fetch(new Request('https://store/ingest', { method: 'POST', body: JSON.stringify({
    stream: 'workouts', aggregation: 'unknown', mode: 'live', records: [workout],
    summary: { samples: 1, skipped: 0, metrics: [], workouts: [], workoutReceived: null },
  }) }));
  await finishPressureReplay(f);
  assert.deepEqual(affected().map(p => ({ t: p.t, score: p.score })), before);
});
test('HAE upload persists before asynchronous signature; repeated data and restart do not republish', async () => {
  const f = signatureFixture();
  const result = await (await detailUpload(f)).json();
  assert.equal(result.signature, 'queued'); assert.equal(f.writes.length, 0);
  f.advance(60000); await f.store.alarm();
  assert.equal(f.writes.length, 1);
  assert.equal(f.data().signatureDelivery.pending, false);
  const changedAt = f.data().signatureDelivery.changedAt;
  f.advance(3600000); await detailUpload(f); await f.store.alarm();
  assert.equal(f.writes.length, 1);
  assert.equal(f.data().signatureDelivery.changedAt, changedAt);
  const restarted = new HealthStore({ storage: f.storage }, signatureEnv, () => { throw new Error('no publish'); }, f.now);
  const status = await (await restarted.fetch(new Request('https://store/status'))).json();
  assert.equal(status.signature.lastSentAt, changedAt + 60000);
});
test('signature retry survives without another phone upload; ingest and card remain independent', async () => {
  let fail = true;
  const f = signatureFixture(async () => Response.json({ code: fail ? 91403 : 0, data: { record: { record_id: 'record' } }, msg: 'secret' }));
  assert.equal((await detailUpload(f)).status, 200);
  f.advance(60000); await f.store.alarm();
  assert.equal(f.data().signatureDelivery.pending, true);
  assert.equal(f.data().signatureDelivery.error.code, 91403);
  assert.equal(f.data().delivery.pending, false);
  fail = false; f.advance(300000); await f.store.alarm();
  assert.equal(f.writes.length, 2); assert.equal(f.data().signatureDelivery.pending, false);
});
test('new content arriving during signature write remains pending and publishes latest title', async () => {
  let f, first = true;
  f = signatureFixture(async () => {
    if (first) { first = false; f.advance(60000); await f.upload(3000); }
    return Response.json({ code: 0, data: { record: { record_id: 'record' } } });
  });
  await detailUpload(f); f.advance(60000); await f.store.alarm();
  assert.equal(f.data().signatureDelivery.pending, true);
  f.advance(30 * 60000); await f.store.alarm();
  assert.equal(f.writes.length, 2);
  assert.notEqual(f.writes[0], f.writes[1]);
  assert.equal(f.data().signatureDelivery.pending, false);
});
test('24h without content change publishes stale copy; silent backfill never starts a signature', async () => {
  const f = signatureFixture();
  await detailUpload(f, 'backfill'); f.advance(60000); await f.store.alarm();
  assert.equal(f.writes.length, 0);
  await detailUpload(f); f.advance(60000); await f.store.alarm();
  assert.equal(f.writes.length, 1);
  f.advance(24 * 3600000); await f.store.alarm();
  assert.equal(f.writes.length, 2); assert.match(f.writes[1], /待更新/);
  assert.ok(f.nextAlarm() > f.now());
});

function physiologyUpload(f, mode = 'live') {
  const hour = 3600000, day = 24 * hour, records = [];
  for (let d = 0; d <= 18; d++) {
    for (const offset of [1, 2]) {
      const start = f.now() - d * day - offset * hour;
      records.push({ kind: 'hrv', start, end: start, method: 'SDNN', source: 'Watch', value: 60 + (d % 3 - 1) * 3, key: `hrv:${start}` });
    }
    const start = f.now() - 10 * hour - d * day;
    records.push({ kind: 'daily', metric: 'resting_heart_rate', start, end: start, source: 'Watch', value: 55 + d % 3 - 1, key: `rhr:${start}` });
  }
  return f.store.fetch(new Request('https://store/ingest', { method: 'POST', body: JSON.stringify({
    stream: 'hrv', aggregation: 'raw', mode, records,
    summary: { samples: records.length, skipped: 0, metrics: [], workouts: [], workoutReceived: null },
  }) }));
}
test('opt-in physiology drives the real publisher and read endpoints without mutating on GET', async () => {
  const f = signatureFixture(undefined, 'physiology-v2');
  await physiologyUpload(f);
  const stored = JSON.stringify(f.data());
  const snapshot = await (await f.store.fetch(new Request('https://store/snapshot'))).json();
  assert.equal(snapshot.physiology.state, 'balanced');
  assert.equal(JSON.stringify(f.data()), stored);
  f.advance(60000); await f.store.alarm();
  assert.match(f.writes[0], /🔵 状态正常/);
  assert.doesNotMatch(f.writes[0], /已同步|待更新/);
  const status = await (await f.store.fetch(new Request('https://store/status'))).json();
  assert.equal(status.signature.mode, 'physiology-v2');
  f.advance(7 * 3600000); await f.store.alarm();
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0], /🔵 状态正常/);
  assert.ok(f.nextAlarm() > f.now());
});
test('physiology backfill stays silent, including after restart and alarm', async () => {
  const f = signatureFixture(undefined, 'physiology-v2');
  await physiologyUpload(f, 'backfill');
  f.advance(60000); await f.store.alarm();
  assert.equal(f.writes.length, 0);
  assert.equal(f.data().physiologyDecision, undefined);
});
test('switching back to sync status reuses the actual receipt time and remains publishable', async () => {
  const f = signatureFixture(undefined, 'physiology-v2');
  await physiologyUpload(f);
  f.advance(60000); await f.store.alarm();
  f.store.env.SIGNATURE_MODE = 'sync-status-v1';
  f.advance(3600000); await f.store.alarm();
  f.advance(60000); await f.store.alarm();
  assert.match(f.writes.at(-1), /健康数据已同步 · 09-24 10:00/);
});
test('a new expiry during an in-flight physiology write is not lost by the older success', async () => {
  let f, first = true;
  f = signatureFixture(async () => {
    if (first) { first = false; f.advance(7 * 3600000); await f.upload(3000); }
    return Response.json({ code: 0, data: { record: { record_id: 'record' } } });
  }, 'physiology-v2');
  await physiologyUpload(f); f.advance(60000); await f.store.alarm();
  assert.equal(f.data().signatureDelivery.pending, false);
  assert.equal(f.data().signatureDelivery.dueAt, null);
  await f.store.alarm();
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0], /🔵 状态正常/);
  assert.equal(f.data().signatureDelivery.pending, false);
});

test('refresh cannot promote an old observation into a new state; it migrates legacy copy to neutral dated facts', async () => {
  const f = signatureFixture();
  await physiologyUpload(f); f.advance(60000); await f.store.alarm();
  assert.match(f.writes[0], /已同步/);
  f.store.env.SIGNATURE_MODE = 'physiology-v2';
  f.advance(7 * 3600000);
  const response = await f.store.fetch(new Request('https://store/signature/refresh', { method: 'POST' }));
  const result = await response.json();
  assert.equal(result.decision.state, 'stale');
  assert.equal(result.signature.pending, true);
  f.advance(60000); await f.store.alarm();
  assert.match(f.writes.at(-1), /^\S+ 近常态｜.+\nHRV 57 · RHR 54｜09\/24 09:00$/);
  assert.equal(f.data().signatureDelivery.publishedDecision.state, 'neutral');
  const count = f.writes.length;
  f.advance(3600000); await f.store.alarm();
  assert.equal(f.writes.length, count);
});
test('late sleep context withdraws an invalidated published conclusion through the real alarm', async () => {
  const f = signatureFixture(undefined, 'physiology-v2');
  await physiologyUpload(f); f.advance(60000); await f.store.alarm();
  const start = f.now() - 4 * 3600000, end = f.now() - 1800000;
  await f.store.fetch(new Request('https://store/ingest', { method: 'POST', body: JSON.stringify({
    stream: 'sleep-segments', aggregation: 'raw', records: [{ kind: 'sleep', start, end, stage: 'core', source: 'Watch', key: 'late-sleep' }],
    summary: { samples: 1, skipped: 0, metrics: [], workouts: [], workoutReceived: null },
  }) }));
  await f.store.alarm();
  assert.match(f.writes.at(-1), /^🍃 按自己的节奏走\nHRV \d+ · RHR \d+｜/);
  assert.doesNotMatch(f.writes.at(-1), /健康记录|状态正常|状态优秀|注意压力指数|压力指数过载/);
});

test('legacy activation timestamp never overrides current workout context', async () => {
  const f = signatureFixture(undefined, 'physiology-v2');
  await physiologyUpload(f, 'backfill');
  const state = f.data(); state.signatureActivationAt = f.now() - 3600000;
  await f.storage.put('state', state);
  const start = f.now() - 1800000, end = f.now() - 600000;
  f.store.series.put([{ kind: 'workout', start, end, key: 'recent-workout', id: 'recent-workout', name: 'Run', source: 'Watch', details: [] }], f.now());
  await f.store.fetch(new Request('https://store/signature/refresh', { method: 'POST' }));
  assert.equal(f.data().physiologyDecision.state, 'post_workout');
  assert.equal(f.data().signatureCandidate.state, 'neutral');
});
test('HRV upload diagnostics separate receipt, measurement, and duplicate counts without resending on duplicate', async () => {
  const f = signatureFixture(undefined, 'physiology-v2');
  await physiologyUpload(f); f.advance(60000); await f.store.alarm();
  const before = await f.store.contentFingerprint(f.store.view(f.data(), f.now()), f.now());
  f.advance(60000); await physiologyUpload(f, 'backfill');
  const view = f.store.view(f.data(), f.now());
  assert.equal(view.hrvSync.receivedAt, f.now());
  assert.ok(view.hrvSync.latestSampleAt < view.hrvSync.receivedAt);
  // Receipt metadata alone must not change the card content fingerprint.
  const modified = structuredClone(view); modified.hrvSync.receivedAt += 60000; modified.hrvSync.stats.unchanged += 1;
  assert.equal(await f.store.contentFingerprint(view, f.now()), await f.store.contentFingerprint(modified, f.now()));
});

test('upload receipt reports batch times, including duplicates, older backfill and an empty batch', async () => {
  const f = fixture();
  const first = await (await detailUpload(f)).json();
  const range = { startAt: Date.parse('2026-09-24T01:00:00Z'), endAt: Date.parse('2026-09-24T01:30:00Z') };
  assert.deepEqual(first.dataRange, range);
  assert.equal(first.receivedAt, f.now());
  assert.equal(first.mode, 'live');
  f.advance(3600000);
  const duplicate = await (await detailUpload(f)).json();
  assert.deepEqual(duplicate.dataRange, range);
  assert.equal(duplicate.stats.unchanged, 2);
  assert.equal(duplicate.receivedAt, f.now());
  const older = parseSeries({ data: { metrics: [{ name: 'heart_rate_variability', units: 'ms',
    data: [{ date: '2026-09-23T01:00:00Z', qty: 50, source: 'Watch' }] }] } }, 'hrv');
  const post = records => f.store.fetch(new Request('https://store/ingest', { method: 'POST', body: JSON.stringify({
    stream: 'hrv', aggregation: 'raw', mode: 'backfill', records,
    summary: { samples: records.length, skipped: 0, metrics: [], workouts: [], workoutReceived: null },
  }) }));
  await post(older);
  const status = await (await f.store.fetch(new Request('https://store/status'))).json();
  assert.deepEqual(status.streams.hrv.dataRange, { startAt: older[0].start, endAt: older[0].end });
  assert.equal(status.streams.hrv.mode, 'backfill');
  assert.equal(status.dataTimes.heart_rate_variability.latestSampleAt, range.endAt);
  assert.equal((await (await post([])).json()).dataRange, null);
});

test('a new eligible evening HRV batch automatically replaces neutral copy with a four-level signature', async () => {
  const f = signatureFixture(undefined, 'physiology-v2');
  await f.upload(); f.advance(60000); await f.store.alarm();
  assert.equal(f.writes.length, 0); // No HRV: do not overwrite the signature with a bare placeholder.
  f.advance(30 * 60000); await physiologyUpload(f); f.advance(60000); await f.store.alarm();
  assert.match(f.writes.at(-1), /^🔵 状态正常/);
  assert.equal(f.data().signatureDelivery.publishedDecision.state, 'balanced');
});
test('late sleep during an in-flight publication schedules correction instead of accepting a now-invalid state', async () => {
  let f, once = true;
  f = signatureFixture(async () => {
    if (once) {
      once = false;
      const start = f.now() - 4 * 3600000, end = f.now() - 1800000;
      await f.store.fetch(new Request('https://store/ingest', { method: 'POST', body: JSON.stringify({
        stream: 'sleep-segments', aggregation: 'raw', records: [{ kind: 'sleep', start, end, stage: 'core', source: 'Watch', key: 'during-write-sleep' }],
        summary: { samples: 1, skipped: 0, metrics: [], workouts: [], workoutReceived: null },
      }) }));
    }
    return Response.json({ code: 0, data: { record: { record_id: 'record' } } });
  }, 'physiology-v2');
  await physiologyUpload(f); f.advance(60000); await f.store.alarm();
  assert.equal(f.data().signatureDelivery.pending, true);
  assert.equal(f.data().signatureDelivery.dueAt, f.now());
  await f.store.alarm();
  assert.match(f.writes.at(-1), /^🍃 按自己的节奏走\nHRV \d+ · RHR \d+｜/);
  assert.doesNotMatch(f.writes.at(-1), /健康记录|状态正常|状态优秀|注意压力指数|压力指数过载/);
});


test('live HRV uploads update descriptive signatures automatically without the refresh endpoint', async () => {
  const f = signatureFixture(undefined, 'physiology-v2');
  const hour = 3600000, day = 24 * hour;
  const point = (start, value) => ({ kind: 'hrv', start, end: start, value, method: 'SDNN', source: 'Watch', key: `hrv:${start}` });
  const post = (records, mode = 'live') => f.store.fetch(new Request('https://store/ingest', { method: 'POST', body: JSON.stringify({
    stream: 'hrv', aggregation: 'raw', mode, records,
    summary: { samples: records.length, skipped: 0, metrics: [], workouts: [], workoutReceived: null },
  }) }));
  await post(Array.from({ length: 5 }, (_, i) => point(f.now() - (i + 1) * day - hour, 60)), 'backfill');
  assert.equal(f.writes.length, 0);
  await post([point(f.now() - hour, 60)]);
  f.advance(60000); await f.store.alarm();
  assert.match(f.writes[0], /^\S+ 近常态｜.+\nHRV 60/);
  assert.equal(f.data().signatureDelivery.publishedDecision.presentation, 'hrv_comparison');
  f.advance(31 * 60000);
  const newer = point(f.now(), 80);
  await post([newer]); f.advance(60000); await f.store.alarm();
  assert.match(f.writes.at(-1), /^\S+ 偏高｜.+\nHRV 80/);
  assert.equal(f.writes.length, 2);
  await post([newer]); f.advance(60000); await f.store.alarm();
  assert.equal(f.writes.length, 2);
  const snapshot = await (await f.store.fetch(new Request('https://store/snapshot'))).json();
  assert.equal(snapshot.hrvObservation.position, 'above');
  assert.equal(snapshot.hrvObservation.measuredAt, newer.start);
  assert.equal(f.data().signatureDelivery.pending, false);
  // A delayed heart minute from the HRV window can enrich that same dated state.
  const heart = { kind: 'heart', start: newer.start - 60000, end: newer.start, value: 63,
    source: 'Watch', key: `heart:${newer.start - 60000}` };
  const heartPost = () => f.store.fetch(new Request('https://store/ingest', { method: 'POST', body: JSON.stringify({
    stream: 'heart', aggregation: 'minutes', records: [heart],
    summary: { samples: 1, skipped: 0, metrics: [], workouts: [], workoutReceived: null },
  }) }));
  await heartPost(); f.advance(5 * 60000); await f.store.alarm();
  assert.equal(f.writes.length, 3);
  assert.match(f.writes.at(-1), /^\S+ 偏高｜.+\nHRV 80↑ · HR 63｜09\/24 10:32$/);
  assert.equal(f.data().signatureDelivery.publishedDecision.measuredAt, newer.start);
  await heartPost(); f.advance(5 * 60000); await f.store.alarm();
  assert.equal(f.writes.length, 3);
  f.advance(30 * 60000);
  heart.start = f.now() - 60000; heart.end = f.now(); heart.value = 69; heart.key = `heart:${heart.start}`;
  await heartPost(); f.advance(60000); await f.store.alarm();
  assert.equal(f.writes.length, 4, 'ordinary heart upload updates signature without another HRV or refresh');
  const published = f.data().signatureDelivery.publishedDecision;
  assert.equal(published.measuredAt, newer.start);
  assert.equal(published.asOfAt, heart.start);
  assert.match(published.title, /HRV 80↑ · HR 69｜/);
  await heartPost(); f.advance(5 * 60000); await f.store.alarm();
  assert.equal(f.writes.length, 4, 'duplicate uploads cannot advance the overview time');
});


test('a concurrent descriptive update with no expiry respects the two-minute write interval', async () => {
  let f, first = true;
  const point = (start, value) => ({ kind: 'hrv', start, end: start, value, method: 'SDNN', source: 'Watch', key: `hrv:${start}` });
  const post = records => f.store.fetch(new Request('https://store/ingest', { method: 'POST', body: JSON.stringify({
    stream: 'hrv', aggregation: 'raw', records,
    summary: { samples: records.length, skipped: 0, metrics: [], workouts: [], workoutReceived: null },
  }) }));
  f = signatureFixture(async () => {
    if (first) { first = false; await post([point(f.now(), 80)]); }
    return Response.json({ code: 0, data: { record: { record_id: 'record' } } });
  }, 'physiology-v2');
  await post(Array.from({ length: 6 }, (_, i) => point(f.now() - i * 86400000 - 3600000, 60)));
  f.advance(60000); await f.store.alarm();
  assert.equal(f.data().signatureDelivery.pending, true);
  assert.equal(f.data().signatureDelivery.dueAt, f.now() + 2 * 60000);
  f.advance(2 * 60000); await f.store.alarm();
  assert.match(f.writes.at(-1), /^\S+ 偏高｜.+\nHRV 80/);
  assert.equal(f.data().signatureDelivery.pending, false);
});

test('numeric signature records candidate and successful publication latency without duplicate receipts changing the origin', async () => {
  const f = signatureFixture(undefined, 'health-indices-v1'), receivedAt = f.now();
  const evaluate = f.store.evaluateIndices.bind(f.store);
  f.store.evaluateIndices = (...args) => { f.advance(7); return evaluate(...args); };
  f.store.signaturePublisher.publish = async () => { f.advance(9); return { ok: true }; };
  await detailUpload(f);
  const candidate = { trigger: 'ingest', receivedAt, builtAt: receivedAt + 7, buildMs: 7 };
  assert.deepEqual(f.data().signatureDelivery.candidateTiming, candidate);
  assert.equal(f.data().signatureDelivery.dueAt, receivedAt + 30000);
  f.store.evaluateIndices = evaluate;
  f.advance(10000); await detailUpload(f);
  assert.deepEqual(f.data().signatureDelivery.candidateTiming, candidate);
  f.advance(receivedAt + 30000 - f.now()); await f.store.alarm();
  const status = await (await f.store.fetch(new Request('https://store/status'))).json();
  const timing = status.signature.publicationTiming;
  assert.equal(timing.ok, true);
  assert.equal(timing.trigger, 'ingest');
  assert.equal(timing.receivedAt, receivedAt);
  assert.equal(timing.candidateBuiltAt, candidate.builtAt);
  assert.equal(timing.candidateBuildMs, 7);
  assert.equal(timing.startedAt, receivedAt + 30000);
  assert.equal(timing.finishedAt, timing.startedAt + 9);
  assert.equal(timing.queueMs, 29993);
  assert.equal(timing.writeMs, 9);
  assert.equal(timing.receiptToFinishedMs, 30009);
  assert.equal(status.signature.pending, false);
  assert.equal(status.signature.lastSentAt, timing.finishedAt);
  assert.doesNotMatch(JSON.stringify(timing), /title|Watch|HRV|source/);
  const restarted = new HealthStore({ storage: f.storage }, { ...signatureEnv, SIGNATURE_MODE: 'health-indices-v1' }, undefined, f.now);
  const afterRestart = await (await restarted.fetch(new Request('https://store/status'))).json();
  assert.deepEqual(afterRestart.signature.publicationTiming, timing);
  assert.deepEqual(afterRestart.signature.policy, { coalesceMs: 30000, minWriteIntervalMs: 120000 });
});

test('manual refresh does not claim a new receipt when reporting signature latency', async () => {
  const f = signatureFixture(undefined, 'health-indices-v1');
  f.store.signaturePublisher.publish = async () => ({ ok: true });
  await detailUpload(f, 'backfill');
  await f.store.fetch(new Request('https://store/signature/refresh', { method: 'POST' }));
  assert.equal(f.data().signatureDelivery.candidateTiming.trigger, 'refresh');
  f.advance(30000); await f.store.alarm();
  const timing = f.data().signatureDelivery.publicationTiming;
  assert.equal(timing.ok, true);
  assert.equal(timing.receivedAt, null);
  assert.equal(timing.receiptToFinishedMs, null);
});

test('publication timing stays attached to the sent candidate when a newer upload arrives during the write', async () => {
  const f = signatureFixture(undefined, 'health-indices-v1'), receivedAt = f.now();
  f.store.signaturePublisher.publish = async () => {
    f.advance(1000);
    const records = [{ kind: 'heart', start: f.now() - 60000, end: f.now(), source: 'Watch', value: 80, min: 78, max: 82 }];
    await f.store.fetch(new Request('https://store/ingest', { method: 'POST', body: JSON.stringify({
      stream: 'heart', aggregation: 'minutes', records,
      summary: { samples: 1, skipped: 0, metrics: [], workouts: [], workoutReceived: null },
    }) }));
    return { ok: true };
  };
  await detailUpload(f); f.advance(30000); await f.store.alarm();
  const signature = f.data().signatureDelivery;
  assert.equal(signature.publicationTiming.receivedAt, receivedAt);
  assert.equal(signature.publicationTiming.writeMs, 1000);
  assert.equal(signature.candidateTiming.receivedAt, receivedAt + 31000);
  assert.equal(signature.pending, true);
  assert.equal(signature.dueAt, signature.lastSentAt + 120000);
});

test('failed publication records attempt duration while retaining the five-minute retry backoff', async () => {
  const f = signatureFixture(undefined, 'health-indices-v1'), receivedAt = f.now();
  f.store.signaturePublisher.publish = async () => { f.advance(50); return { ok: false, error: { reason: 'network_error' } }; };
  await detailUpload(f); f.advance(30000); await f.store.alarm();
  const signature = f.data().signatureDelivery;
  assert.equal(signature.publicationTiming.ok, false);
  assert.equal(signature.publicationTiming.writeMs, 50);
  assert.equal(signature.publicationTiming.receiptToFinishedMs, 30050);
  assert.equal(signature.dueAt, receivedAt + 30050 + 300000);
  assert.equal(signature.lastSentAt, null);
});

test('a thirty-minute automation with new data queues the group card for one minute later', async () => {
  let sends = 0;
  const f = fixture(async () => { sends++; return Response.json({ code: 0 }); });
  await f.upload(); f.advance(60000); await f.store.alarm();
  f.advance(29 * 60000);
  const next = await (await f.upload(2000)).json();
  assert.equal(next.nextNotificationAt, f.now() + 60000);
  f.advance(60000); await f.store.alarm();
  assert.equal(sends, 2);
  const duplicate = await (await f.upload(2000)).json();
  assert.equal(duplicate.notification, 'unchanged');
  await f.store.alarm();
  assert.equal(sends, 2);
});

test('a newer live HRV replaces an older sleep sample even when uploads are out of order', async () => {
  const f = signatureFixture(undefined, 'physiology-v2');
  const h = 3600000;
  const point = (start, value) => ({ kind: 'hrv', start, end: start, value, method: 'SDNN', source: 'Watch', key: `hrv:${start}` });
  const post = (stream, records) => f.store.fetch(new Request('https://store/ingest', { method: 'POST', body: JSON.stringify({
    stream, aggregation: 'raw', records,
    summary: { samples: records.length, skipped: 0, metrics: [], workouts: [], workoutReceived: null },
  }) }));
  const sleeping = point(f.now() - 2 * h, 55);
  await post('sleep-segments', [{ kind: 'sleep', start: f.now() - 3 * h, end: f.now() - h,
    stage: 'core', source: 'Watch', key: 'sleep-context' }]);
  await post('hrv', [sleeping]); f.advance(60000); await f.store.alarm();
  assert.equal(f.data().signatureDelivery.publishedDecision.sampleContext, 'sleep');
  assert.match(f.writes.at(-1), /HRV 55｜/);
  assert.doesNotMatch(f.writes.at(-1), /睡眠|采样/);
  f.advance(31 * 60000);
  const latest = point(f.now(), 88);
  await post('hrv', [latest, sleeping]); f.advance(60000); await f.store.alarm();
  assert.match(f.writes.at(-1), /HRV 88｜/);
  assert.equal(f.data().signatureDelivery.publishedDecision.measuredAt, latest.start);
  assert.equal(f.data().signatureDelivery.publishedDecision.sampleContext, 'unclassified');
  const writes = f.writes.length;
  await post('hrv', [sleeping]); f.advance(5 * 60000); await f.store.alarm();
  assert.equal(f.writes.length, writes, 'late duplicate cannot roll the display back to the sleep sample');
});

test('numeric signature mode publishes via durable alarm and repeated uploads do not republish', async () => {
  const f = signatureFixture(undefined, 'health-indices-v1');
  const response = await (await detailUpload(f)).json();
  assert.equal(response.signature, 'queued');
  assert.equal(f.writes.length, 0);
  f.advance(60000); await f.store.alarm();
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0], /HRV/);
  assert.match(f.writes[0], /压力暂无/);
  assert.match(f.writes[0], /睡眠 - /);
  assert.doesNotMatch(f.writes[0], /待评估|待更新|—/);
  assert.equal(f.data().signatureDelivery.publishedDecision.mode, 'health-indices-v1');
  await detailUpload(f); f.advance(300000); await f.store.alarm();
  assert.equal(f.writes.length, 1);
  const snapshot = await (await f.store.fetch(new Request('https://store/snapshot'))).json();
  assert.equal(snapshot.publication.mode, 'health-indices-v1');
  assert.equal(snapshot.publication.sentTitle, snapshot.healthIndices.title);
  const heartPayload = { data: { metrics: [{ name: 'heart_rate', units: 'count/min', data: [
    { date: '2026-09-24T02:00:00Z', Avg: 72, Min: 70, Max: 74, source: 'Watch' },
  ] }] } };
  const uploadHeart = () => f.store.fetch(new Request('https://store/ingest', { method: 'POST', body: JSON.stringify({
    stream: 'heart', aggregation: 'minutes', records: parseSeries(heartPayload, 'heart', { aggregation: 'minutes' }),
    summary: summarizeHealth(heartPayload),
  }) }));
  assert.equal((await uploadHeart()).status,200);
  f.advance(60000); await f.store.alarm();
  assert.equal(f.writes.length,2);
  assert.match(f.writes[1],/心率72｜09\/24 10:00｜详情 ↗$/);
  assert.equal(f.data().signatureDelivery.publishedDecision.scoreAt,snapshot.healthIndices.scoreAt);
  await uploadHeart(); f.advance(300000); await f.store.alarm();
  assert.equal(f.writes.length,2,'duplicate upload must not update the displayed time or republish');
});


test('sleep and HRV live uploads each refresh the numeric signature without waiting for another stream', async () => {
 const f=signatureFixture(undefined,'health-indices-v1');
 await detailUpload(f); f.advance(60000); await f.store.alarm();
 const first=f.writes[0];
 const H=3600000,D=24*H;
 const rows=Array.from({length:4},(_,i)=>{
  const end=Date.parse('2026-09-24T06:00:00+08:00')-i*D;
  return {source:'Watch',value:'Core',startDate:new Date(end-8*H).toISOString(),endDate:new Date(end).toISOString()};
 });
 const sleep={data:{metrics:[{name:'sleep_analysis',units:'hr',data:rows}]}};
 const uploadSleep=()=>f.store.fetch(new Request('https://store/ingest',{method:'POST',body:JSON.stringify({
  stream:'sleep-segments',aggregation:'raw',records:parseSeries(sleep,'sleep-segments'),summary:{samples:rows.length,skipped:0,metrics:[],workouts:[],workoutReceived:null},
 })}));
 const response=await (await uploadSleep()).json();assert.equal(response.signature,'queued');
 f.advance(300000);await f.store.alarm();
 assert.equal(f.writes.length,2);assert.match(f.writes[1],/睡眠100/);assert.notEqual(f.writes[1],first);
 await uploadSleep(); f.advance(300000);await f.store.alarm();assert.equal(f.writes.length,2);
 const hrv={data:{metrics:[{name:'heart_rate_variability',units:'ms',data:[
  {date:new Date(f.now()-60000).toISOString(),qty:80,source:'Watch'},
 ]}]}};
 const update=await f.store.fetch(new Request('https://store/ingest',{method:'POST',body:JSON.stringify({
  stream:'hrv',aggregation:'raw',records:parseSeries(hrv,'hrv'),summary:summarizeHealth(hrv),
 })}));
 assert.equal((await update.json()).signature,'queued');
 f.advance(60000);await f.store.alarm();assert.equal(f.writes.length,3);
 assert.match(f.writes[2],/睡眠100｜HRV80/);
});

const cacheEnv = { FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret', SIGNATURE_BASE_TOKEN: 'base',
  DASHBOARD_CACHE_TABLE_ID: 'table', DASHBOARD_CACHE_RECORD_ID: 'record' };

test('cold early alarms reuse the dashboard until its actual time boundary', async t => {
  const f = fixture(undefined, { ...cacheEnv, SIGNATURE_ENABLED: 'true', SIGNATURE_MODE: 'health-indices-v1' });
  const records = Array.from({ length: 5000 }, (_, i) => ({ key: `hr-${i}`, kind: 'heart',
    start: f.now() - (5000 - i) * 60000, end: f.now() - (4999 - i) * 60000,
    source: 'Watch', value: 65, unit: 'bpm' }));
  f.store.series.put(records, f.now());
  f.store.signaturePublisher.publish = async () => ({ ok: true });
  f.store.dashboardCachePublisher.publish = async () => ({ ok: true });
  await detailUpload(f);
  f.advance(60000); await f.store.alarm();
  const exec = f.storage.sql.exec.bind(f.storage.sql);
  let returned = 0;
  f.storage.sql.exec = (query, ...args) => {
    const cursor = exec(query, ...args);
    if (query.startsWith('SELECT payload FROM samples')) returned += cursor.toArray().length;
    return cursor;
  };
  const restarted = new HealthStore({ storage: f.storage }, f.store.env, undefined, f.now);
  restarted.signaturePublisher.publish = async () => ({ ok: true });
  restarted.dashboardCachePublisher.publish = async () => ({ ok: true });
  f.advance(600000); await restarted.alarm();
  t.diagnostic(`Cold early alarm: ${returned} historical sample rows returned by SQL`);
  assert.equal(returned, 0, 'an early alarm must not load unchanged history after eviction');
  assert.equal(f.nextAlarm(), f.data().nextAlarmAt, 'early alarm re-arms the persisted deadline');
  returned = 0;
  f.advance(600000); await restarted.alarm();
  t.diagnostic(`Actual time boundary: ${returned} historical sample rows returned by SQL`);
  assert.equal(returned, 0, 'expiry re-evaluates persisted facts without scanning raw history');
  returned = 0;
  f.advance(600000); await restarted.alarm();
  assert.equal(returned, 0, 'subsequent early alarms reuse the published snapshot');
});

test('status exposes bounded SQL usage counters without raw health data', async () => {
  const f = fixture();
  await detailUpload(f);
  const status = await (await f.store.fetch(new Request('https://store/status'))).json();
  assert.equal(status.sqlReadUsage.scope, 'explicit_sql_excluding_meter_and_internal_kv');
  assert.ok(Array.isArray(status.sqlReadUsage.days));
});

test('dashboard wakes at evidence expiry rather than every ten minutes', async () => {
  const f = fixture(undefined, cacheEnv), payloads = [];
  f.store.dashboardCachePublisher.publish = async payload => { payloads.push(JSON.parse(payload.payload24h)); return { ok: true }; };
  await detailUpload(f); f.advance(60000); await f.store.alarm();
  assert.equal(payloads.length, 1);
  assert.equal(f.data().dashboardCache.dueAt, Date.parse('2026-09-24T02:15:00Z'));
  f.advance(600000); await f.store.alarm();
  assert.equal(payloads.length, 1, 'no changed data or expired evidence means no Base write');
  f.advance(Date.parse('2026-09-24T07:30:00Z') - f.now()); await f.store.alarm();
  assert.equal(payloads.length, 2);
  assert.equal(payloads.at(-1).healthIndices.pressure.reason, 'expired_hrv');
});

test('a duplicate live batch after eviction updates receipt without scanning unchanged history', async () => {
  const f = fixture(undefined, cacheEnv);
  const records = Array.from({ length: 5000 }, (_, i) => ({ key: `hr-${i}`, kind: 'heart',
    start: f.now() - (5000 - i) * 60000, end: f.now() - (4999 - i) * 60000,
    source: 'Watch', value: 65, unit: 'bpm' }));
  f.store.series.put(records, f.now());
  f.store.dashboardCachePublisher.publish = async () => ({ ok: true });
  await detailUpload(f); f.advance(60000); await f.store.alarm();
  const dueAt = f.data().dashboardCache.dueAt;
  const restarted = new HealthStore({ storage: f.storage }, f.store.env, undefined, f.now);
  const exec = f.storage.sql.exec.bind(f.storage.sql);
  let queries = 0;
  f.storage.sql.exec = (query, ...args) => {
    if (query.startsWith('SELECT payload FROM samples')) queries++;
    return exec(query, ...args);
  };
  f.advance(300000);
  await detailUpload({ ...f, store: restarted });
  assert.equal(queries, 0, 'deduplication may look up keys but must not reload full sample histories');
  assert.equal(f.data().lastReceivedAt, f.now());
  assert.equal(f.data().streams.hrv.stats.unchanged, 2);
  assert.equal(f.data().dashboardCache.dueAt, dueAt);
  await restarted.fetch(new Request('https://store/ingest', { method: 'POST', body: JSON.stringify({
    stream: 'heart', aggregation: 'minutes', records: [{ ...records.at(-1), value: 70 }],
    summary: { samples: 1, skipped: 0, metrics: [], workouts: [], workoutReceived: null },
  }) }));
  assert.ok(queries > 0, 'a same-key value revision still invalidates and recalculates history');
  assert.equal(f.data().streams.heart.stats.updated, 1);
  assert.ok(f.data().dashboardCache.dueAt <= f.now() + 60000);
});

test('an otherwise idle dashboard refreshes at Beijing midnight', async () => {
  const f = fixture(undefined, cacheEnv), payloads = [];
  f.store.dashboardCachePublisher.publish = async payload => { payloads.push(JSON.parse(payload.payload24h)); return { ok: true }; };
  await detailUpload(f); f.advance(60000); await f.store.alarm();
  f.advance(9 * 3600000);
  await f.store.publishDashboardCache({ force: true });
  const midnight = Date.parse('2026-09-24T16:00:00Z');
  assert.equal(f.data().dashboardCache.dueAt, midnight);
  f.advance(midnight - f.now()); await f.store.alarm();
  assert.equal(payloads.at(-1).generatedAt, midnight);
  assert.equal(f.data().dashboardCache.dueAt, midnight + 24 * 3600000);
});

test('sleep settling wakes the dashboard without another upload', async () => {
  const f = fixture(undefined, cacheEnv), H = 3600000, records = [], payloads = [];
  const end = f.now() - H / 2;
  for (let day = 0; day < 5; day++) {
    const finish = end - day * 24 * H, start = finish - 8 * H;
    records.push({ kind: 'sleep', start, end: finish, stage: 'core', source: 'Watch' },
      { kind: 'hrv', start: start + 2 * H, end: start + 2 * H, value: 60, method: 'SDNN', source: 'Watch' });
    for (let i = 1; i < 5; i++) records.push({ kind: 'heart', start: start + i * H,
      end: start + i * H + 60000, value: 60, source: 'Watch' });
  }
  f.store.dashboardCachePublisher.publish = async payload => { payloads.push(JSON.parse(payload.payload24h)); return { ok: true }; };
  await f.store.fetch(new Request('https://store/ingest', { method: 'POST', body: JSON.stringify({
    stream: 'sleep-segments', aggregation: 'raw', records,
    summary: { samples: records.length, skipped: 0, metrics: [], workouts: [], workoutReceived: null },
  }) }));
  f.advance(60000); await f.store.alarm();
  assert.equal(payloads.at(-1).healthIndices.sleep.reason, 'sleep_settling');
  assert.equal(f.data().dashboardCache.dueAt, end + H);
  f.advance(end + H - f.now()); await f.store.alarm();
  assert.equal(payloads.at(-1).healthIndices.pressure.context, 'nightly');
  assert.ok(Number.isFinite(payloads.at(-1).healthIndices.pressure.score));
});

test('a dashboard write crossing its expiry schedules an immediate correction', async () => {
  const f = fixture(undefined, cacheEnv);
  await detailUpload(f); f.advance(60000);
  f.store.dashboardCachePublisher.publish = async () => { f.advance(15 * 60000); return { ok: true }; };
  await f.store.publishDashboardCache();
  assert.ok(f.data().dashboardCache.dueAt >= f.now());
  assert.ok(f.data().dashboardCache.dueAt <= f.now() + 1, 'expiry during I/O cannot wait for another upload');
});

test('a rolled-back ingestion never leaks uncommitted samples through cached history', async () => {
  const f = fixture();
  await detailUpload(f);
  const before = (await (await f.store.fetch(new Request('https://store/analysis'))).json());
  const put = f.storage.put;
  f.storage.put = async () => { throw new Error('disk failed'); };
  await assert.rejects(() => changedDetail(f), /disk failed/);
  f.storage.put = put;
  const after = await (await f.store.fetch(new Request('https://store/analysis'))).json();
  assert.deepEqual(after, before);
});
const changedDetail = async f => {
  const payload = structuredClone(detailPayload);
  payload.data.metrics[0].data.at(-1).qty = 65;
  return f.store.fetch(new Request('https://store/ingest', { method: 'POST', body: JSON.stringify({
    stream: 'hrv', aggregation: 'raw', records: parseSeries(payload, 'hrv'), summary: summarizeHealth(payload),
  }) }));
};
test('dashboard upload coalescing never postpones the first due time', async () => {
  const f = fixture(undefined, cacheEnv);
  await detailUpload(f); const due = f.data().dashboardCache.dueAt;
  f.advance(30000); await changedDetail(f);
  assert.equal(f.data().dashboardCache.dueAt, due);
});
test('dashboard publish keeps uploads received during I/O and excludes concurrent publishers', async () => {
  const f = fixture(undefined, cacheEnv);
  await detailUpload(f); f.advance(60000);
  let finish, started; const began = new Promise(resolve => { started = resolve; }); let calls = 0;
  f.store.dashboardCachePublisher.publish = async () => { calls++; started(); return new Promise(resolve => { finish = resolve; }); };
  const publishing = f.store.publishDashboardCache(); await began;
  assert.ok(f.data().dashboardCache.dueAt > f.now(), 'durable crash retry exists before I/O');
  await f.store.publishDashboardCache({ force: true }); assert.equal(calls, 1);
  f.advance(30000); await changedDetail(f); const due = f.data().dashboardCache.dueAt;
  finish({ ok: true }); await publishing;
  assert.equal(f.data().dashboardCache.dueAt, due);
  assert.equal(f.data().dashboardCache.attempts, 0);
});
test('dashboard thrown failures schedule retry and later success resets attempts', async () => {
  const f = fixture(undefined, cacheEnv); await detailUpload(f); f.advance(60000);
  f.store.dashboardCachePublisher.publish = async () => { throw new Error('sensitive network text'); };
  await f.store.publishDashboardCache();
  assert.equal(f.data().dashboardCache.attempts, 1);
  assert.ok(f.data().dashboardCache.dueAt > f.now());
  assert.doesNotMatch(JSON.stringify(f.data().dashboardCache), /sensitive/);
  f.advance(60000); f.store.dashboardCachePublisher.publish = async () => ({ ok: true });
  await f.store.publishDashboardCache();
  assert.equal(f.data().dashboardCache.attempts, 0);
  assert.equal(f.data().dashboardCache.dueAt, Date.parse('2026-09-24T02:15:00Z'));
});
test('live scoring records pressure once across cache refresh and object restart; backfill alone does not', async () => {
  const f = fixture(undefined, cacheEnv), H = 3600000;
  const records = [];
  for (let d = 0; d < 4; d++) {
    const start = f.now() - d * 24 * H - 600000;
    records.push({ kind: 'hrv', method: 'SDNN', start, end: start, value: 60, source: 'Watch' },
      { kind: 'heart', start, end: start + 60000, value: 65, source: 'Watch' });
  }
  const ingest = mode => f.store.fetch(new Request('https://store/ingest', { method: 'POST', body: JSON.stringify({
    stream: 'hrv', aggregation: 'raw', mode, records, summary: summarizeHealth(detailPayload),
  }) }));
  await ingest('backfill');
  const read = async store => (await (await store.fetch(new Request('https://store/dashboard'))).json()).pressureHistory;
  assert.equal((await read(f.store)).points.length, 0);
  await ingest('live'); assert.equal((await read(f.store)).points.length, 1);
  f.store.dashboardCachePublisher.publish = async () => ({ ok: true });
  await f.store.fetch(new Request('https://store/dashboard-cache/refresh', { method: 'POST' }));
  assert.equal((await read(f.store)).points.length, 1);
  const restarted = new HealthStore({ storage: f.storage }, cacheEnv, undefined, f.now);
  assert.equal((await read(restarted)).points.length, 1);
});
test('large pressure history fits Base while daily aggregates retain all observations', async () => {
 const f = fixture(undefined, cacheEnv); await detailUpload(f);
 for (let i = 0; i < 700; i++) f.store.pressureHistory.record({ ruleVersion: 'health-indices-v3-nightly',
  pressure: { evidenceAt: f.now() - i * 14 * 60000, score: 50, context: 'awake_sample', source: 'Watch', confidence: 'short_baseline' } }, f.now());
 // Full week of minute HR data must coexist with pressure observations in the same cell.
 f.store.series.put(Array.from({ length: 10080 }, (_, i) => ({ kind: 'heart', source: 'Watch',
  start: f.now() - (i + 1) * 60000, end: f.now() - i * 60000, value: 65, min: 60, max: 75 })), f.now());
 // Both HRV methods and monthly workouts also share the weekly text field.
 f.store.series.put(Array.from({ length: 1100 }, (_, i) => ({ kind: 'hrv', source: 'Watch', method: i % 2 ? 'RMSSD' : 'SDNN',
  start: f.now() - (i + 1) * 300000, end: f.now() - (i + 1) * 300000, value: 45 })), f.now());
 let payload;
 f.store.dashboardCachePublisher.publish = async p => { payload = p; return { ok: true }; };
 f.advance(60000); await f.store.publishDashboardCache();
 assert.ok(payload.payload7d.length < 90000);
 assert.equal(JSON.parse(payload.payload7d).heart.bucketMinutes, 60);
 const history = JSON.parse(payload.payload7d).pressureHistory;
 assert.equal(history.totalPoints, 700); assert.equal(history.sampled, true);
 assert.equal(history.days.reduce((sum, d) => sum + d.count, 0), 700);
});
test('DTO preparation failure schedules a durable retry without aborting other alarm work', async () => {
 const f = fixture(undefined, cacheEnv); await detailUpload(f); f.advance(60000);
 f.store.pressureHistory.view = () => { throw new Error('private internal message'); };
 await f.store.publishDashboardCache();
 assert.equal(f.data().dashboardCache.attempts, 1);
 assert.ok(f.data().dashboardCache.dueAt > f.now());
 assert.doesNotMatch(JSON.stringify(f.data().dashboardCache), /private/);
});
test('signature re-evaluation records newly settled nightly pressure even with cache disabled', async () => {
 const f = signatureFixture(undefined, 'health-indices-v1'), H = 3600000, records = [];
 const end = f.now() - H / 2;
 for (let day = 0; day < 5; day++) {
  const finish = end - day * 24 * H, start = finish - 8 * H;
  records.push({ kind: 'sleep', start, end: finish, stage: 'core', source: 'Watch' },
   { kind: 'hrv', start: start + 2 * H, end: start + 2 * H, value: 60, method: 'SDNN', source: 'Watch' });
  for (let i = 1; i < 5; i++) records.push({ kind: 'heart', start: start + i * H, end: start + i * H + 60000, value: 60, source: 'Watch' });
 }
 await f.store.fetch(new Request('https://store/ingest', { method: 'POST', body: JSON.stringify({
  stream: 'sleep-segments', aggregation: 'raw', records, summary: { samples: records.length, skipped: 0, metrics: [], workouts: [], workoutReceived: null },
 }) }));
 assert.equal(f.store.pressureHistory.view(f.now(), '24h').nights.length, 0);
 f.advance(H); await f.store.publishSignature();
 assert.equal(f.store.pressureHistory.view(f.now(), '24h').nights.length, 1);
 assert.equal(f.data().dashboardCache, undefined);
});


test('a cold midnight alarm clears signature sleep without relabeling historical dashboard data', async () => {
 const f = signatureFixture(undefined, 'health-indices-v1');
 const H = 3600000, D = 24 * H;
 const end = Date.parse('2026-09-24T08:00:00+08:00');
 const records = Array.from({ length: 4 }, (_, i) => ({ kind: 'sleep',
   start: end - i * D - 8 * H, end: end - i * D, stage: 'core', source: 'Watch' }));
 await f.store.fetch(new Request('https://store/ingest', { method: 'POST', body: JSON.stringify({
   stream: 'sleep-segments', aggregation: 'raw', records,
   summary: { samples: records.length, skipped: 0, metrics: [], workouts: [], workoutReceived: null },
 }) }));
 f.advance(60000); await f.store.alarm();
 assert.match(f.writes.at(-1), /睡眠100/);
 const midnight = Date.parse('2026-09-25T00:00:00+08:00');
 f.advance(midnight - 1 - f.now()); await f.store.alarm();
 assert.equal(f.nextAlarm(), midnight);
 const restarted = new HealthStore({ storage: f.storage }, f.store.env, async () => Response.json({ code: 0 }), f.now);
 restarted.signaturePublisher.publish = async title => { f.writes.push(title); return { ok: true }; };
 f.advance(1); await restarted.alarm();
 assert.match(f.data().signatureDelivery.desiredTitle, /睡眠 - /);
 f.advance(30000); await restarted.alarm();
 assert.match(f.writes.at(-1), /睡眠 - /);
 assert.equal(f.writes.length, 2);
 const dashboard = await (await restarted.fetch(new Request('https://store/dashboard?range=7d'))).json();
 assert.equal(dashboard.healthIndices.sleep.date, '2026-09-24');
 assert.equal(dashboard.healthIndices.sleep.score, 100);
 assert.equal(dashboard.sleep.at(-1).date, '2026-09-24');
 assert.equal(dashboard.sleep.at(-1).score, 100);
});

// The display copy must describe the signature that is actually live, not one still waiting to be written.
function liveSignatureCacheFixture(write) {
  const f = signatureFixture(write, 'health-indices-v1');
  Object.assign(f.store.env, { DASHBOARD_CACHE_TABLE_ID: 'cache', DASHBOARD_CACHE_RECORD_ID: 'cache' });
  const shown = [];
  f.store.dashboardCachePublisher.publish = async snapshot => { shown.push(JSON.parse(snapshot.payload24h).publication); return { ok: true }; };
  return { ...f, shown };
}

test('a successful signature retry refreshes a display copy that captured the pending title', async () => {
  let fail = true;
  const f = liveSignatureCacheFixture(async () => Response.json({ code: fail ? 91403 : 0, data: { record: { record_id: 'record' } } }));
  await detailUpload(f);
  f.advance(60000); await f.store.alarm();
  assert.equal(f.shown.length, 1);
  assert.equal(f.shown[0].pending, true, 'the failed write leaves the copy describing a pending signature');
  fail = false; f.advance(300000); await f.store.alarm();
  assert.equal(f.data().signatureDelivery.pending, false);
  assert.equal(f.shown.length, 2, 'the successful retry republishes the copy once');
  assert.deepEqual([f.shown[1].sentTitle, f.shown[1].pending], [f.data().signatureDelivery.sentTitle, false]);
  assert.equal(f.shown[1].measuredAt, f.data().signatureDelivery.publishedDecision.asOfAt);
  f.advance(300000); await f.store.alarm();
  assert.equal(f.shown.length, 2, 'an unchanged live title does not republish the copy');
});

test('a display copy due just before a rate-limited signature write waits for it', async () => {
  const f = liveSignatureCacheFixture();
  await detailUpload(f);
  f.advance(60000); await f.store.alarm();
  const sentAt = f.data().signatureDelivery.lastSentAt;
  f.advance(30000); await changedDetail(f);
  const signatureDue = f.data().signatureDelivery.dueAt;
  assert.equal(signatureDue, sentAt + 120000, 'the two-minute write interval holds the signature');
  assert.equal(f.data().dashboardCache.dueAt, signatureDue + 1000);
  f.advance(signatureDue - f.now()); await f.store.alarm();
  f.advance(1000); await f.store.alarm();
  assert.deepEqual([f.shown.at(-1).sentTitle, f.shown.at(-1).pending], [f.data().signatureDelivery.sentTitle, false]);
  assert.equal(f.shown.length, 2);
});

test('the private dashboard shows the cached decision the signature uses, without writing', async () => {
  const f = signatureFixture(undefined, 'health-indices-v1');
  await detailUpload(f);
  const before = structuredClone(f.data());
  const observations = f.store.storage.sql.exec('SELECT COUNT(*) AS n FROM pressure_observations').one().n;
  const evaluate = f.store.evaluateIndices.bind(f.store);
  let evaluations = 0;
  f.store.evaluateIndices = (...args) => { evaluations++; return evaluate(...args); };
  const dto = await (await f.store.fetch(new Request('https://store/dashboard?range=24h'))).json();
  assert.equal(evaluations, 0, 'a current cached decision is reused');
  assert.deepEqual(dto.healthIndices.headline, f.data().signatureCandidate.headline);
  assert.equal(dto.healthIndices.textVersion, 'health-signature-text-v1');
  assert.equal(dto.receivedAt, f.data().lastReceivedAt);
  assert.deepEqual(f.data(), before);
  assert.equal(f.store.storage.sql.exec('SELECT COUNT(*) AS n FROM pressure_observations').one().n, observations);
  f.advance(7 * 3600000);
  await f.store.fetch(new Request('https://store/dashboard?range=24h'));
  assert.equal(evaluations, 1, 'an expired decision is evaluated read-only');
  assert.deepEqual(f.data(), before);
});

test('facts stored silently are evaluated by the next live duplicate once, then duplicates reuse it', async () => {
  const f = fixture();
  await detailUpload(f); f.advance(60000); await f.store.alarm();
  const view = f.store.view.bind(f.store);
  let views = 0;
  f.store.view = (...args) => { views++; return view(...args); };
  f.advance(60000); await detailUpload(f);
  assert.equal(views, 0, 'a duplicate of evaluated facts is receipt-only');
  const late = structuredClone(detailPayload);
  late.data.metrics[0].data = [{ date: '2026-09-23T01:00:00Z', qty: 55, source: 'Watch' }];
  await f.store.fetch(new Request('https://store/ingest', { method: 'POST', body: JSON.stringify({
    stream: 'hrv', aggregation: 'raw', mode: 'backfill', records: parseSeries(late, 'hrv'), summary: summarizeHealth(late) }) }));
  views = 0;
  f.advance(60000); await detailUpload(f);
  assert.equal(views, 1, 'the first live upload after a silent backfill evaluates it');
  f.advance(60000); await detailUpload(f);
  assert.equal(views, 1, 'later duplicates reuse that evaluation');
});

test('alarm commits reuse review times while stored facts are unchanged, and a rollback drops them', async () => {
  const f = fixture();
  await detailUpload(f);
  const view = f.store.view.bind(f.store);
  let views = 0;
  f.store.view = (...args) => { views++; return view(...args); };
  const state = f.data();
  const first = await f.store.reviewAt(state, f.now());
  assert.equal(await f.store.reviewAt(state, f.now() + 1000), first);
  assert.equal(views, 0, 'the upload already computed the review times for this revision');
  await assert.rejects(f.store.transaction(async () => { f.store.reviewAt({ ...state, dataRevision: 99 }, f.now()); throw new Error('rollback'); }));
  assert.equal(f.store.reviewCache, null);
});

test('numeric group card shares dashboard scores, sends native chart and suppresses duplicate receipts', async () => {
  const cards = [];
  const f = fixture(async (_, options) => { cards.push(JSON.parse(options.body).card); return Response.json({ code: 0 }); },
    { SIGNATURE_MODE: 'health-indices-v1', HEALTH_DASHBOARD_URL: 'https://example.com/health', HEALTH_DEVICE_LABEL: 'Test Watch' });
  await detailUpload(f);
  f.advance(60000); await f.store.alarm();
  assert.equal(cards.length, 1);
  const card = await (await f.store.fetch(new Request('https://store/card'))).json();
  const dashboard = await (await f.store.fetch(new Request('https://store/dashboard'))).json();
  assert.equal(card.header.title.content, '健康速览');
  assert.ok(JSON.stringify(card).includes('"tag":"chart"'));
  assert.match(JSON.stringify(card), /https:\/\/example.com\/health/);
  assert.match(card.config.summary.content, new RegExp(`最近压力 ${dashboard.healthIndices.pressure.score ?? '-'}`));
  const fingerprint = f.data().delivery.sentContent;
  f.advance(60000);
  assert.equal((await (await detailUpload(f)).json()).notification, 'unchanged');
  await f.store.alarm();
  assert.equal(cards.length, 1);
  assert.equal(f.data().delivery.sentContent, fingerprint);
});
