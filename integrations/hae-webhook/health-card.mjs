const LABELS = {
  heart_rate: '心率', resting_heart_rate: '静息心率', heart_rate_variability: 'HRV',
  heart_rate_variability_rmssd: '恢复 HRV（RMSSD）',
  heart_rate_recovery_one_minute: '一分钟心率恢复', vo2_max: '有氧适能',
  walking_heart_rate: '步行平均心率', step_count: '步数', active_energy: '活动能量',
  basal_energy: '静息能量', apple_exercise_time: '锻炼时间', apple_stand_hour: '站立小时',
  walk_run_distance: '步行＋跑步距离', walking_running_distance: '步行＋跑步距离',
  respiratory_rate: '呼吸频率', blood_oxygen_saturation: '血氧饱和度',
  apple_sleeping_wrist_temperature: '夜间腕温', sleep_analysis: '睡眠',
};
const HEART = new Set(['heart_rate', 'resting_heart_rate', 'heart_rate_variability',
  'heart_rate_variability_rmssd', 'heart_rate_recovery_one_minute', 'vo2_max', 'walking_heart_rate']);
const number = n => Math.round(n * 100) / 100;
const escape = s => String(s).slice(0, 120).replace(/[&<>*~[\]()#:_`\\\n\r]/g, ch => `&#${ch.charCodeAt(0)};`);
const displayUnit = unit => ({ 'count/min': '次/分', bpm: '次/分', count: '次', min: '分钟', hr: '小时' })[unit] ?? escape(unit);
const finite = n => typeof n === 'number' && Number.isFinite(n);

export function timeOf(date) {
  if (typeof date !== 'string') return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return Date.parse(`${date}T00:00:00+08:00`);
  const iso = date.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/, '$1T$2$3:$4');
  return /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(iso) ? Date.parse(iso) : NaN;
}

export function localTime(ms) {
  return Number.isFinite(ms) ? new Date(ms + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ') : '时间缺失';
}

function minutesText(minutes) {
  const rounded = Math.round(minutes);
  return rounded >= 60 ? `${Math.floor(rounded / 60)} 小时 ${rounded % 60} 分钟` : `${rounded} 分钟`;
}

function readPoint(metric, point) {
  const time = timeOf(point?.date ?? point?.startDate);
  if (!Number.isFinite(time)) return null;
  const unit = metric.units;
  if (metric.name === 'sleep_analysis') {
    const factor = unit === 'hr' ? 60 : unit === 'min' ? 1 : null;
    const value = point.totalSleep ?? point.asleep ?? (point.startDate ? point.qty : undefined);
    if (!factor || !finite(value) || value < 0) return null;
    const segment = Boolean(point.startDate);
    const details = [];
    for (const [key, label] of [['core', '核心'], ['deep', '深睡'], ['rem', 'REM'], ['awake', '清醒']]) {
      if (finite(point[key]) && point[key] >= 0) details.push(`${label} ${minutesText(point[key] * factor)}`);
    }
    if (point.sleepStart && point.sleepEnd) details.push(`${localTime(timeOf(point.sleepStart))} 至 ${localTime(timeOf(point.sleepEnd))}`);
    return { time, rawValue: value, segment, value: `${segment ? `分段 ${escape(point.value ?? '')} ` : '总时长 '}${minutesText(value * factor)}`, details };
  }
  const value = point.qty ?? point.Avg;
  if (!finite(value)) return null;
  if (['heart_rate', 'resting_heart_rate', 'walking_heart_rate', 'heart_rate_recovery_one_minute'].includes(metric.name) &&
      (!['bpm', 'count/min'].includes(unit) || value < 0)) return null;
  if (['heart_rate_variability', 'heart_rate_variability_rmssd'].includes(metric.name) && (unit !== 'ms' || value < 0)) return null;
  const details = [];
  if (point.qty === undefined && finite(point.Avg)) details.push('窗口均值');
  if (finite(point.Min) && finite(point.Max) && point.Min <= point.Max) details.push(`范围 ${number(point.Min)}–${number(point.Max)} ${displayUnit(unit)}`);
  const steps = metric.name === 'step_count' && unit === 'count';
  return { time, rawValue: value, unit, source: typeof point.source === 'string' ? point.source.slice(0, 200) : 'unknown', value: `${steps ? Math.round(value) : number(value)} ${steps ? '步' : displayUnit(unit)}`, details };
}

function quantity(field) {
  return finite(field?.qty) && typeof field.units === 'string' ? `${number(field.qty)} ${escape(field.units)}` : null;
}

export function summarizeHealth(payload) {
  const data = payload?.data;
  if (!data || (!Array.isArray(data.metrics) && !Array.isArray(data.workouts))) throw new Error('missing health data arrays');
  if ((data.metrics !== undefined && !Array.isArray(data.metrics)) ||
      (data.workouts !== undefined && !Array.isArray(data.workouts))) throw new Error('invalid data array');
  if ((data.metrics?.length ?? 0) > 24) throw new Error('too many metric groups for one card');
  const summary = { samples: 0, skipped: 0, metrics: [], workouts: [], workoutReceived: data.workouts?.length ?? null };
  for (const metric of data.metrics ?? []) {
    if (!metric || typeof metric.name !== 'string' || typeof metric.units !== 'string' || !Array.isArray(metric.data)) throw new Error('invalid metric');
    const row = { name: metric.name, label: LABELS[metric.name] ?? metric.name, received: metric.data.length, accepted: 0, skipped: 0, latest: null, points: [] };
    for (const point of metric.data) {
      const parsed = readPoint(metric, point);
      if (!parsed) { row.skipped++; summary.skipped++; continue; }
      row.accepted++; summary.samples++; row.points.push(parsed);
      if (!row.latest || parsed.time >= row.latest.time) row.latest = parsed;
    }
    summary.metrics.push(row);
  }
  for (const workout of data.workouts ?? []) {
    const start = timeOf(workout?.start), end = timeOf(workout?.end);
    if (typeof workout?.name !== 'string' || !Number.isFinite(start) || !Number.isFinite(end) || end < start || !finite(workout.duration) || workout.duration < 0) {
      summary.skipped++; continue;
    }
    const details = [`时长 ${minutesText(workout.duration / 60)}`];
    for (const [label, field] of [
      ['距离', workout.distance], ['活动能量', workout.activeEnergyBurned],
      ['平均心率', workout.heartRate?.avg ?? workout.avgHeartRate],
      ['最高心率', workout.heartRate?.max ?? workout.maxHeartRate],
    ]) {
      const value = quantity(field);
      if (value !== null) details.push(`${label} ${value}`);
    }
    summary.workouts.push({ id: typeof workout.id === 'string' ? workout.id.slice(0, 120) : `${workout.name}:${start}:${end}`, name: workout.name, start, end, details });
    summary.samples++;
  }
  summary.workouts.sort((a, b) => b.start - a.start);
  if (!summary.samples && summary.skipped) throw new Error('no usable records');
  return summary;
}

const markdown = (content, extra = {}) => ({ tag: 'markdown', content, ...extra });
function block(title, elements, highlight = false) {
  return { tag: 'column_set', flex_mode: 'none', columns: [{
    tag: 'column', width: 'weighted', weight: 1, padding: '12px', vertical_spacing: '8px',
    background_style: highlight ? 'blue-50' : 'grey-50',
    elements: [markdown(`**${title}**`), ...elements],
  }] };
}

const CUMULATIVE = new Set(['step_count', 'active_energy', 'basal_energy', 'apple_exercise_time', 'apple_stand_hour', 'walk_run_distance', 'walking_running_distance']);
const dayOf = ms => localTime(ms).slice(0, 10);
function metricElement(metric, now, fallbackAggregation) {
  const point = metric.latest;
  if (!point) return markdown(`**${escape(metric.label)}：暂缺**`);
  const age = dayOf(point.time) === dayOf(now) ? '' :
    dayOf(point.time) === dayOf(now - 86400000) ? ' · 昨日记录' : ' · 较早记录';
  const daily = (metric.aggregation ?? fallbackAggregation) === 'days';
  const label = metric.name === 'sleep_analysis' ? (point.segment ? '最近睡眠分段' : '睡眠汇总') :
    daily ? (CUMULATIVE.has(metric.name) ? '当日累计' : '当日汇总') :
      ({ raw: '单次测量', hours: '按小时汇总', minutes: '按分钟汇总', seconds: '按秒汇总' })[metric.aggregation ?? fallbackAggregation] ?? '最近记录 · 非全天总量';
  const date = daily ? dayOf(point.time) : localTime(point.time);
  const details = point.details.map(text => daily ? text.replace('窗口均值', '日内均值') : text);
  return markdown(`**${escape(metric.label)}：${point.value}**\n` +
    (details.length ? `${details.join(' · ')}\n` : '') +
    `<font color='grey'>${date} · ${label}${age}</font>`);
}

function comparisonText(label, result, unit) {
  const states = { missing: '暂缺可用数据', baseline_building: '个人基线积累中', stale: '记录已过期，仅供回看',
    exercise_context: '处于已记录运动或运动后窗口，暂不比较', source_conflict: '数据来源冲突，暂不比较' };
  let text = `**${label}：${states[result.status] ?? '个人历史对比'}**`;
  if (result.status === 'comparable') {
    text += `\n当前 ${number(result.current)} ${unit} · 历史中位数 ${number(result.baseline.median)} ${unit}`;
    text += `\n相对变化 ${result.changePercent > 0 ? '+' : ''}${result.changePercent}% · 历史中间 50%：${number(result.baseline.q1)}–${number(result.baseline.q3)} ${unit}`;
  }
  const metadata = [];
  if (result.baseline) metadata.push(`${result.baseline.days} 个可比日／至少 ${result.baseline.requiredDays} 日`);
  if (result.measuredAt) metadata.push(localTime(result.measuredAt));
  if (result.end) metadata.push(`睡眠结束 ${localTime(result.end)}`);
  if (result.samples !== undefined) metadata.push(`睡眠内 HRV ${result.samples} 条`);
  if (result.source === 'unknown') metadata.push('来源未知');
  if (metadata.length) text += `\n<font color='grey'>${metadata.join(' · ')}</font>`;
  return markdown(text);
}

function sleepElements(sessions) {
  const main = sessions.filter(s => s.main).at(-1);
  const selected = main ? sessions.filter(s => s.date === main.date).slice(0, 4) : [];
  return selected.map(s => {
    const stages = Object.entries(s.stages).map(([name, minutes]) => `${({ core: '核心', deep: '深睡', rem: 'REM', asleep: '未分期' })[name]} ${minutesText(minutes)}`);
    return markdown(`**${s.main ? '主睡眠' : '补觉／午睡'}：${s.conflict ? '分段冲突，时长待核对' : minutesText(s.asleepMinutes)}**\n` +
      `${localTime(s.start)} 至 ${localTime(s.end)}\n` +
      (s.conflict ? '' : `${stages.join(' · ')} · 清醒 ${minutesText(s.awakeMinutes)}\n`) +
      `<font color='grey'>起床日 ${s.date} · 仅已收到分段，可随补传修订</font>`);
  });
}

export function buildHealthCard(summary, context = {}) {
  const now = context.now ?? Date.now();
  const metrics = summary.metrics;
  const heart = metrics.filter(m => HEART.has(m.name));
  const sleepDetails = sleepElements(summary.analysis?.sleep ?? []);
  const sleep = metrics.filter(m => m.name === 'sleep_analysis');
  const other = metrics.filter(m => !HEART.has(m.name) && m.name !== 'sleep_analysis');
  const todayWorkouts = summary.workouts.filter(w => dayOf(w.start) === dayOf(now));
  const workoutStatus = summary.workoutReceived === null ? '锻炼尚未接入' :
    todayWorkouts.length ? `今日已同步 ${todayWorkouts.length} 次锻炼` : '今日暂未收到锻炼记录';
  const synced = context.syncedAt ?? now;
  const elements = [block('健康概览', [
    markdown(`## ${dayOf(now)}`),
    markdown(`${metrics.filter(m => m.latest && !(sleepDetails.length && m.name === 'sleep_analysis')).length + (sleepDetails.length ? 1 : 0)} 项指标 · ${workoutStatus}\n<font color='grey'>数据同步于 ${localTime(synced)} · 北京时间</font>`),
  ], true)];
  if (summary.hrvSync?.latestSampleAt || summary.hrvSync?.receivedAt) {
    const sync = summary.hrvSync, lines = [];
    if (sync.latestSampleAt) lines.push(`HRV 最新测量：${localTime(sync.latestSampleAt)}`);
    if (sync.receivedAt) lines.push(`HRV 最近上传：${localTime(sync.receivedAt)}`);
    if (sync.stats) lines.push(`本批新增 ${sync.stats.inserted} · 修订 ${sync.stats.updated} · 已存在 ${sync.stats.unchanged} 条`);
    lines.push('上传成功不表示产生了新测量；重复上传不增加判定样本。');
    elements.push(block('HRV 测量与上传', [markdown(lines.join('\n'))]));
  }
  if (summary.signatureStatus) {
    const result = summary.signatureStatus;
    const reasons = { exercise_context: '已记录运动中或结束后一小时，暂不判压力档位', hrv_expired: '最近合格 HRV 超过六小时',
      baseline_building: '可比历史日不足三日',
      flat_baseline: '历史离散度不足，暂不计算偏离', hrv_missing: '没有合格日间 HRV',
      today_resting_missing_or_conflicting: '缺少同日同源静息心率或数据冲突', source_unknown_or_mixed: '来源未知或混合',
      hrv_conflict: '同一时刻 HRV 冲突', recovery_not_confirmed: '尚无新测量支持状态回落' };
    const label = ({ relaxed: '🟢 状态优秀', balanced: '🔵 状态正常', tense: '🟡 注意压力', high: '🔴 压力过载' })[result.state];
    elements.push(block('动态签名判定', [markdown(label ? `当前候选：${label}` :
      (result.reasons.map(r => reasons[r]).filter(Boolean).join('；') || '暂不生成新的四档结论')),
      ...(result.observation ? [markdown(`最近测量前六小时：合格 HRV ${result.observation.windowSamples} 条 · 跨度 ${Math.round(result.observation.windowSpanMinutes)} 分钟`, { text_size: 'notation' })] : []),
      markdown('使用最新合格单次 HRV 与同日静息心率；两类基线各至少三日试运行，均满十四日转完整基线；下方历史对比是独立的描述统计，不等于签名门槛。', { text_size: 'notation' })]));
  }
  if (sleepDetails.length) elements.push(block('最近睡眠', sleepDetails));
  else if (sleep.length) elements.push(block('最近睡眠', sleep.map(m => metricElement(m, now, context.aggregation))));
  if (heart.length) elements.push(block('心脏与心肺', heart.map(m => metricElement(m, now, context.aggregation))));
  if (other.length) elements.push(block('活动与日常指标', other.map(m => metricElement(m, now, context.aggregation))));
  if (summary.analysis) elements.push(block('个人历史对比', [
    comparisonText('非睡眠 HRV', summary.analysis.daytime, 'ms'),
    comparisonText('主睡眠 HRV 中位数', summary.analysis.nightly, 'ms'),
    comparisonText('每日静息心率', summary.analysis.resting, '次/分'),
    markdown('按过去 30 天比较；HRV 使用 SDNN。未记录到运动不等于静息，变化不直接代表压力或恢复评分。', { text_size: 'notation' }),
  ]));
  const workoutElements = summary.workouts.slice(0, 3).map(w => markdown(`**${escape(w.name)}**\n${w.details.join(' · ')}\n<font color='grey'>${localTime(w.start)} 至 ${localTime(w.end)}</font>`));
  if (!workoutElements.length) workoutElements.push(markdown(summary.workoutReceived === null ? '等待 HAE「锻炼」自动化上传。' : '最近 7 天暂未收到有效锻炼记录；不代表没有运动。'));
  if (summary.workouts.length > 3) workoutElements.push(markdown(`显示最近 3 次，最近 7 天共 ${summary.workouts.length} 次。`));
  elements.push(block('最近锻炼', workoutElements));
  elements.push(markdown('按记录日期查看：当日汇总会随同步更新，最近记录不等于全天均值或总量。睡眠不含清醒时间。旧数据保留日期，缺失不计为零。', { text_size: 'notation' }));
  return {
    schema: '2.0', config: { width_mode: 'default', update_multi: true, summary: { content: `${dayOf(now)} 健康概览 · ${workoutStatus}` } },
    header: { template: 'blue', title: { tag: 'plain_text', content: '🫀 Apple Health · 健康概览' },
      subtitle: { tag: 'plain_text', content: '健康 · 睡眠 · 锻炼｜合并更新' } },
    body: { direction: 'vertical', padding: '12px', vertical_spacing: '12px', elements },
  };
}
