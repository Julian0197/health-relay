import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSeries, parseArchive, SeriesStore } from './series.mjs';
import { summarizeHealth } from './health-card.mjs';
import { testSql } from './sql-test-helper.mjs';
const now = Date.parse('2026-09-24T04:00:00Z');
const data = (name, units, points) => ({ data: { metrics: [{ name, units, data: points }] } });
const point = { date: '2026-09-24T03:00:00Z', qty: 50, source: 'Watch' };

test('daily history caches survive restart and only changed dates reload raw samples', () => {
  const sql = testSql(), store = new SeriesStore(sql), day = 86400000;
  const rows = [1, 2, 3].map(i => ({ kind: 'heart', start: now - i * day, end: now - i * day + 60000, value: 65, source: 'Watch' }));
  store.put(rows, now);
  store.list('heart');
  const exec = sql.exec.bind(sql);
  let rawQueries = 0;
  sql.exec = (query, ...args) => {
    if (query.startsWith('SELECT payload FROM samples')) rawQueries++;
    return exec(query, ...args);
  };
  const restarted = new SeriesStore(sql);
  assert.deepEqual(restarted.list('heart').map(r => r.start), rows.map(r => r.start).sort((a, b) => a - b));
  assert.equal(rawQueries, 0, 'cold reads must use persisted day caches');
  restarted.put([{ ...rows[1], value: 70 }], now);
  assert.equal(restarted.list('heart').find(r => r.start === rows[1].start).value, 70);
  assert.equal(rawQueries, 1, 'a correction only reloads the affected day');
});

test('counts use retained metadata and changed ranges exclude repeated history', () => {
  const sql = testSql(), store = new SeriesStore(sql);
  const old = { kind: 'heart', start: now - 86400000, end: now - 86400000 + 60000, value: 65, source: 'Watch' };
  store.put([old], now);
  const latest = { ...old, start: now - 60000, end: now };
  assert.deepEqual(store.put([old, latest], now).changedRange, { startAt: latest.start, endAt: latest.end });
  const exec = sql.exec.bind(sql);
  sql.exec = (query, ...args) => {
    assert.ok(!query.includes('COUNT(*)') || !query.includes('FROM samples'), 'diagnostics must not count the raw table');
    return exec(query, ...args);
  };
  assert.deepEqual(store.counts(), { heart: 2 });
  store.prune(now + 36 * 86400000);
  assert.deepEqual(store.counts(), {});
  assert.deepEqual(new SeriesStore(sql).list('heart'), []);
});

test('day cache invalidation and counts roll back with sample corrections and survive old writers', () => {
  const sql = testSql(), row = { key: 'session', kind: 'heart', start: now - 60000, end: now, value: 65, source: 'Watch' };
  const store = new SeriesStore(sql);
  store.put([row], now); store.list('heart');
  sql.exec('BEGIN');
  store.put([{ ...row, start: now - 86400000, end: now - 86400000 + 60000, value: 70 }], now);
  store.list('heart');
  sql.exec('ROLLBACK');
  assert.deepEqual(new SeriesStore(sql).list('heart').map(r => r.value), [65]);
  assert.deepEqual(store.counts(), { heart: 1 });
  // A rollback deployment can still use the original raw-table writer.
  sql.exec('UPDATE samples SET payload=? WHERE key=?', JSON.stringify({ ...row, value: 75 }), row.key);
  assert.equal(new SeriesStore(sql).list('heart')[0].value, 75);
});

test('bounded heart reads recover old workout windows without pulling the entire month', () => {
  const store = new SeriesStore(testSql()), start = now - 20 * 86400000;
  store.put([start - 60000, start, start + 60000, start + 120000].map(t =>
    ({ kind: 'heart', start: t, end: t + 60000, value: 130, source: 'Watch' })), now);
  assert.equal(typeof store.listBetween, 'function');
  assert.deepEqual(store.listBetween('heart', start, start + 120000).map(r => r.start), [start, start + 60000]);
});

