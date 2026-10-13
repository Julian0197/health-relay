const HOUR = 3600000, DAY = 24 * HOUR;
export const RULES = { version: 'descriptive-v1', lookbackDays: 30, minimumDays: 14, hrvFreshHours: 6, heartFreshMinutes: 90, postWorkoutMinutes: 60, sleepGapMinutes: 90, restingFreshDays: 2 };
const dayOf = time => new Date(time + 8 * HOUR).toISOString().slice(0, 10);
const bandOf = time => Math.floor(new Date(time + 8 * HOUR).getUTCHours() / 6);
const median = values => quantile(values, 0.5);
function quantile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const asleep = new Set(['core', 'deep', 'rem', 'asleep', 'unspecified']);

export function sleepSessions(records) {
  const groups = [];
  for (const row of [...records].sort((a, b) => a.start - b.start)) {
    let group = groups.at(-1);
    if (!group || row.start > group.end + RULES.sleepGapMinutes * 60000) groups.push(group = { start: row.start, end: row.end, records: [] });
    group.end = Math.max(group.end, row.end); group.records.push(row);
  }
  const sessions = groups.filter(g => g.records.some(r => r.stage !== 'in_bed')).map(group => {
    const events = [];
    for (const [i, row] of group.records.entries()) { events.push({ time: row.start, i, add: true }, { time: row.end, i, add: false }); }
    events.sort((a, b) => a.time - b.time);
    const active = new Set(), intervals = [], stages = {};
    let previous = events[0].time, conflict = false, awakeMinutes = 0;
    for (const event of events) {
      if (event.time > previous && active.size) {
        const rows = [...active].map(i => group.records[i]);
        const actual = rows.filter(r => r.stage !== 'in_bed');
        const kinds = new Set(actual.map(r => r.stage));
        const specific = [...kinds].filter(s => ['core', 'deep', 'rem'].includes(s));
        const ambiguous = new Set(actual.map(r => r.source)).size > 1 || specific.length > 1 || actual.length > kinds.size || (kinds.has('awake') && specific.length > 0);
        conflict ||= ambiguous;
        const minutes = (event.time - previous) / 60000;
        if (kinds.has('awake')) awakeMinutes += minutes;
        else if (!ambiguous && [...kinds].some(s => asleep.has(s))) {
          const stage = specific[0] ?? 'asleep';
          stages[stage] = (stages[stage] ?? 0) + minutes;
          intervals.push([previous, event.time]);
        }
      }
      if (event.add) active.add(event.i); else active.delete(event.i);
      previous = event.time;
    }
    const sources = [...new Set(group.records.filter(r => r.stage !== 'in_bed').map(r => r.source))];
    return { start: group.start, end: group.end, date: dayOf(group.end), asleepMinutes: Object.values(stages).reduce((a, b) => a + b, 0),
      awakeMinutes, stages, intervals, sources, conflict, main: false, completeness: 'received_records_only' };
  });
  for (const date of new Set(sessions.map(s => s.date))) {
    const duration = s => s.conflict ? (s.end - s.start) / 60000 : s.asleepMinutes;
    const longest = sessions.filter(s => s.date === date).sort((a, b) => duration(b) - duration(a))[0];
    if (longest) longest.main = true;
  }
  return sessions;
}

function compare(current, entries, referenceTime, source, method) {
  const days = new Map(), date = dayOf(referenceTime);
  for (const row of entries) {
    if (dayOf(row.start) < dayOf(referenceTime - RULES.lookbackDays * DAY) || dayOf(row.start) >= date || row.source !== source || (method && row.method !== method)) continue;
    const key = dayOf(row.start); if (!days.has(key)) days.set(key, []); days.get(key).push(row.value);
  }
  const values = [...days.values()].map(median), center = median(values), q1 = quantile(values, 0.25), q3 = quantile(values, 0.75);
  const baseline = { days: values.length, requiredDays: RULES.minimumDays, median: center, q1, q3, weighting: 'equal_day' };
  const changePercent = center > 0 ? Math.round((current / center - 1) * 1000) / 10 : null;
  return { current, baseline, changePercent, status: values.length >= RULES.minimumDays ? 'comparable' : 'baseline_building',
    position: values.length < RULES.minimumDays ? null : q1 === q3 ? 'flat_baseline' : current < q1 ? 'below_usual' : current > q3 ? 'above_usual' : 'within_usual' };
}
const during = (time, sessions) => sessions.some(s => s.start <= time && time < s.end);
const inSleep = (time, session) => session.intervals.some(([start, end]) => start <= time && time < end);
const exercise = (time, workouts) => workouts.some(w => time >= w.start && time <= w.end + RULES.postWorkoutMinutes * 60000);
const latest = rows => [...rows].sort((a, b) => b.start - a.start)[0];

