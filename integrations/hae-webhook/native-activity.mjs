const DAY = 86400000, HOUR = 3600000;

// Summaries of received native records, not HealthKit's cross-device merged totals.
export function summarizeNativeActivity(records, now) {
  const midnight = Math.floor((now + 8 * HOUR) / DAY) * DAY - 8 * HOUR;
  const rows = records.filter(r => r.op !== 'delete').map(r => ({ ...r,
    start: Date.parse(r.start), end: Date.parse(r.end),
  })).filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end <= now);
  const sources = new Map();
  for (const r of rows.filter(r => r.typeIdentifier === 'HKQuantityTypeIdentifierStepCount' &&
    r.start >= midnight && r.payload?.unit === 'count' && Number.isFinite(r.payload.value) && r.payload.value >= 0)) {
    const id = r.source?.id;
    if (!id) continue;
    let group = sources.get(id);
    if (!group) {
      const device = r.source.device;
      group = { source: id, label: device === 'Watch' ? '手表今日' : device === 'iPhone' ? '手机今日' : '今日',
        priority: device === 'Watch' ? 2 : device === 'iPhone' ? 1 : 0, value: 0, measuredAt: r.end };
      sources.set(id, group);
    }
    group.value += r.payload.value; group.measuredAt = Math.max(group.measuredAt, r.end);
  }
  const selected = [...sources.values()].sort((a,b) => b.priority-a.priority || b.measuredAt-a.measuredAt || a.source.localeCompare(b.source))[0];
  const steps = selected ?? { value: null, label: '今日', source: null, measuredAt: null };
  const workouts = rows.filter(r => r.typeIdentifier === 'HKWorkoutType' && r.end > midnight);
  let reason = workouts.length ? null : 'no_records';
  const unique = new Map();
  for (const w of workouts) {
    const seconds = w.payload?.durationSeconds;
    if (w.start < midnight) reason = 'cross_midnight';
    else if (!Number.isFinite(seconds) || seconds < 0 || seconds > (w.end-w.start)/1000 + .001) reason = 'invalid_duration';
    unique.set(JSON.stringify([w.start, w.end, seconds]), { ...w, seconds });
  }
  const ordered = [...unique.values()].sort((a,b) => a.start-b.start);
  let end = -Infinity;
  for (const w of ordered) {
    if (w.start < end) reason = 'overlapping_workouts';
    end = Math.max(end, w.end);
  }
  const seconds = reason ? null : ordered.reduce((sum,w) => sum+w.seconds, 0);
  return { date: new Date(midnight + 8 * HOUR).toISOString().slice(0,10), steps,
    workouts: { durationSeconds: seconds, minutes: seconds === null ? null : Math.floor(seconds/60),
      count: ordered.length, reason, basis: 'recorded_workout_duration' } };
}