test('workout ingestion retains exact activity duration and normalized energy and heart summaries', () => {
  const workout = { id: 'session', name: '力量训练', start: '2026-09-24T02:00:00Z', end: '2026-09-24T03:00:00Z',
    duration: 1199, activeEnergyBurned: { qty: 418.4, units: 'kJ' },
    heartRate: { avg: { qty: 120, units: 'count/min' }, max: { qty: 165, units: 'bpm' } },
    route: [{ latitude: 1, longitude: 2 }] };
  const parse = w => { const p = { data: { workouts: [w] } }; return parseArchive(p, summarizeHealth(p), 'workouts')[0]; };
  const row = parse(workout);
  assert.equal(row.durationMs, 1199000);
  assert.equal(row.activeEnergyKcal, 100);
  assert.equal(row.avgHeartRate, 120); assert.equal(row.maxHeartRate, 165);
  assert.equal(row.route, undefined);
  const invalid = parse({ ...workout, activeEnergyBurned: { qty: 20, units: 'unknown' },
    heartRate: { avg: { qty: 120, units: 'ms' } }, avgHeartRate: undefined, maxHeartRate: undefined });
  assert.equal(invalid.activeEnergyKcal, null); assert.equal(invalid.avgHeartRate, null);
  assert.equal(parse({ ...workout, activeEnergyBurned: { qty: 0, units: 'kcal' } }).activeEnergyKcal, 0);
});

test('unchanged history is reused, while revisions and retention invalidate affected series', () => {
  const sql = testSql(), original = sql.exec.bind(sql);
  let reads = 0;
  sql.exec = (query, ...args) => {
    if (query.startsWith('SELECT payload FROM samples')) reads++;
    return original(query, ...args);
  };
  const store = new SeriesStore(sql);
  const rows = parseSeries(data('heart_rate_variability', 'ms', [point]), 'hrv');
  store.put(rows, now);
  assert.equal(store.list('hrv', now - 86400000).length, 1);
  store.put(rows, now); // HAE routinely resends the same history.
  store.prune(now);
  assert.equal(store.list('hrv', now - 3600000)[0].value, 50);
  assert.equal(reads, 1, 'duplicate uploads and no-op retention must not reload history');
  assert.equal(store.list('hrv', now)[0], undefined, 'moving time windows must still expire samples');
  store.put([{ ...rows[0], value: 61 }], now);
  assert.equal(store.list('hrv', now - 86400000)[0].value, 61);
  assert.equal(reads, 2);
  store.prune(now + 36 * 86400000);
  assert.equal(store.list('hrv', now - 86400000).length, 0);
});

