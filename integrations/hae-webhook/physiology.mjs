import { formatPhysiologyTitle, formatNeutralHeading, selectSignatureCopy, formatSignatureMetrics } from './signature-phrases.mjs';
// Experimental personal comparison, not a clinical pressure or recovery score.
// Daytime SDNN and daily resting HR are compared independently to matching personal history.
const HOUR = 3600000, DAY = 24 * HOUR;
const day = t => new Date(t + 8 * HOUR).toISOString().slice(0, 10);
const median = values => {
  const a = [...values].sort((x, y) => x - y), n = a.length;
  return n ? (a[Math.floor((n - 1) / 2)] + a[Math.floor(n / 2)]) / 2 : null;
};
const valid = r => Number.isFinite(r.start) && Number.isFinite(r.value) && r.value > 0;
const known = source => Boolean(source && source !== 'unknown');
const enough = rows => rows.length >= 2 && rows.at(-1).start - rows[0].start >= HOUR / 2;
const measurement = row => `${row.source}:${row.start}`;
export const PHYSIOLOGY_RULE_VERSION = 'physiology-v2-latest-sample-3day';

function unique(rows) {
  const times = new Map();
  for (const r of rows) {
    const old = times.get(r.start);
    if (old && (old.source !== r.source || old.value !== r.value)) return null;
    times.set(r.start, r);
  }
  return [...times.values()].sort((a, b) => a.start - b.start);
}

function compare(current, history, log) {
  const values = history.map(v => log ? Math.log(v) : v);
  const center = median(values);
  const scale = center === null ? null : 1.4826 * median(values.map(v => Math.abs(v - center)));
  const transformed = log ? Math.log(current) : current;
  const baseline = log && center !== null ? Math.exp(center) : center;
  return { current, baselineDays: values.length, baseline, scale,
    z: scale > 1e-6 ? (transformed - center) / scale : null,
    changePercent: baseline > 0 ? (current / baseline - 1) * 100 : null };
}
const hrvLow = f => f.z <= -1.5 && f.changePercent <= -20;
const rhrHigh = f => f.z >= 1.5 && f.current - f.baseline >= 5;

