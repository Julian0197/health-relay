// Bounded display projection only. Scores and daily medians come from the dashboard.
// Retain no raw history or credentials in this separately cached device response.
const DAY = 86400000, OFFSET = 8 * 3600000;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const rows = value => Array.isArray(value) ? value.map(object) : [];
const number = (value, min, max) => typeof value === 'number' && Number.isFinite(value) &&
  value >= min && value <= max ? value : null;
const metric = (value, min, max) => {
  const valid = number(value, min, max);
  return valid === null ? null : Math.round(valid);
};
const timestamp = value => number(value, 0, 253402214399999);
const dayIndex = now => Math.floor((now + OFFSET) / DAY);
const dateAt = time => new Date(time + OFFSET).toISOString().slice(0, 10);
const dateLabel = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value ? value : '';
const timeLabel = value => timestamp(value) === null ? '' :
  new Date(value + OFFSET).toISOString().slice(5, 16).replaceAll('-', '/').replace('T', ' ');
const onDay = (time, day, now) => timestamp(time) !== null && time <= now && dateAt(time) === day;

function activity(dto, day) {
  const daily = rows(dto.daily).filter(row => row.date === day);
  const metrics = object(daily.length === 1 ? daily[0].metrics : null);
  const value = (key, units, max) => {
    const item = object(metrics[key]), factor = units[item.unit];
    return item.reason || item.conflict || factor === undefined || number(item.v, 0, Infinity) === null
      ? null : metric(item.v * factor, 0, max);
  };
  return {
    steps: value('step_count', { count: 1, steps: 1 }, 200000),
    activeKcal: value('active_energy', { kcal: 1, kJ: 1 / 4.184 }, 20000),
    exerciseMinutes: value('apple_exercise_time', { min: 1, minutes: 1, s: 1 / 60 }, 1440),
    distanceMeters: value('walk_run_distance', { km: 1000, m: 1, mi: 1609.344 }, 2000000),
  };
}

const emptyNight = date => ({ date, total: null, deep: null, core: null, rem: null, awake: null, unknown: null });
const weekDates = now => Array.from({ length: 7 }, (_, i) => dateAt(now - (6 - i) * DAY));

function sleepWeek(dto, now) {
  return weekDates(now).map(date => {
    const nights = rows(dto.sleep).filter(row => row.date === date);
    if (nights.length !== 1) return emptyNight(date);
    const night = nights[0], total = metric(night.asleepMinutes, 0, 1440);
    if (night.conflict || total === null || timestamp(night.end) === null || night.end > now || dateAt(night.end) !== date) {
      return emptyNight(date);
    }
    const stages = object(night.stages);
    const values = ['deep', 'core', 'rem', 'asleep', 'unspecified', 'unknown'].map(key =>
      stages[key] === undefined ? 0 : number(stages[key], 0, 1440));
    const awake = night.awakeMinutes == null ? null : number(night.awakeMinutes, 0, 1440);
    if (values.some(value => value === null) || values.reduce((sum, value) => sum + value, 0) > night.asleepMinutes + 1e-6 ||
        (night.awakeMinutes != null && awake === null) || (awake !== null && night.asleepMinutes + awake > 1440)) {
      return emptyNight(date);
    }
    // Cumulative rounding keeps the four asleep segments equal to the displayed
    // total. Unspecified sleep and any unclassified remainder stay unknown.
    const result = { date, total };
    let cumulative = 0, assigned = 0;
    for (const [index, key] of ['deep', 'core', 'rem'].entries()) {
      cumulative += values[index];
      const end = Math.min(total, Math.round(cumulative));
      result[key] = end - assigned; assigned = end;
    }
    return { ...result, awake: awake === null ? null : Math.round(awake), unknown: total - assigned };
  });
}

