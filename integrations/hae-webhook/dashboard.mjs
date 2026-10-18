// Read-only dashboard DTO for the Feishu HTML box. Pure function: no I/O, no secrets.
// Consumes the same Durable Object facts and evaluateHealthIndices result as the signature,
// so the dashboard can never diverge in scoring semantics. Contract: docs/dashboard-realtime-milestones.md
import { sleepSessions } from './analysis.mjs';
import { scoreSleepSession } from './health-indices.mjs';
import { pressureHeadline, retainedPressure, scorePresentation } from './health-signature.mjs';
import { buildWorkoutHistory } from './workouts.mjs';
const HOUR = 3600000, DAY = 24 * HOUR;
export const DASHBOARD_VERSION = 'dashboard-v1';
export const HEART_POINT_CAP = 5000;
const RANGES = { '24h': DAY, '7d': 7 * DAY };
const dateKey = t => new Date(t + 8 * HOUR).toISOString().slice(0, 10);
const DAILY_METRICS = new Set([
  'step_count', 'active_energy', 'apple_exercise_time',
  'resting_heart_rate', 'walk_run_distance', 'walking_running_distance',
]);

// Revision detection cannot use measurement timestamps: a corrected row keeps the
// same start/end (steps 1000 -> 2000 leaves dataUpdatedAt untouched). Hash the
// rendered content itself so any correction moves the version. FNV-1a with two
// independent offsets gives a 64-bit non-crypto fingerprint, plenty for cache keys.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
function fnv1a(text, offset) {
  let h = offset >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}
export function contentHash(payload) {
  // generatedAt shifts on every render and window edges slide with now; neither is
  // rendered content. A duplicate receipt moves receivedAt without changing any fact. A row entering/leaving the window still changes the data
  // arrays themselves, and new measurements move dataUpdatedAt, so real changes hash.
  const { generatedAt, window, receivedAt, ...content } = payload;
  if (content.healthIndices) {
    const { evaluatedAt, ...indices } = content.healthIndices;
    content.healthIndices = indices;
  }
  if (content.workoutHistory) {
    const { startAt, endAt, ...history } = content.workoutHistory;
    content.workoutHistory = history;
  }
  const text = canonical(content);
  return [fnv1a(text, 0x811c9dc5), fnv1a(text, 0x01000193)].map(h => h.toString(16).padStart(8, '0')).join('');
}

// The reader copy keeps calendar dates, durations and scores, not sleep boundaries.
// The private API and scoring inputs retain the original measurement timestamps.
export function dashboardForReaders(dto) {
  const { contentHash: previousHash, ...view } = dto;
  view.sleep = (dto.sleep ?? []).map(({ start, end, ...night }) => night);
  if (dto.healthIndices?.sleep) {
    const { endAt, ...sleep } = dto.healthIndices.sleep;
    view.healthIndices = { ...dto.healthIndices, sleep };
  }
  if (dto.channels?.sleep) {
    const { latestAt, ...sleep } = dto.channels.sleep;
    view.channels = { ...dto.channels, sleep: {
      ...sleep, latestDate: Number.isFinite(latestAt) ? dateKey(latestAt) : (sleep.latestDate ?? null),
    } };
  }
  return { ...view, contentHash: contentHash(view) };
}

// Keep source metadata without choosing a conflicting device's value silently.
const sourceCategory = source => {
  const text = String(source ?? '').toLowerCase();
  if (text.includes('watch')) return 'watch';
  if (text.includes('phone') || text.includes('手机')) return 'phone';
  return 'other';
};
function resolveDaily(metric, rows) {
  const sources = new Set(rows.map(r => String(r.source ?? 'unknown')));
  const categories = new Set(rows.map(r => sourceCategory(r.source)));
  const values = rows.map(r => normalizeDaily(metric, r.value, r.unit));
  const first = values[0];
  const conflict = values.some(v => v.v === null || v.unit !== first.unit || Math.abs(v.v - first.v) > 1e-6);
  const value = rows.length === 1 ? first : conflict ? { v: null, unit: first.unit, reason: 'source_conflict' } : first;
  return { ...value, source: categories.size === 1 ? [...categories][0] : 'mixed', sources: sources.size, conflict };
}

export function dashboardRange(value) {
  return RANGES[value] ? value : null;
}

// Downsample minute heart windows into fixed buckets (mean value) for the Base-relayed
// dashboard copy, whose text cells cap near 100k chars. Buckets stay on the time grid so
// adjacent reloads merge identically; empty buckets are never emitted, preserving line gaps.
export function bucketHeartPoints(points, bucketMs) {
  if (!Number.isFinite(bucketMs) || bucketMs <= 60000) return points;
  const buckets = new Map();
  for (const p of points) {
    const key = Math.floor(p.s / bucketMs);
    const bucket = buckets.get(key);
    if (bucket) { bucket.sum += p.v; bucket.n += 1; bucket.e = Math.max(bucket.e, p.e); bucket.min = Math.min(bucket.min, p.min ?? p.v); bucket.max = Math.max(bucket.max, p.max ?? p.v); }
    else buckets.set(key, { s: key * bucketMs, e: p.e, sum: p.v, n: 1, min: p.min ?? p.v, max: p.max ?? p.v });
  }
  return [...buckets.keys()].sort((a, b) => a - b).map(key => {
    const b = buckets.get(key);
    return { s: b.s, e: Math.min(b.e, b.s + bucketMs), v: Math.round(b.sum / b.n), min: b.min, max: b.max };
  });
}