export function evaluatePhysiology(series, now, previous = null, { minimumHistorySamples = 2 } = {}) {
  const out = { ruleVersion: PHYSIOLOGY_RULE_VERSION, state: 'insufficient', candidate: null,
    scope: 'daytime_hrv_and_daily_resting_hr', features: {}, reasons: [], evidenceIds: [],
    measuredAt: null, validUntil: null, confirmation: null, evaluatedAt: now,
    recoveryAfter: previous?.state === 'high' ? previous.measuredAt : previous?.recoveryAfter ?? null };
  const finish = (state, reason, deadline = out.validUntil) => {
    out.state = state; out.validUntil = deadline; if (reason) out.reasons.push(reason);
    out.title = formatPhysiologyTitle(out);
    if (out.title) out.copy = selectSignatureCopy(out.measuredAt, state);
    return out;
  };
  const workouts = series.workout.filter(w => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start);
  const latestWorkout = workouts.filter(w => w.end <= now).sort((a, b) => b.end - a.end)[0];
  const excludedBy = t => series.sleep.some(s => s.start <= t && t < s.end) ? 'sleep' :
    workouts.some(w => w.start <= t && t < w.end + HOUR) ? 'workout' : null;
  const contextExcluded = t => Boolean(excludedBy(t));
  const rows = series.hrv.filter(r => valid(r) && r.start <= now && r.method === 'SDNN').sort((a, b) => a.start - b.start);
  const last = rows.filter(r => !contextExcluded(r.start)).at(-1);
  const window = last ? rows.filter(r => r.start > last.start - 6 * HOUR && !contextExcluded(r.start)) : [];
  out.observation = { latestSampleAt: rows.at(-1)?.start ?? null,
    latestEligibleAt: last?.start ?? null, windowSamples: unique(window)?.length ?? 0,
    windowSpanMinutes: window.length ? (window.at(-1).start - window[0].start) / 60000 : 0,
    recentSamples: rows.filter(r => r.start > now - 3 * DAY).slice(-24)
      .map(r => ({ time: r.start, originalTime: r.originalTime ?? null, value: r.value, source: r.source, excludedBy: excludedBy(r.start) })) };
  if (workouts.some(w => w.start <= now && now < w.end)) return finish('insufficient', 'exercise_context');
  if (latestWorkout && now < latestWorkout.end + HOUR) {
    out.measuredAt = latestWorkout.end;
    out.evidenceIds = [latestWorkout.key ?? latestWorkout.id].filter(Boolean);
    return finish('post_workout', 'exercise_context', latestWorkout.end + HOUR);
  }
  out.measuredAt = last?.start ?? null;
  if (!last) return finish('insufficient', 'hrv_missing');
  if (now >= last.start + 6 * HOUR) return finish('stale', 'hrv_expired');
  // Anchor the window to a measurement, so delayed uploads and alarms do not change its membership.
  const anchor = last.start;
  const current = unique(rows.filter(r => r.start > anchor - 6 * HOUR && !contextExcluded(r.start)));
  if (!current) return finish('insufficient', 'hrv_conflict');
  const source = current[0].source;
  if (!known(source) || current.some(r => r.source !== source)) return finish('insufficient', 'source_unknown_or_mixed');
  out.measuredAt = current.at(-1).start;
  out.validUntil = last.start + 6 * HOUR;
  out.evidenceIds.push(...current.map(r => r.key).filter(Boolean));
  const restingRows = series.daily.filter(r => valid(r) && r.start <= now && r.metric === 'resting_heart_rate');
  // Pair by measurement day; delayed uploads must not require tomorrow's resting HR.
  const sameDay = restingRows.filter(r => day(r.start) === day(anchor));
  const rest = sameDay.find(r => r.source === source);
  if (!rest || sameDay.some(r => r.source !== source || r.value !== rest.value)) return finish('insufficient', 'today_resting_missing_or_conflicting');
  out.evidenceIds.push(...sameDay.map(r => r.key).filter(Boolean));
  const hrvDays = [], restDays = [], historyCoverage = [];
  for (let d = 1; d <= 30; d++) {
    const end = anchor - d * DAY, start = end - 6 * HOUR;
    const points = unique(rows.filter(r => r.start > start && r.start <= end && r.source === source &&
      day(r.start) < day(anchor - 6 * HOUR) && !contextExcluded(r.start)));
    if (points?.length) {
      const used = minimumHistorySamples === 1 || enough(points);
      const value = median(points.map(r => r.value));
      historyCoverage.push({ date: day(end), samples: points.length, value, used });
      if (used) hrvDays.push(value);
    }
    const daily = restingRows.filter(r => day(r.start) === day(end) && r.source === source);
    if (daily.length && daily.every(r => r.value === daily[0].value)) restDays.push(daily[0].value);
  }
  const h = out.features.hrv = { ...compare(last.value, hrvDays, true), currentAggregation: 'latest_sample',
    historyCoverage, minimumHistorySamples, latest: current.at(-1).value, samples: current.length, source, start: current[0].start, end: current.at(-1).start };
  const r = out.features.resting = { ...compare(rest.value, restDays, false), source, date: day(rest.start) };
  out.baselinePhase = Math.min(h.baselineDays, r.baselineDays) >= 14 ? 'established' : 'provisional';
  if (h.baselineDays < 3 || r.baselineDays < 3) return finish('learning', 'baseline_building');
  if (h.z === null || r.z === null) return finish('insufficient', 'flat_baseline');
  const low = hrvLow(h), high = rhrHigh(r);
  const different = low || high;
  const relaxed = h.z >= 0.5 && h.changePercent >= 10 && h.changePercent <= 100 &&
    r.z <= -0.5 && r.current - r.baseline <= -3;
  if (low) out.reasons.push('hrv_below_personal_range');
  if (high) out.reasons.push('resting_above_personal_range');
  if (!(low && high)) {
    // A changed rolling window alone is not proof of recovery.
    const hasNew = current.some(p => p.start > (out.recoveryAfter ?? -Infinity));
    if (out.recoveryAfter !== null && !different && !hasNew) return finish('insufficient', 'recovery_not_confirmed');
    if (!different && hasNew) out.recoveryAfter = null;
    return finish(different ? 'tense' : relaxed ? 'relaxed' : 'balanced',
      different ? 'individual_metric_change' : relaxed ? 'both_signals_favorable' : 'within_personal_range');
  }
  out.candidate = 'high';
  const old = previous?.ruleVersion === PHYSIOLOGY_RULE_VERSION && previous.validUntil > now &&
    previous.features?.hrv?.source === source ? previous.confirmation : null;
  const ids = current.map(measurement);
  const added = old ? current.filter(p => !old.measurements.includes(measurement(p)) && p.start > old.latestMeasurement) : [];
  const freshSupportsLow = added.length > 0 && added.every(p => hrvLow({
    z: (Math.log(p.value) - Math.log(h.baseline)) / h.scale, changePercent: (p.value / h.baseline - 1) * 100 }));
  const confirmed = Boolean(old?.confirmed || old && now - old.startedAt >= HOUR / 2 &&
    added.some(p => p.start - old.latestMeasurement >= HOUR / 2) && freshSupportsLow);
  out.confirmation = { startedAt: old?.startedAt ?? now, latestMeasurement: old?.latestMeasurement ?? current.at(-1).start,
    measurements: [...new Set([...(old?.measurements ?? []), ...ids])], confirmed };
  return finish(confirmed ? 'high' : 'tense', confirmed ? 'new_measurement_confirmed' : 'awaiting_new_measurement');
}

