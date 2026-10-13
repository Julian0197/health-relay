// Compact workout facts for the dashboard; no routes, raw payloads or device names.
const MINUTE = 60000, DAY = 86400000;
const finite = n => typeof n === 'number' && Number.isFinite(n);
const round = n => Math.round(n * 100) / 100;
const quantity = (field, units) => finite(field?.qty) && field.qty >= 0 && Object.hasOwn(units, field.units)
  ? round(field.qty * units[field.units]) : null;
const energy = { kcal: 1, kJ: 1 / 4.184 }, pulse = { bpm: 1, 'count/min': 1 };

export function workoutFacts(original) {
  return {
    durationMs: original.duration * 1000,
    activeEnergyKcal: quantity(original.activeEnergyBurned, energy),
    avgHeartRate: quantity(original.heartRate?.avg ?? original.avgHeartRate, pulse),
    maxHeartRate: quantity(original.heartRate?.max ?? original.maxHeartRate, pulse),
  };
}

// Older stored rows retain these facts only as generated summary text.
function legacyQuantity(row, label, units) {
  const text = row.details?.find(text => text.startsWith(`${label} `));
  const match = text?.slice(label.length + 1).match(/^(\d+(?:\.\d+)?) (\S+)$/);
  return match ? quantity({ qty: Number(match[1]), units: match[2] }, units) : null;
}
function sameSource(rows, source) {
  const matching = source && source !== 'unknown' ? rows.filter(r => r.source === source) : rows;
  return new Set(matching.map(r => r.source ?? 'unknown')).size <= 1 ? matching : [];
}
function heartSummary(row, heart) {
  const avg = row.avgHeartRate ?? legacyQuantity(row, '平均心率', pulse);
  const max = row.maxHeartRate ?? legacyQuantity(row, '最高心率', pulse);
  if ((finite(avg) && avg > 0) || (finite(max) && max > 0)) {
    if (finite(avg) && finite(max) && max < avg) return null;
    return { avg: avg > 0 ? avg : null, max: max > 0 ? max : null, basis: 'workout_summary' };
  }
  const dedicated = sameSource((row.heartRateData ?? []).filter(p => p.time >= row.start && p.time <= row.end), row.source);
  if (dedicated.length) return {
    avg: round(dedicated.reduce((n, p) => n + p.avg, 0) / dedicated.length),
    max: Math.max(...dedicated.map(p => p.max ?? p.avg)), basis: 'workout_series', samples: dedicated.length,
  };
  const matching = sameSource(heart.filter(p => p.start >= row.start && p.end <= row.end && p.value > 0), row.source);
  // One completed window per minute prevents overlapping re-exports inflating coverage.
  const minutes = new Map(matching.sort((a, b) => a.start - b.start).map(p => [Math.floor(p.start / MINUTE), p]));
  const points = [...minutes.values()];
  if (!points.length) return null;
  return { avg: round(points.reduce((n, p) => n + p.value, 0) / points.length),
    max: Math.max(...points.map(p => p.max ?? p.value)), basis: 'matched_minutes', coveredMinutes: points.length };
}
function recoverySummary(row, now) {
  const points = sameSource((row.heartRateRecovery ?? []).filter(p => p.time <= now && p.avg > 0 &&
    p.time >= row.end - 15000 && p.time <= row.end + MINUTE + 15000), row.source);
  const nearest = target => points.filter(p => Math.abs(p.time - target) <= 15000)
    .sort((a, b) => Math.abs(a.time - target) - Math.abs(b.time - target))[0];
  const stop = nearest(row.end), minute = nearest(row.end + MINUTE);
  if (!stop || !minute || Math.abs(minute.time - stop.time - MINUTE) > 15000) return null;
  return { drop1m: round(stop.avg - minute.avg), stopBpm: stop.avg, after1mBpm: minute.avg };
}
export function buildWorkoutHistory(series, now) {
  const startAt = now - 30 * DAY;
  const records = (series.workout ?? []).filter(r => r.start >= startAt && r.end <= now)
    .map(r => {
      const recorded = finite(r.durationMs) && r.durationMs >= 0;
      return { name: r.name, start: r.start, end: r.end, durationMs: recorded ? r.durationMs : r.end - r.start,
        durationBasis: recorded ? 'recorded' : 'elapsed',
        activeEnergyKcal: r.activeEnergyKcal ?? legacyQuantity(r, '活动能量', energy),
        heart: heartSummary(r, series.heart ?? []), recovery: recoverySummary(r, now) };
    }).filter(r => r.durationMs >= 20 * MINUTE).sort((a, b) => b.start - a.start);
  return { startAt, endAt: now, minDurationMs: 20 * MINUTE, records };
}