export function analyze(series, now) {
  const sessions = sleepSessions(series.sleep.filter(s => s.end <= now));
  const hrv = series.hrv.filter(r => r.start <= now && r.value > 0 && r.method === 'SDNN');
  const current = latest(hrv.filter(r => !during(r.start, sessions)));
  let daytime = { status: 'missing', method: 'SDNN' };
  if (current) {
    const entries = hrv.filter(r => !during(r.start, sessions) && !exercise(r.start, series.workout) && bandOf(r.start) === bandOf(current.start));
    daytime = { ...compare(current.value, entries, now, current.source, 'SDNN'), method: 'SDNN', source: current.source,
      measuredAt: current.start, timeBand: `${bandOf(current.start) * 6}–${bandOf(current.start) * 6 + 6}`, context: 'activity_unknown', sourceKnown: current.source !== 'unknown' };
    if (now - current.start > RULES.hrvFreshHours * HOUR) daytime.status = 'stale';
    else if (exercise(current.start, series.workout) || exercise(now, series.workout)) daytime.status = 'exercise_context';
    if (hrv.some(r => r.start === current.start && r.source !== current.source)) daytime.status = 'source_conflict';
    if (daytime.status !== 'comparable') daytime.position = null;
  }
  const main = latest(sessions.filter(s => s.main).map(s => ({ ...s, start: s.end, session: s })))?.session;
  let nightly = { status: 'missing', method: 'SDNN' };
  if (main) {
    const values = hrv.filter(r => inSleep(r.start, main) && !exercise(r.start, series.workout));
    const sources = [...new Set(values.map(r => r.source))];
    const source = sources[0], currentValue = median(values.map(r => r.value));
    const nights = sessions.filter(s => s.main && !s.conflict && s.date < main.date).flatMap(s => {
      const points = hrv.filter(r => r.source === source && inSleep(r.start, s) && !exercise(r.start, series.workout));
      return points.length ? [{ start: s.end, value: median(points.map(r => r.value)), source, method: 'SDNN' }] : [];
    });
    const heart = series.heart.filter(r => inSleep(r.start, main) && r.source === source);
    nightly = { ...(currentValue === null ? { status: 'missing' } : compare(currentValue, nights, main.end, source, 'SDNN')),
      method: 'SDNN', source: source ?? 'unknown', start: main.start, end: main.end, samples: values.length,
      heartMedian: median(heart.map(r => r.value)), heartWindows: heart.length, completeness: 'received_records_only' };
    if (main.conflict || sources.length > 1) nightly.status = 'source_conflict';
    else if (now - main.end > 36 * HOUR) nightly.status = 'stale';
    if (nightly.status !== 'comparable') nightly.position = null;
  }
  const restingRows = series.daily.filter(r => r.metric === 'resting_heart_rate' && r.value > 0 && r.start <= now);
  const rhr = latest(restingRows);
  const resting = rhr ? { ...compare(rhr.value, restingRows, rhr.start, rhr.source), measuredAt: rhr.start, source: rhr.source,
    date: dayOf(rhr.start), previousDay: dayOf(rhr.start) !== dayOf(now) } : { status: 'missing' };
  if (rhr) {
    if (dayOf(rhr.start) < dayOf(now - DAY)) resting.status = 'stale';
    if (restingRows.some(r => dayOf(r.start) === dayOf(rhr.start) && r.source !== rhr.source)) resting.status = 'source_conflict';
    if (resting.status !== 'comparable') resting.position = null;
  }
  const hr = latest(series.heart.filter(r => r.start <= now));
  return { version: RULES.version, rules: RULES, daytime, nightly, resting,
    heart: hr ? { value: hr.value, measuredAt: hr.start, status: now - hr.start > 90 * 60000 ? 'stale' : 'available', context: exercise(hr.start, series.workout) ? 'exercise_context' : 'activity_unknown' } : { status: 'missing' },
    sleep: sessions.filter(s => s.end >= now - 7 * DAY).slice(-7).map(({ intervals, ...s }) => s), scope: 'descriptive_comparison_not_stress_score' };
}