const workoutAliases = new Map([
  ['Running', ['running', 'outdoor running', 'indoor running', '跑步', '户外跑步', '室内跑步', '户外 跑步', '室内 跑步']],
  ['Walking', ['walking', 'outdoor walking', 'indoor walking', '步行', '户外步行', '室内步行']],
  ['Cycling', ['cycling', 'outdoor cycling', 'indoor cycling', '骑行', '户外骑行', '室内骑行', '自行车']],
  ['Swimming', ['swimming', 'pool swimming', 'open water swimming', '游泳', '泳池游泳', '泳池 游泳', '开放水域游泳', '开放水域 游泳']],
  ['Hiking', ['hiking', '徒步', '徒步旅行']],
  ['Strength', ['traditional strength training', 'functional strength training', 'strength training', '力量训练', '传统力量训练', '功能性力量训练']],
  ['Football', ['soccer', 'football', '足球']], ['Basketball', ['basketball', '篮球']],
  ['Badminton', ['badminton', '羽毛球']], ['Table Tennis', ['table tennis', '乒乓球']],
  ['Tennis', ['tennis', '网球']], ['Yoga', ['yoga', '瑜伽']], ['Pilates', ['pilates', '普拉提']],
  ['Elliptical', ['elliptical', '椭圆机']], ['Rowing', ['rowing', '划船', '划船机']],
  ['Jump Rope', ['jump rope', '跳绳']], ['Dance', ['dance', 'dancing', '舞蹈']],
  ['HIIT', ['hiit', 'high intensity interval training', '高强度间歇训练']],
].flatMap(([label, aliases]) => aliases.map(alias => [alias, label])));
const workoutType = name => typeof name === 'string'
  ? workoutAliases.get(name.trim().toLowerCase().replace(/\s+/g, ' ')) ?? 'Other' : 'Other';

function recordedWorkouts(records, day, now) {
  if (!Array.isArray(records)) return { workoutCount: null, workoutMinutes: null, workoutKcal: null, workoutTypes: [] };
  const completed = rows(records).filter(row => onDay(row.end, day, now) &&
    timestamp(row.start) !== null && row.start <= row.end);
  // The input is the existing normalized store, not the dashboard's 20-minute
  // workout history. Preserve pauses via durationMs; never substitute elapsed time.
  const total = (key, factor, max) => completed.some(row => number(row[key], 0, max / factor) === null)
    ? null : metric(completed.reduce((sum, row) => sum + row[key], 0) * factor, 0, max);
  const types = [...new Set(completed.map(row => workoutType(row.name)))];
  return { workoutCount: metric(completed.length, 0, 100),
    workoutMinutes: total('durationMs', 1 / 60000, 1440),
    workoutKcal: total('activeEnergyKcal', 1, 10000),
    workoutTypes: types.length > 8 ? [...types.slice(0, 7), 'More'] : types };
}