test('HRV preserves each SDNN sample and source, rejects averages/wrong units', () => {
  const rows = parseSeries(data('heart_rate_variability', 'ms', [point, { ...point, date: '2026-09-24T03:30:00Z' }]), 'hrv');
  assert.equal(rows.length, 2); assert.equal(rows[0].method, 'SDNN'); assert.equal(rows[0].source, 'Watch');
  assert.throws(() => parseSeries(data('heart_rate_variability', 'bpm', [point]), 'hrv'));
  assert.throws(() => parseSeries(data('heart_rate_variability', 'ms', [{ date: point.date, Avg: 50 }]), 'hrv'));
});
test('one minute HRV export stores SDNN and RMSSD separately and resends idempotently', () => {
  const payload = { data: { metrics: [
    { name: 'heart_rate_variability', units: 'ms', data: [point] },
    { name: 'heart_rate_variability_rmssd', units: 'ms', data: [{ date: point.date, Avg: 35 }] },
  ] } };
  const rows = parseSeries(payload, 'hrv', 'minutes');
  assert.deepEqual(rows.map(r => r.method), ['SDNN', 'RMSSD']);
  assert.deepEqual(rows.map(r => r.value), [50, 35]);
  assert.ok(rows.every(r => r.aggregation === 'minutes' && r.end - r.start === 60000));
  assert.equal(rows[1].source, 'unknown', 'aggregation must not invent a device source');
  const store = new SeriesStore(testSql());
  store.put(rows, now);
  assert.equal(store.put(rows, now).stats.unchanged, 2);
  assert.equal(store.list('hrv').length, 2);
});
test('minute HRV preserves raw history and rejects coarse, mislabeled or unrelated exports', () => {
  const store = new SeriesStore(testSql());
  store.put(parseSeries(data('heart_rate_variability', 'ms', [point]), 'hrv'), now);
  store.put(parseSeries(data('heart_rate_variability', 'ms', [point]), 'hrv', 'minutes'), now);
  assert.equal(store.list('hrv').length, 2);
  assert.throws(() => parseSeries(data('heart_rate_variability_rmssd', 'ms', [{ ...point, date: '2026-09-24T03:00:30Z' }]), 'hrv', 'minutes'), /minute/);
  assert.throws(() => parseSeries(data('heart_rate_variability_rmssd', 'bpm', [point]), 'hrv', 'minutes'), /hrv/);
  assert.throws(() => parseSeries(data('heart_rate', 'ms', [point]), 'hrv', 'minutes'), /wrong_data_type/);
  const combined = { data: { metrics: [data('heart_rate_variability', 'ms', [point]).data.metrics[0],
    data('heart_rate_variability_rmssd', 'ms', [point]).data.metrics[0]] } };
  assert.throws(() => parseSeries(combined, 'hrv', 'raw'), /wrong_data_type/);
});
test('sleep preserves end, stage, source and stable sample ID for corrections', () => {
  const first = { id: 'sleep-one', startDate: '2026-09-23T16:00:00Z', endDate: '2026-09-24T00:00:00Z', qty: 8, value: 'Core', source: 'Watch' };
  const [a] = parseSeries(data('sleep_analysis', 'hr', [first]), 'sleep-segments');
  const [b] = parseSeries(data('sleep_analysis', 'hr', [{ ...first, endDate: '2026-09-24T00:10:00Z' }]), 'sleep-segments');
  assert.equal(a.stage, 'core'); assert.equal(a.key, b.key); assert.ok(b.end > a.end);
  assert.throws(() => parseSeries(data('sleep_analysis', 'hr', [{ ...first, endDate: first.startDate }]), 'sleep-segments'));
});
test('HAE Simplified Chinese sleep phases normalize to the same records as English', () => {
  // Confirmed in installed HAE zh-Hans Localizable.strings; live upload sent 核心.
  const phases = [['核心', 'Core'], ['深度', 'Deep'], ['快速动眼期', 'REM'], ['清醒', 'Awake'],
    ['睡眠时长', 'Asleep'], ['在床上', 'In Bed'], ['未指定', 'Unspecified']];
  const segment = { startDate: '2026-09-23T18:00:00Z', endDate: '2026-09-23T18:30:00Z', qty: 0.5, source: 'Watch' };
  for (const [localized, english] of phases) {
    const parse = value => parseSeries(data('sleep_analysis', 'hr', [{ ...segment, value }]), 'sleep-segments');
    assert.deepEqual(parse(localized), parse(english));
  }
  assert.throws(() => parseSeries(data('sleep_analysis', 'hr', [{ ...segment, value: '未知阶段' }]), 'sleep-segments'), /sleep_segments_required/);
});
test('heart minute windows preserve extrema and cannot accept sleep', () => {
  const [row] = parseSeries(data('heart_rate', 'count/min', [{ date: point.date, Avg: 70, Min: 60, Max: 90 }]), 'heart');
  assert.equal(row.value, 70); assert.equal(row.max, 90); assert.equal(row.end - row.start, 60000);
  assert.throws(() => parseSeries(data('sleep_analysis', 'hr', []), 'heart'));
});
test('heart minute windows preserve averages with floating point noise at either bound', () => {
  for (const Avg of [70.00000000000001, 69.99999999999999]) {
    const [row] = parseSeries(data('heart_rate', 'count/min', [{ date: point.date, Avg, Min: 70, Max: 70 }]), 'heart');
    assert.equal(row.value, Avg);
    assert.equal(row.min, 70);
    assert.equal(row.max, 70);
  }
});
test('heart precision tolerance does not accept conflicting extrema or invalid numbers', () => {
  for (const values of [
    { Avg: 70 + 1e-9, Min: 70, Max: 70 },
    { Avg: 70 - 1e-9, Min: 70, Max: 70 },
    { Avg: 70, Min: null }, { Avg: 70, Max: Infinity },
    { Avg: 0 }, { Avg: NaN }, { Avg: 70, Min: -1 },
  ]) assert.throws(() => parseSeries(data('heart_rate', 'bpm', [{ date: point.date, ...values }]), 'heart'), /invalid_heart_window/);
});
test('real SQLite retains many timestamps, revises same key, preserves source boundaries and expires after 35 days', () => {
  const store = new SeriesStore(testSql());
  const rows = parseSeries(data('heart_rate_variability', 'ms', [point, { ...point, date: '2026-09-24T03:30:00Z' }]), 'hrv');
  store.put(rows, now); store.put(rows, now);
  assert.equal(store.list('hrv').length, 2);
  store.put([{ ...rows[0], value: 60 }], now);
  assert.equal(store.list('hrv')[0].value, 60);
  store.put(parseSeries(data('heart_rate_variability', 'ms', [{ ...point, source: 'Other Watch' }]), 'hrv'), now);
  assert.equal(store.list('hrv').length, 3);
  store.prune(now + 36 * 86400000); assert.equal(store.list('hrv').length, 0);
});
test('expired backfill and future samples report excluded counts rather than pretending saved', () => {
  const store = new SeriesStore(testSql());
  const rows = parseSeries(data('heart_rate_variability', 'ms', [{ ...point, date: '2026-08-01T03:00:00Z' }]), 'hrv');
  assert.equal(store.put(rows, now).expired, 1);
  assert.throws(() => store.put([{ ...rows[0], start: now + 3600000 }], now), /future/);
});