// Describes this dated sample against personal history; it never votes for a pressure tier.
function describeHrvSample(series, rows, last) {
  const excluded = time => series.sleep.some(s => s.start <= time && time < s.end) ||
    series.workout.some(w => w.start <= time && time < w.end + HOUR);
  if (excluded(last.start)) return null;
  const history = [];
  for (let d = 1; d <= 30; d++) {
    const end = last.start - d * DAY;
    const points = unique(rows.filter(r => r.source === last.source && r.start > end - 6 * HOUR && r.start <= end && !excluded(r.start)));
    if (points?.length) history.push({ date: day(end), samples: points.length, value: median(points.map(r => r.value)) });
  }
  if (history.length < 3) return null;
  const baseline = median(history.map(d => d.value)), changePercent = (last.value / baseline - 1) * 100;
  return { version: 'hrv-observation-v1', position: changePercent >= 20 ? 'above' : changePercent <= -20 ? 'below' : 'usual',
    current: last.value, baseline, baselineDays: history.length, changePercent, historyCoverage: history,
    measuredAt: last.start, source: last.source, scope: 'personal_sample_comparison_not_pressure', thresholdPercent: 20 };
}

// Factual fallback: a personal HRV comparison is distinct from a four-level decision.
export function neutralPhysiology(series, now) {
  const out = { ruleVersion: PHYSIOLOGY_RULE_VERSION, state: 'neutral', title: null,
    measuredAt: null, evaluatedAt: now, validUntil: null, features: {}, evidenceIds: [] };
  const rows = series.hrv.filter(r => valid(r) && r.start <= now && r.method === 'SDNN').sort((a, b) => a.start - b.start);
  const last = rows.at(-1);
  if (!last || !known(last.source) || !unique(rows.filter(r => r.start === last.start))) return out;
  const resting = series.daily.filter(r => valid(r) && r.start <= now && r.metric === 'resting_heart_rate' && day(r.start) === day(last.start));
  const rest = resting.find(r => r.source === last.source);
  const usableRest = rest && resting.every(r => r.source === rest.source && r.value === rest.value);
  out.measuredAt = last.start;
  out.features.hrv = { latest: last.value, source: last.source };
  if (usableRest) out.features.resting = { current: rest.value, date: day(rest.start), source: rest.source };
  out.evidenceIds = [last.key, ...(usableRest ? resting.map(r => r.key) : [])].filter(Boolean);
  out.sampleContext = series.sleep.some(s => s.start <= last.start && last.start < s.end) ? 'sleep'
    : series.workout.some(w => w.start <= last.start && last.start < w.end + HOUR) ? 'workout' : 'unclassified';
  const comparison = describeHrvSample(series, rows, last);
  if (comparison) {
    out.presentation = 'hrv_comparison';
    out.hrvComparison = comparison;
    out.copy = selectSignatureCopy(comparison.measuredAt, comparison.position);
  }
  out.title = formatNeutralHeading(out);
  return withLatestHeartOverview(out, series.heart ?? [], now);
}

// Display-only enrichment. Never replace the HRV decision time or use ordinary HR to score a tier.
export function withLatestHeartOverview(decision, hearts, now) {
  if (!decision.title || !decision.features.hrv) return decision;
  const out = { ...decision, features: { ...decision.features }, evidenceIds: [...decision.evidenceIds] };
  const heartRows = hearts.filter(r => valid(r) && r.start <= now && r.end <= now &&
    r.start >= decision.measuredAt - 15 * 60000 && r.source === decision.features.hrv.source);
  const latestHeart = heartRows.reduce((latest, row) => !latest || row.start > latest.start ? row : latest, null);
  const heart = latestHeart && unique(heartRows.filter(r => r.start === latestHeart.start))?.[0];
  if (heart) {
    out.features.heart = { current: heart.value, measuredAt: heart.start, source: heart.source,
      aggregation: 'minutes', alignment: 'latest_available_same_source' };
    if (heart.key) out.evidenceIds.push(heart.key);
  }
  out.asOfAt = Math.max(out.measuredAt, heart?.start ?? -Infinity);
  out.timeMeaning = 'latest_displayed_measurement';
  out.title = out.state === 'neutral'
    ? `${formatNeutralHeading(out)}\n${formatSignatureMetrics(out)}`
    : formatPhysiologyTitle(out);
  return out;
}