export function createBadgeCache(dto, now, { workouts } = {}) {
  dto = object(dto);
  const day = dateAt(now);
  const indices = object(dto.healthIndices), pressure = object(indices.pressure), sleep = object(indices.sleep);
  const heart = object(object(dto.heart).latest);
  const selectedMethod = pressure.hrvMethod ?? 'SDNN';
  const validMethod = ['RMSSD', 'SDNN'].includes(selectedMethod);
  const method = validMethod ? selectedMethod : 'SDNN';
  const hrvRows = validMethod ? rows(dto[method === 'RMSSD' ? 'recoveryHrv' : 'hrv']) : [];
  const latestHrv = hrvRows.filter(row => timestamp(row.t) !== null && row.t <= now &&
    number(row.v, 1, 1000) !== null).sort((a, b) => b.t - a.t)[0] ?? {};
  const sleepRows = rows(dto.sleep).filter(row => row.date === day &&
    timestamp(row.end) !== null && row.end <= now);
  const sleepRow = sleepRows.sort((a, b) => (timestamp(b.end) ?? 0) - (timestamp(a.end) ?? 0))[0] ?? {};
  const history = new Map(rows(object(dto.pressureHistory).days)
    .filter(row => dateLabel(row.date)).map(row => [row.date, row]));
  const trend = Array.from({ length: 7 }, (_, i) => {
    const row = history.get(dateAt(now - (6 - i) * DAY));
    return row?.status === 'available' ? metric(row.median, 0, 100) : null;
  });
  // indicesView already selects the current or valid retained observation. A trend
  // reference or a raw historical row must not override that authoritative choice.
  const score = timestamp(pressure.evidenceAt) !== null && pressure.evidenceAt <= now ? metric(pressure.score, 0, 100) : null;
  const heartValue = metric(heart.v, 1, 300), hrv = metric(latestHrv.v, 1, 1000);
  const sleepScore = dateLabel(sleep.date) === day &&
    (timestamp(sleep.endAt) === null || sleep.endAt <= now) ? metric(sleep.score, 0, 100) : null;
  const sleepMinutes = sleepRow.conflict ? null : metric(sleepRow.asleepMinutes, 0, 1440);
  const hasSleep = sleepScore !== null || sleepMinutes !== null;
  const measurements = [score !== null ? pressure.evidenceAt : null, heartValue !== null ? heart.s : null,
    hrv !== null ? latestHrv.t : null, sleepScore !== null ? sleep.endAt : null,
    sleepMinutes !== null ? sleepRow.end : null].filter(value => timestamp(value) !== null && value <= now);
  const pressureValidUntil = timestamp(pressure.validUntil);
  return { version: 3, generatedAt: now, pressureValidUntil, payload: {
    v: 3, online: true, demo: false,
    asOf: measurements.length ? timeLabel(Math.max(...measurements)) : '',
    pressure: score, retained: score !== null && (pressure.retained === true || dateAt(pressure.evidenceAt) !== day ||
      (pressureValidUntil !== null && now >= pressureValidUntil)),
    pressureAt: score !== null ? timeLabel(pressure.evidenceAt) : '',
    heart: heartValue, heartAt: heartValue !== null ? timeLabel(heart.s) : '',
    hrv, hrvMethod: method, hrvAt: hrv !== null ? timeLabel(latestHrv.t) : '',
    sleepScore, sleepMinutes, sleepDate: hasSleep ? day : '', trend, day, sleepWeek: sleepWeek(dto, now),
    ...recordedWorkouts(workouts, day, now), ...activity(dto, day),
  } };
}

export function readBadgeCache(cache, now) {
  if (![2, 3].includes(cache?.version) || !cache.payload) return null;
  // A GET adjusts dated presentation using saved facts, without re-scoring or I/O.
  const elapsedDays = Math.max(0, Math.min(7, dayIndex(now) - dayIndex(cache.generatedAt)));
  const payload = { ...cache.payload,
    retained: cache.payload.pressure !== null && (cache.payload.retained ||
      (cache.pressureValidUntil !== null && now >= cache.pressureValidUntil)),
    trend: [...cache.payload.trend.slice(elapsedDays), ...Array(elapsedDays).fill(null)],
  };
  if (cache.version === 3) {
    payload.workoutTypes = [...payload.workoutTypes];
    const nights = new Map(rows(payload.sleepWeek).map(night => [night.date, night]));
    payload.sleepWeek = weekDates(now).map(date => ({ ...(nights.get(date) ?? emptyNight(date)) }));
  }
  if (payload.day !== dateAt(now)) {
    Object.assign(payload, { day: dateAt(now),
      sleepScore: null, sleepMinutes: null, sleepDate: '', workoutCount: null, workoutMinutes: null,
      workoutKcal: null, steps: null, activeKcal: null, exerciseMinutes: null, distanceMeters: null });
    if (cache.version === 3) { payload.retained = payload.pressure !== null; payload.workoutTypes = []; }
    else Object.assign(payload, { pressure: null, retained: false, pressureAt: '' });
  }
  return payload;
}