export function buildDashboard(series, now, { range = '24h', indices = null, publication = null, heartBucketMs = null, pressureHistory = null, workoutHeart = null, receivedAt = null } = {}) {
  const windowMs = RANGES[range];
  if (!windowMs) throw new Error('invalid_range');
  const startAt = now - windowMs;
  const inWindow = row => row.end >= startAt && row.start <= now;
  // Latest evidence time comes from measurement timestamps only, never receipt times.
  const allEnds = ['hrv', 'heart', 'sleep', 'daily', 'workout']
    .flatMap(kind => series[kind] ?? []).map(r => r.end).filter(Number.isFinite);
  const dataUpdatedAt = allEnds.length ? Math.max(...allEnds) : null;

  const hrvRows = (series.hrv ?? []).filter(r => r.end <= now && r.value > 0);
  const hrvPoints = method => hrvRows
    .filter(r => r.method === method && r.start >= startAt)
    .sort((a, b) => a.start - b.start)
    .map(r => ({ t: r.start, v: Math.round(r.value) }));
  const hrv = hrvPoints('SDNN'), recoveryHrv = hrvPoints('RMSSD');

  const heartRows = (series.heart ?? [])
    .filter(r => inWindow(r) && r.end <= now && r.value > 0)
    .sort((a, b) => a.start - b.start)
    .map(r => ({ s: r.start, e: r.end, v: Math.round(r.value), min: r.min ?? r.value, max: r.max ?? r.value }));
  // Bucket BEFORE the point cap: the cap exists for payload size, and a 7d window
  // holds 10080 raw minutes (more than the 5000 cap). Truncating first would silently
  // drop the oldest ~3.5 days and the buckets would only cover the recent half-window.
  const bucketMs = Number.isFinite(heartBucketMs) && heartBucketMs > 60000 ? heartBucketMs : null;
  const heartPoints = bucketMs ? bucketHeartPoints(heartRows, bucketMs) : heartRows;
  const truncated = heartPoints.length > HEART_POINT_CAP;
  const heart = {
    points: heartPoints.slice(-HEART_POINT_CAP),
    latest: heartRows.at(-1) ?? null,
    truncated, cap: HEART_POINT_CAP,
    ...(bucketMs ? { bucketMinutes: bucketMs / 60000 } : {}),
  };

  // One bar per night: reuse the same session grouping the scorer uses;
  // sessions crossing the window edge or with conflicts are still shown (flagged), not hidden.
  const sessions = sleepSessions((series.sleep ?? []).filter(r => r.end <= now));
  const sleep = sessions
    .filter(s => s.main && s.end >= startAt)
    .map(s => {
      // Historical nights are assessed once settled, rather than expired against today's clock.
      const assessment = scoreSleepSession(s, sessions, Math.min(now, s.end + HOUR));
      return {
        date: s.date, start: s.start, end: s.end,
        asleepMinutes: s.asleepMinutes, awakeMinutes: s.awakeMinutes,
        stages: s.stages, conflict: s.conflict, sources: s.sources.length,
        score: assessment.score, reason: assessment.reason, components: assessment.components,
        baselineDays: assessment.baselineDays ?? 0,
        bedtimeDeviationMinutes: assessment.bedtimeDeviationMinutes ?? null,
      };
    })
    .sort((a, b) => a.end - b.end);

  const dailyByDate = new Map();
  for (const r of series.daily ?? []) {
    if (!DAILY_METRICS.has(r.metric) || !Number.isFinite(r.value) || r.start > now) continue;
    const date = dateKey(r.start);
    if (date < dateKey(startAt) || date > dateKey(now)) continue;
    if (!dailyByDate.has(date)) dailyByDate.set(date, new Map());
    const metric = r.metric === 'walking_running_distance' ? 'walk_run_distance' : r.metric;
    const byMetric = dailyByDate.get(date);
    if (!byMetric.has(metric)) byMetric.set(metric, []);
    byMetric.get(metric).push(r);
  }
  const daily = [];
  const firstDay = Math.floor((startAt + 8 * HOUR) / DAY) * DAY - 8 * HOUR;
  for (let t = firstDay; t <= now; t += DAY) {
    const date = dateKey(t), byMetric = dailyByDate.get(date) ?? new Map();
    daily.push({ date, metrics: Object.fromEntries([...byMetric.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([metric, rows]) => [metric, resolveDaily(metric, rows)])) });
  }

  const workouts = (series.workout ?? [])
    .filter(r => r.start >= startAt && r.end <= now)
    .sort((a, b) => a.start - b.start)
    .map(r => ({ name: r.name, start: r.start, end: r.end, durationMs: r.end - r.start }));

  const channels = {};
  for (const kind of ['hrv', 'heart', 'daily', 'sleep', 'workout']) {
    const rows = kind === 'hrv' ? hrvRows.filter(r => r.method === 'SDNN')
      : (series[kind] ?? []).filter(r => r.end <= now);
    channels[kind] = { count: rows.length, latestAt: rows.length ? Math.max(...rows.map(r => kind === 'daily' ? r.start : r.end)) : null };
  }
  const recoveryRows = hrvRows.filter(r => r.method === 'RMSSD');
  channels.recoveryHrv = { count: recoveryRows.length, latestAt: recoveryRows.length ? Math.max(...recoveryRows.map(r => r.end)) : null };

  const payload = {
    schemaVersion: DASHBOARD_VERSION,
    generatedAt: now,
    // Three separate clocks: measurement (dataUpdatedAt, healthIndices.asOfAt), receipt, publication.
    dataUpdatedAt, receivedAt,
    timezone: 'Asia/Shanghai',
    range,
    window: { startAt, endAt: now },
    healthIndices: indicesView(indices, now, pressureHistory),
    publication: publicationView(publication),
    hrv, recoveryHrv, heart, sleep, daily, workouts,
    workoutHistory: buildWorkoutHistory({ workout: series.workout, heart: workoutHeart ?? series.heart }, now), channels, pressureHistory,
  };
  // Rendered-content version: changes when any displayed value changes, even if
  // timestamps do not. Clients should redraw only when contentHash changes.
  return { ...payload, contentHash: contentHash(payload) };
}

