import { localTime } from './health-card.mjs';

export const emptyState = () => ({ metrics: [], workouts: [], streams: {}, lastReceivedAt: null });
const dayOf = time => localTime(time).slice(0, 10);
const inRange = (time, now) => dayOf(time) >= dayOf(now - 6 * 86400000) && time <= now;
const metricKey = m => `${m.name}|${dayOf(m.latest.time)}|${m.aggregation}`;

export function mergeSummary(previous, summary, { stream, aggregation, now }) {
  const state = structuredClone(previous);
  const metrics = new Map(state.metrics.filter(m => inRange(m.latest.time, now)).map(m => [metricKey(m), m]));
  const seenDaily = new Set();
  for (const row of summary.metrics) {
    for (const point of row.points) {
      const dailyKey = `${row.name}|${dayOf(point.time)}`;
      if (aggregation === 'days') {
        const reason = seenDaily.has(dailyKey) ? 'multiple_records_per_day'
          : point.segment ? 'sleep_segment'
          : row.name === 'step_count' && point.rawValue < 0 ? 'negative_steps' : null;
        if (reason) {
          const error = new Error('daily_aggregation_required');
          error.details = { reason, metric: /^[a-z0-9_]{1,80}$/.test(row.name) ? row.name : 'unknown' };
          throw error;
        }
      }
      seenDaily.add(dailyKey);
      if (!inRange(point.time, now)) continue;
      const item = { name: row.name, label: row.label, aggregation, latest: point };
      const key = metricKey(item);
      if (!metrics.has(key) || point.time >= metrics.get(key).latest.time) metrics.set(key, item);
    }
  }
  if (new Set([...metrics.values()].map(m => m.name)).size > 24) throw new Error('too_many_metrics');
  state.metrics = [...metrics.values()];
  const workouts = new Map(state.workouts.filter(w => inRange(w.start, now)).map(w => [w.id, w]));
  for (const workout of summary.workouts) if (inRange(workout.start, now)) workouts.set(workout.id, workout);
  // A small personal overview, not a raw HealthKit archive.
  if (workouts.size > 100) throw new Error('too_many_workouts');
  state.workouts = [...workouts.values()];
  state.streams[stream] = { receivedAt: now, samples: summary.samples, skipped: summary.skipped, aggregation };
  if (summary.workoutReceived !== null) state.workoutsReceivedAt = now;
  state.lastReceivedAt = now;
  return state;
}

export function overview(state, now) {
  const latest = new Map();
  for (const item of state.metrics.filter(m => inRange(m.latest.time, now))) {
    const old = latest.get(item.name);
    const newDay = dayOf(item.latest.time), oldDay = old && dayOf(old.latest.time);
    if (!old || newDay > oldDay || (newDay === oldDay && (
      (item.aggregation === 'days' && old.aggregation !== 'days') ||
      (item.aggregation === old.aggregation && item.latest.time > old.latest.time) ||
      (item.aggregation !== 'days' && old.aggregation !== 'days' && item.latest.time > old.latest.time)
    ))) latest.set(item.name, item);
  }
  return {
    date: dayOf(now), metrics: [...latest.values()].sort((a, b) => a.name.localeCompare(b.name)),
    workouts: state.workouts.filter(w => inRange(w.start, now)).sort((a, b) => b.start - a.start || a.id.localeCompare(b.id)),
    workoutReceived: state.workoutsReceivedAt ? 0 : null,
  };
}

export async function fingerprint(summary) {
  // Keep receipt timestamps and parsing counters out of content deduplication.
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(summary)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
