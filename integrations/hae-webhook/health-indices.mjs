// Personal wellness estimates; not StressWatch's proprietary score or a medical assessment.
import { sleepSessions } from './analysis.mjs';
import { pressureHeadline, renderHealthSignature, scorePresentation, SIGNATURE_TEXT_VERSION } from './health-signature.mjs';
import { scopeHealthSeries, scopePressureSleep } from './health-profile.mjs';
export { scorePresentation } from './health-signature.mjs';
const HOUR = 3600000, DAY = 24 * HOUR;
const RULE_VERSION = 'health-indices-v3-nightly';
// v6 retires the v5 one-day warmup: a provisional score from a single prior day moved with that day's noise.
const RMSSD_RULE_VERSION = 'health-indices-v6-rmssd';
// Qualified prior days each baseline needs before a score is produced.
export const BASELINE_REQUIREMENT = { RMSSD: { hrv: 7, heart: 3 }, SDNN: { hrv: 3, heart: 3 } };
const RMSSD_WINDOW = 20 * 60000;
const clamp = v => Math.max(0, Math.min(1, v));
const day = t => Math.floor((t + 8 * HOUR) / DAY);
const minute = t => ((t + 8 * HOUR) % DAY) / 60000;
const distance = (a, b) => ((a - b + 2160) % 1440) - 720;
const known = source => Boolean(source && source !== 'unknown');
const median = values => {
  const a = [...values].sort((x, y) => x - y), i = Math.floor(a.length / 2);
  return a.length ? a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2 : null;
};
const unique = rows => [...new Map(rows.map(r => [JSON.stringify([r.start, r.end, r.value, r.stage, r.source, r.method]), r])).values()];
function baseline(rows, current, days, logarithmic = false, rmssdCurrent = current.method === 'RMSSD') {
  const groups = new Map();
  for (const r of rows) {
    if (r.source !== current.source || day(r.start) >= day(current.start) || r.start < current.start - days * DAY ||
      Math.abs(distance(minute(r.start), minute(current.start))) > 180) continue;
    const d = day(r.start); if (!groups.has(d)) groups.set(d, []); groups.get(d).push(r);
  }
  // A qualified RMSSD day needs what a current score needs: >=3 HRV samples over >=10 min, or >=10 HR minutes.
  const qualified = g => !rmssdCurrent || (logarithmic
    ? g.length >= 3 && Math.max(...g.map(r => r.start)) - Math.min(...g.map(r => r.start)) >= 10 * 60000
    : g.length >= 10);
  const values = [...groups.values()].filter(qualified)
    .map(g => median(g.map(r => r.value)));
  return summarizeBaseline(values, days, logarithmic);
}
function summarizeBaseline(values, days, logarithmic = false, weighting = 'equal_day') {
  const transformed = logarithmic ? values.map(Math.log) : values;
  const center = median(transformed);
  const mad = center === null ? null : median(transformed.map(v => Math.abs(v - center)));
  // Explicit regularization prevents a nearly flat or three-day history from amplifying tiny changes.
  const scaleFloor = logarithmic ? Math.log(1.15) : 5;
  return { days: values.length, median: center === null ? null : logarithmic ? Math.exp(center) : center,
    center, mad, scale: mad === null ? null : Math.max(1.4826 * mad, scaleFloor), scaleFloor,
    transform: logarithmic ? 'log' : 'identity', weighting, lookbackDays: days };
}
function pressureFromBaselines(hrv, heart, hrvBaseline, heartBaseline) {
  const limit = z => Math.max(-3, Math.min(3, z));
  const hrvZ = limit((hrvBaseline.center - Math.log(hrv)) / hrvBaseline.scale);
  const heartZ = limit((heart - heartBaseline.center) / heartBaseline.scale);
  const combinedZ = 0.6 * hrvZ + 0.4 * heartZ;
  return { components: { hrvZ, heartZ, combinedZ }, score: Math.round(100 / (1 + Math.exp(-combinedZ))) };
}
const usableSleep = s => !s.conflict && s.sources.length === 1 && known(s.sources[0]) && s.asleepMinutes >= 180 &&
  (s.end - s.start) / 60000 - s.asleepMinutes - s.awakeMinutes <= 5;