// Reuse the evaluated indices' presentation fields; the DTO never carries baselines or raw evidence.
export function indicesView(indices, now, pressureHistory) {
  if (!indices) return null;
  const p = indices.pressure ?? {}, sl = indices.sleep ?? {};
  // A dashboard shows a recorded result at its own measurement time, under the signature's retention rule.
  const last = indices.pressure ? retainedPressure(indices, now) : null, retained = Boolean(last);
  const displayed = retained ? { ...last, presentation: scorePresentation('pressure', last.score) } : p;
  // The dashboard keeps the daily aggregate as its headline; the signature's title uses the latest result.
  const headline = indices.pressure && indices.features
    ? pressureHeadline(indices, now, pressureHistory, { today: true }) : null;
  return {
    ruleVersion: indices.ruleVersion ?? null,
    textVersion: indices.textVersion ?? null,
    headline,
    evaluatedAt: indices.evaluatedAt ?? null,
    asOfAt: indices.asOfAt ?? null,
    validUntil: indices.validUntil ?? null,
    pressure: {
      score: displayed.score ?? null, state: displayed.presentation?.state ?? null,
      emoji: displayed.presentation?.emoji ?? null, color: displayed.presentation?.color ?? null,
      reason: retained ? null : p.reason ?? null, arrow: retained ? '' : p.trend?.arrow ?? '',
      context: displayed.context ?? null, evidenceAt: displayed.evidenceAt ?? null, retained: Boolean(retained),
      hrvMethod: p.hrvMethod ?? 'SDNN',
      validUntil: retained ? null : p.validUntil ?? (p.evidenceAt == null ? null : p.evidenceAt + 6 * HOUR),
      confidence: displayed.confidence ?? null,
      baselineDays: retained ? null : { hrv: p.hrvBaseline?.days ?? 0, heart: p.heartBaseline?.days ?? 0 },
      baselineRequirement: p.baselineRequirement ?? null,
      components: retained ? null : p.components ?? null,
    },
    sleep: {
      score: sl.score ?? null, state: sl.presentation?.state ?? null,
      emoji: sl.presentation?.emoji ?? null, color: sl.presentation?.color ?? null,
      reason: sl.reason ?? null, date: sl.date ?? null, endAt: sl.endAt ?? null,
      components: sl.components ?? null, baselineDays: sl.baselineDays ?? 0,
      bedtimeDeviationMinutes: sl.bedtimeDeviationMinutes ?? null,
    },
  };
}

function publicationView(p) {
  if (!p) return null;
  return {
    mode: p.mode ?? null, sentTitle: p.sentTitle ?? null,
    lastSentAt: p.lastSentAt ?? null, pending: p.pending ?? false, measuredAt: p.measuredAt ?? null,
  };
}

function normalizeDaily(metric, value, unit) {
  const units = {
    active_energy: { kcal: 1, kJ: 1 / 4.184 },
    walk_run_distance: { km: 1, m: .001, mi: 1.609344 },
    apple_exercise_time: { min: 1, minutes: 1, s: 1 / 60 },
    resting_heart_rate: { bpm: 1, 'count/min': 1 },
    step_count: { count: 1, steps: 1 },
  };
  const canonical = { active_energy: 'kcal', walk_run_distance: 'km', apple_exercise_time: 'min', resting_heart_rate: 'bpm', step_count: 'count' };
  const factor = units[metric]?.[unit];
  return factor === undefined ? { v: null, unit: canonical[metric], reason: 'unsupported_unit' }
    : { v: Math.round(value * factor * 1e6) / 1e6, unit: canonical[metric] };
}