test('detail routes require actual timestamps instead of date-only values', () => {
  assert.throws(() => parseSeries(data('heart_rate_variability', 'ms', [{ ...point, date: '2026-09-24' }]), 'hrv'), /time/);
  assert.throws(() => parseSeries(data('heart_rate', 'bpm', [{ ...point, date: '2026-09-24' }]), 'heart'), /time/);
});

test('empty detail exports are accepted without representing zero measurements', () => {
  assert.deepEqual(parseSeries({ data: { metrics: [] } }, 'hrv'), []);
});

test('ingestion statistics distinguish inserts, revisions, semantic repeats and batch duplicates', () => {
  const store = new SeriesStore(testSql());
  const rows = parseSeries(data('heart_rate_variability', 'ms', [point]), 'hrv');
  const first = store.put([...rows, ...rows], now);
  assert.deepEqual(first.stats, { parsedRecords: 2, duplicateInBatch: 1, uniqueRecords: 1, inserted: 1, updated: 0, unchanged: 0, expired: 0 });
  assert.equal(first.stored, 2);
  const repeated = store.put([{ ...rows[0], originalTime: '2026-09-24T11:00:00+08:00' }], now);
  assert.equal(repeated.stats.unchanged, 1);
  assert.equal(store.put([{ ...rows[0], value: 51 }], now).stats.updated, 1);
  assert.equal(store.counts().hrv, 1);
});

test('conflicting same-key batch is rejected before any writes', () => {
  const store = new SeriesStore(testSql());
  const [row] = parseSeries(data('heart_rate_variability', 'ms', [point]), 'hrv');
  assert.throws(() => store.put([row, { ...row, value: 99 }], now), /conflicting_records_in_batch/);
  assert.deepEqual(store.counts(), {});
});
