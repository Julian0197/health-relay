// Dedicated private cache only. Render these deployment coordinates with prepare_reader.py.
const BASE = 'example_base';
const TABLE = 'example_table';
const RECORD = 'example_record';
const { createHash, timingSafeEqual } = require('node:crypto');

const MAX_BYTES = 4093, READ_TIMEOUT_MS = 8000;
const DAY = 86400000, OFFSET = 8 * 3600000;
const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const json = (status, error, extra = {}) => new Response(JSON.stringify({ ok: false, error }), {
  status, headers: { ...headers, ...extra },
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 253402214399999;
const dayIndex = now => Math.floor((now + OFFSET) / DAY);
const dateAt = time => new Date(time + OFFSET).toISOString().slice(0, 10);
const dateValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  value >= '0001-01-01' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const timeValid = value => typeof value === 'string' && (value === '' ||
  /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):[0-5]\d$/.test(value));
const metricValid = (value, min, max) => value === null || (Number.isInteger(value) && value >= min && value <= max);
const limits = {
  pressure: [0, 100], heart: [1, 300], hrv: [1, 1000], sleepScore: [0, 100], sleepMinutes: [0, 1440],
  workoutCount: [0, 100], workoutMinutes: [0, 1440], workoutKcal: [0, 10000],
  steps: [0, 200000], activeKcal: [0, 20000], exerciseMinutes: [0, 1440], distanceMeters: [0, 2000000],
};
const sleepMetrics = ['total', 'deep', 'core', 'rem', 'awake', 'unknown'];
const emptySleepNight = date => ({ date, total: null, deep: null, core: null, rem: null, awake: null, unknown: null });

function sleepWeekValid(week, generatedAt) {
  return Array.isArray(week) && week.length === 7 && week.every((night, i) => {
    if (!object(night) || Object.keys(night).length !== 7 || !dateValid(night.date) ||
        night.date !== dateAt(generatedAt - (6 - i) * DAY) ||
        !sleepMetrics.every(key => metricValid(night[key], 0, 1440))) return false;
    const asleepStages = ['deep', 'core', 'rem', 'unknown'].map(key => night[key]);
    return night.total === null || asleepStages.some(value => value === null) ||
      asleepStages.reduce((sum, value) => sum + value, 0) === night.total;
  });
}

function validCache(cache, now) {
  if (!object(cache) || Object.keys(cache).length !== 4 || ![2, 3].includes(cache.version) ||
      !timestamp(cache.generatedAt) || cache.generatedAt > now ||
      !(cache.pressureValidUntil === null || timestamp(cache.pressureValidUntil))) return false;
  const p = cache.payload;
  if (!object(p) || Object.keys(p).length !== (cache.version === 3 ? 26 : 24) ||
      p.v !== cache.version || p.online !== true || p.demo !== false ||
      typeof p.retained !== 'boolean' || !['SDNN', 'RMSSD'].includes(p.hrvMethod) ||
      !dateValid(p.day) || p.day !== dateAt(cache.generatedAt) ||
      !(p.sleepDate === '' || (dateValid(p.sleepDate) && p.sleepDate === p.day))) return false;
  if (!['asOf', 'pressureAt', 'heartAt', 'hrvAt'].every(key => timeValid(p[key])) ||
      !Object.entries(limits).every(([key, [min, max]]) => metricValid(p[key], min, max)) ||
      !Array.isArray(p.trend) || p.trend.length !== 7 || !p.trend.every(value => metricValid(value, 0, 100))) return false;
  if (cache.version === 3 && (!sleepWeekValid(p.sleepWeek, cache.generatedAt) ||
      !Array.isArray(p.workoutTypes) || p.workoutTypes.length > 8 ||
      !p.workoutTypes.every(label => typeof label === 'string' && /^[A-Za-z0-9 -]{1,24}$/.test(label)) ||
      new Set(p.workoutTypes).size !== p.workoutTypes.length)) return false;
  return true;
}

// Keep this small presentation function in sync with integrations/hae-webhook/badge.mjs.
// Tests compare its output to readBadgeCache; never score or relabel saved measurements here.
function readBadgeCache(cache, now) {
  const elapsedDays = Math.max(0, Math.min(7, dayIndex(now) - dayIndex(cache.generatedAt)));
  const payload = { ...cache.payload,
    retained: cache.payload.pressure !== null && (cache.payload.retained ||
      (cache.pressureValidUntil !== null && now >= cache.pressureValidUntil)),
    trend: [...cache.payload.trend.slice(elapsedDays), ...Array(elapsedDays).fill(null)],
  };
  if (cache.version === 3) {
    payload.sleepWeek = Array.from({ length: 7 }, (_, i) => {
      const date = dateAt(now - (6 - i) * DAY);
      const night = cache.payload.sleepWeek.find(row => row.date === date);
      return night ? { ...night } : emptySleepNight(date);
    });
    payload.workoutTypes = [...cache.payload.workoutTypes];
  }
  if (payload.day !== dateAt(now)) {
    Object.assign(payload, { day: dateAt(now), retained: cache.version === 3 && payload.pressure !== null,
      sleepScore: null, sleepMinutes: null, sleepDate: '', workoutCount: null, workoutMinutes: null,
      workoutKcal: null, steps: null, activeKcal: null, exerciseMinutes: null, distanceMeters: null });
    if (cache.version === 3) payload.workoutTypes = [];
    else Object.assign(payload, { pressure: null, retained: false, pressureAt: '' });
  }
  return payload;
}

function fieldText(value) {
  if (typeof value === 'string') return value;
  return Array.isArray(value) && value.every(part => typeof part?.text === 'string')
    ? value.map(part => part.text).join('') : '';
}

module.exports = async function (request, context) {
  if (request.method !== 'GET') return json(405, 'method_not_allowed', { Allow: 'GET' });
  const key = request.headers.get('X-API-Key');
  if (typeof key !== 'string' || !/^[\x20-\x7e]{16,128}$/.test(key)) return json(401, 'unauthorized');
  let timeout;
  try {
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('read_timeout')), READ_TIMEOUT_MS);
    });
    const result = await Promise.race([window.magic.base_records_get(BASE, TABLE, [RECORD]), deadline]);
    const record = result?.code === 0 && result.data?.records?.length === 1 ? result.data.records[0] : null;
    if (record?.record_id !== RECORD) throw new Error('record_unavailable');
    const credential = fieldText(record.fields?.credential_sha256);
    if (!/^[a-f0-9]{64}$/i.test(credential)) throw new Error('credential_unavailable');
    const candidate = createHash('sha256').update(key).digest();
    if (!timingSafeEqual(candidate, Buffer.from(credential, 'hex'))) return json(401, 'unauthorized');
    const saved = fieldText(record.fields?.payload);
    if (Buffer.byteLength(saved) > MAX_BYTES) throw new Error('cache_too_large');
    const cache = JSON.parse(saved), now = Date.now();
    if (!validCache(cache, now)) throw new Error('invalid_cache');
    const body = JSON.stringify(readBadgeCache(cache, now));
    if (Buffer.byteLength(body) > MAX_BYTES) throw new Error('response_too_large');
    return new Response(body, { status: 200, headers });
  } catch {
    return json(503, 'badge_cache_unavailable');
  } finally {
    clearTimeout(timeout);
  }
};