const inSleep = (t, session) => session.intervals.some(([start, end]) => start <= t && t < end);
function nightlyPressure(sessions, hrv, heart, workouts, now, source, method) {
  const rmssd = method === 'RMSSD';
  const latest = sessions.filter(s => s.main && s.end <= now).at(-1);
  if (!latest || !usableSleep(latest) || now - latest.end < HOUR || now - latest.end >= 36 * HOUR ||
    !known(source) || latest.sources[0] !== source) return null;
  const exercise = t => workouts.some(w => w.start <= t && t <= w.end + HOUR);
  const observations = rows => {
    const groups = new Map();
    for (const r of rows) {
      if (!groups.has(r.start)) groups.set(r.start, []);
      groups.get(r.start).push(r);
    }
    return [...groups.values()].filter(g => g.every(r => r.source === source && r.value === g[0].value))
      .map(g => g.find(r => r.aggregation === 'minutes') ?? g[0]).sort((a, b) => a.start - b.start);
  };
  const hv = observations(hrv), hr = observations(heart);
  const summarize = session => {
    const values = hv.filter(r => inSleep(r.start, session) && !exercise(r.start));
    const windows = hr.filter(r => inSleep(r.start, session) && inSleep(r.end - 1, session) && !exercise(r.start));
    const hrvReady = rmssd ? values.length >= 12 && values.at(-1).start - values[0].start >= 2 * HOUR &&
      new Set(values.map(r => Math.floor(r.start / HOUR))).size >= 3 : values.length > 0;
    const heartReady = rmssd ? windows.length >= 60 && windows.length >= session.asleepMinutes / 2 : windows.length >= 3;
    return { hrv: hrvReady ? median(values.map(r => r.value)) : null,
      heart: heartReady ? median(windows.map(r => r.value)) : null,
      hrvSamples: values.length, heartWindows: windows.length };
  };
  const current = summarize(latest);
  if (current.hrv === null || current.heart === null) return null;
  const history = sessions.filter(s => s.main && s.date < latest.date && s.end >= latest.end - (rmssd ? 28 : 7) * DAY &&
    usableSleep(s) && s.sources[0] === source).map(s => ({ ...summarize(s), end: s.end }));
  const comparable = history.filter(s => s.hrv !== null && s.heart !== null);
  const hrvNights = rmssd ? history.filter(s => s.hrv !== null) : comparable;
  const heartNights = rmssd ? history.filter(s => s.heart !== null && s.end >= latest.end - 7 * DAY) : comparable;
  if (hrvNights.length < (rmssd ? 7 : 3) || heartNights.length < 3) return null;
  const hrvBaseline = summarizeBaseline(hrvNights.map(s => s.hrv), rmssd ? 28 : 7, true, 'equal_night');
  const heartBaseline = summarizeBaseline(heartNights.map(s => s.heart), 7, false, 'equal_night');
  return { ...pressureFromBaselines(current.hrv, current.heart, hrvBaseline, heartBaseline),
    reason: null, context: 'nightly', hrvMethod: method,
    confidence: rmssd && hrvNights.length >= 14 ? 'personal_baseline' : 'short_baseline', activityCoverage: 'workouts_only',
    hrvBaseline, heartBaseline, evidenceAt: latest.end, source, validUntil: latest.end + 36 * HOUR,
    evidence: { ...current, startAt: latest.start, endAt: latest.end, method: 'nightly_medians', completeness: 'received_records_only' } };
}
function sleepIndex(sessions, now) {
  const latest = sessions.filter(s => s.main && s.end <= now).at(-1);
  return scoreSleepSession(latest, sessions, now);
}
export function scoreSleepSession(latest, sessions, now) {
  const result = { score: null, reason: 'missing_sleep', endAt: latest?.end ?? null, components: null };
  if (!latest) return result;
  result.date = latest.date;
  if (now - latest.end < HOUR) return { ...result, reason: 'sleep_settling' };
  if (now - latest.end >= 36 * HOUR) return { ...result, reason: 'expired_sleep' };
  if (!usableSleep(latest)) return { ...result, reason: 'incomplete_or_conflicting_sleep' };
  const previous = sessions.filter(s => s.main && s.date < latest.date && s.end >= latest.end - 13 * DAY &&
    s.sources[0] === latest.sources[0] && usableSleep(s));
  result.baselineDays = previous.length;
  if (previous.length < 3) return { ...result, reason: 'short_sleep_baseline' };
  const onset = minute(latest.intervals[0][0]);
  const deviation = Math.abs(median(previous.map(s => distance(minute(s.intervals[0][0]), onset))));
  const components = {
    duration: 50 * Math.min(latest.asleepMinutes / 480, 1),
    regularity: 30 * clamp(1 - deviation / 120),
    continuity: 20 * latest.asleepMinutes / (latest.asleepMinutes + latest.awakeMinutes),
  };
  return { ...result, score: Math.round(Object.values(components).reduce((a, b) => a + b, 0)), reason: null,
    components, asleepMinutes: latest.asleepMinutes, bedtimeDeviationMinutes: deviation };
}
// Compare published observations, not upload times. Retain the reference when a sample is revised.
function pressureTrend(score, current, previous, context, ruleVersion) {
  const prior = previous?.ruleVersion === ruleVersion ? previous.pressure?.trend : null;
  const last = prior?.lastValid ?? null;
  const reference = last?.at === current?.start ? prior?.reference ?? null : last;
  const comparable = score !== null && reference && reference.at < current.start &&
    current.start - reference.at <= DAY && reference.source === current.source && reference.context === context;
  const delta = comparable ? score - reference.score : null;
  return { reference: comparable ? reference : null,
    lastValid: score === null ? last : { score, at: current.start, source: current.source, context },
    delta, arrow: delta === null || delta === 0 ? '' : delta > 0 ? '↑' : '↓' };
}
export function evaluateHealthIndices(series, now, previous = null, options = {}) {
  const received = series;
  series = scopeHealthSeries(series, options.profile);
  const sleepRows = unique((series.sleep ?? []).filter(r => options.awakeOnly ? r.start <= now : r.end <= now))
    .map(r => options.awakeOnly && r.end > now ? { ...r, end: now } : r);
  const sessions = sleepSessions(sleepRows);
  const pressureSessions = scopePressureSleep(sessions, options.profile);
  const workouts = (series.workout ?? []).filter(r => r.start <= now);
  const excluded = t => sessions.some(s => s.start <= t && t < s.end) || workouts.some(w => w.start <= t && t <= w.end + HOUR);
  const valid = rows => unique(rows ?? []).filter(r => Number.isFinite(r.value) && r.value > 0 && r.start <= now);
  const allHrv = valid(series.hrv);
  // Once RMSSD is in use, missing/stale data must not silently select the old SDNN baseline.
  const method = allHrv.some(r => r.method === 'RMSSD') || previous?.features?.hrv?.method === 'RMSSD' ? 'RMSSD' : 'SDNN';
  const rmssd = method === 'RMSSD', ruleVersion = rmssd ? RMSSD_RULE_VERSION : RULE_VERSION;
  const freshness = rmssd ? 90 * 60000 : 6 * HOUR, requirement = BASELINE_REQUIREMENT[method];
  const hrv = allHrv.filter(r => r.method === method);
  const heart = valid(series.heart).filter(r => r.end <= now);
  // Do not fall back to an older sample when the latest one is sleeping, exercising or ambiguous.
  const current = [...hrv].sort((a, b) => b.start - a.start)[0];
  const alignedWindow = current ? heart.filter(r => r.source === current.source && (rmssd
    ? r.start > current.start - RMSSD_WINDOW && r.start <= current.start
    : Math.abs(r.start - current.start) <= HOUR / 4)) : [];
  const aligned = alignedWindow.filter(r => !excluded(r.start));
  const conflicting = rows => rows.some((r, i) => rows.slice(i + 1).some(s => s.start === r.start && (s.value !== r.value || s.source !== r.source)));
  const cleanHistory = rows => {
    const byTime = new Map();
    for (const r of rows) { if (!byTime.has(r.start)) byTime.set(r.start, []); byTime.get(r.start).push(r); }
    return [...byTime.values()].filter(group => !conflicting(group))
      .map(group => group.find(r => r.aggregation === 'minutes') ?? group[0])
      .filter(r => known(r.source) && !excluded(r.start));
  };
  const hrvHistory = cleanHistory(hrv).filter(r => !rmssd || (r.aggregation ?? 'raw') === (current?.aggregation ?? 'raw'));
  const hrvBaseline = current ? baseline(hrvHistory, current, rmssd ? 28 : 30, true) : { days: 0, median: null };
  const heartBaseline = current ? baseline(cleanHistory(heart), current, 7, false, rmssd) : { days: 0, median: null };
  const recentHrv = current && rmssd ? hrv.filter(r => r.start > current.start - RMSSD_WINDOW && r.start <= current.start &&
    r.source === current.source && (r.aggregation ?? 'raw') === (current.aggregation ?? 'raw')) : [];
  const windowHrv = cleanHistory(recentHrv).filter(r => !excluded((r.end ?? r.start + 1) - 1));
  const hrvSpanMinutes = windowHrv.length ? (Math.max(...windowHrv.map(r => r.start)) - Math.min(...windowHrv.map(r => r.start))) / 60000 : 0;
  const alignedHeart = cleanHistory(aligned);
  const heartValue = aligned.length && !conflicting(aligned) ? median(alignedHeart.map(r => r.value)) : null;
  const hrvValue = rmssd ? median(windowHrv.map(r => r.value)) : current?.value ?? null;
  let pressure = { score: null, reason: null, context: 'awake_sample', hrvMethod: method,
    evidenceAt: current?.start ?? null, source: current?.source ?? null,
    validUntil: current ? current.start + freshness : null,
    evidence: { hrv: hrvValue, heart: heartValue, method: rmssd ? 'trailing_20min_medians' : 'aligned_30min_median',
      ...(rmssd ? { hrvSamples: windowHrv.length, hrvSpanMinutes, heartWindows: alignedHeart.length,
        aggregation: current?.aggregation ?? 'raw' } : {}) },
    activityCoverage: 'workouts_only', components: null, excludedHeartWindows: alignedWindow.length - aligned.length,
    hrvBaseline, heartBaseline, baselineRequirement: requirement, confidence: hrvBaseline.days >= 14 && (!rmssd || heartBaseline.days >= 3)
      ? 'personal_baseline' : 'short_baseline' };
  if (!current) pressure.reason = 'missing_hrv';
  else if (!known(current.source) || conflicting(hrv.filter(r => r.start === current.start)) || (rmssd && conflicting(recentHrv))) pressure.reason = 'source_or_sample_conflict';
  else if (now - current.start >= freshness) pressure.reason = 'expired_hrv';
  else if (excluded(current.start)) pressure.reason = 'sleep_or_workout';
  else if (rmssd && (windowHrv.length < 3 || hrvSpanMinutes < 10)) pressure.reason = 'insufficient_samples';
  else if (heartValue === null) pressure.reason = 'missing_or_conflicting_aligned_hr';
  else if (rmssd && alignedHeart.length < 10) pressure.reason = 'missing_or_conflicting_aligned_hr';
  // One independent prior day enables an explicitly provisional RMSSD estimate.
  else if (hrvBaseline.days < requirement.hrv || heartBaseline.days < requirement.heart) pressure.reason = 'short_baseline';
  else {
    Object.assign(pressure, pressureFromBaselines(hrvValue, heartValue, hrvBaseline, heartBaseline));
  }
  const latestNight = pressureSessions.filter(s => s.main && s.end <= now).at(-1);
  // Validate the completed night's own evidence independently of the latest daytime device.
  const verifiedNight = options.awakeOnly ? null
    : nightlyPressure(pressureSessions, hrv, heart, workouts, now, latestNight?.sources[0], method);
  const night = pressure.reason !== 'source_or_sample_conflict' && verifiedNight?.source === current?.source ? verifiedNight : null;
  const nightlyEvidence = latestNight && !options.awakeOnly ? { evidenceAt: latestNight.end, status: now - latestNight.end >= 36 * HOUR
    ? 'expired' : now - latestNight.end < HOUR ? 'settling' : verifiedNight ? 'available' : 'unavailable' } : null;
  if (pressure.score === null && pressure.reason !== 'source_or_sample_conflict') {
    if (night) pressure = { ...night, primaryReason: pressure.reason };
  }
  const sleep = sleepIndex(sessions, now);
  pressure.deviceEpoch = options.profile?.id ?? null;
  pressure.sourceBasis = pressure.source?.startsWith('hae-profile:') ? 'configured_exporter' : 'reported';
  pressure.presentation = scorePresentation('pressure', pressure.score);
  sleep.presentation = scorePresentation('sleep', sleep.score);
  pressure.trend = pressureTrend(pressure.score, { start: pressure.evidenceAt, source: pressure.source }, previous, pressure.context, ruleVersion);
  // Public HR is the latest received minute window; scoring HR remains time-aligned above.
  const displayRows = valid(received.heart).filter(r => r.end <= now);
  const latestHeart = displayRows.reduce((last, row) => !last || row.start > last.start ? row : last, null);
  const latestRows = latestHeart ? displayRows.filter(r => r.start === latestHeart.start) : [];
  const displayHeart = latestHeart && !conflicting(latestRows) ? { value: latestHeart.value,
    measuredAt: latestHeart.start, startAt: latestHeart.start, endAt: latestHeart.end,
    source: latestHeart.source, method: 'latest_minute_window' } : null;
  const displayedHrvAt = current?.start ?? null;
  const measuredTimes = [displayedHrvAt, displayHeart?.measuredAt].filter(Number.isFinite);
  const asOfAt = measuredTimes.length ? Math.max(...measuredTimes) : sleep.endAt;
  const expiries = [pressure.validUntil, pressure.evidenceAt && pressure.evidenceAt + 45 * 60000, displayHeart && displayHeart.measuredAt + 90 * 60000, current && current.start + freshness, sleep.endAt && sleep.endAt + 36 * HOUR, sleep.endAt && sleep.endAt + HOUR].filter(t => t > now);
  const indices = { mode: 'health-indices-v1', ruleVersion, textVersion: SIGNATURE_TEXT_VERSION, state: 'indices', asOfAt, timeMeaning: 'latest_displayed_measurement', scoreAt: pressure.evidenceAt, displayedHeart: displayHeart, evaluatedAt: now,
    validUntil: expiries.length ? Math.min(...expiries) : null, pressure, sleep, nightlyEvidence,
    features: { hrv: { current: current?.value ?? null, measuredAt: current?.start ?? null, method },
      heart: { current: heartValue, startAt: aligned.length ? Math.min(...aligned.map(r => r.start)) : null,
        endAt: aligned.length ? Math.max(...aligned.map(r => r.end)) : null,
        method: rmssd ? 'trailing_20min_median' : 'aligned_30min_median' } } };
  return { ...indices, headline: pressureHeadline(indices, now, options.pressureHistory),
    title: renderHealthSignature(indices, now, options.pressureHistory) };
}
