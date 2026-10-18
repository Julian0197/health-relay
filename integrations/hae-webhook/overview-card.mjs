// Native Feishu overview for health-indices-v1. Facts and scores are shared with the dashboard.
const DAY = 86400000, HOUR = 3600000;
const finite = Number.isFinite;
const date = ms => new Date(ms + 8 * HOUR).toISOString().slice(0, 10);
const time = ms => finite(ms) ? new Date(ms + 8 * HOUR).toISOString().slice(5, 16).replace('T', ' ') : '暂无测量';
const shortDate = value => value.slice(5).replace('-', '/');
const escape = value => String(value).slice(0, 120).replace(/[&<>*~[\]()#:_`\\\n\r]/g, ch => `&#${ch.charCodeAt(0)};`);
const value = (n, unit = '') => finite(n) ? `${Math.round(n)}${unit}` : '-';
const md = (content, text_size = 'normal') => ({ tag: 'markdown', content, text_size, margin: '0px' });
const note = text => md(`<font color='grey'>${text}</font>`, 'notation');
const column = (elements, background_style = 'default', padding = '0px') => ({
  tag: 'column', width: 'weighted', weight: 1, background_style, padding, vertical_spacing: '4px', elements,
});
const row = columns => ({ tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px', columns });
const tile = (label, number, detail, color = 'grey-900') => column([
  note(label), md(`<font color='${color}'>**${number}**</font>`, 'heading-2'), note(detail),
], 'grey-50', '12px');
const duration = minutes => {
  const n = Math.round(minutes);
  return n >= 60 ? `${Math.floor(n / 60)} 小时 ${n % 60} 分` : `${n} 分钟`;
};
const workoutName = name => escape(({ Running: '跑步', Soccer: '足球', Football: '足球',
  'Traditional Strength Training': '力量训练', 'Functional Strength Training': '功能性力量训练',
  Walking: '步行', Cycling: '骑行', Swimming: '游泳', Hiking: '徒步' })[name] ?? name);

// Never turn missing energy, or overlapping exports, into a misleading daily total.
function energyDays(workouts, now) {
  return Array.from({ length: 7 }, (_, i) => {
    const day = date(now - (6 - i) * DAY);
    const records = workouts.filter(w => date(w.start) === day).sort((a, b) => a.start - b.start);
    const overlap = records.some((w, i) => records.slice(0, i).some(p => p.end > w.start));
    const missing = records.some(w => !finite(w.activeEnergyKcal));
    return { day: shortDate(day), kcal: records.length && !overlap && !missing
      ? Math.round(records.reduce((total, w) => total + w.activeEnergyKcal, 0)) : null,
    reason: overlap ? 'overlap' : missing ? 'missing' : records.length ? null : 'empty' };
  });
}
function workoutBlock(workouts) {
  const latest = [...workouts].sort((a, b) => b.end - a.end || b.start - a.start)[0];
  if (!latest) return row([column([md('**最近锻炼**'), note('近 7 天暂未收到 ≥20 分钟的锻炼。')], 'blue-50', '12px')]);
  const energy = finite(latest.activeEnergyKcal);
  const details = [
    md(`**最近锻炼 · ${workoutName(latest.name)}**`),
    md(`<font color='blue'>**${energy ? value(latest.activeEnergyKcal, ' kcal') : value(latest.durationMs / 60000, ' 分钟')}**</font>`, 'heading-0'),
    note(`${time(latest.start)}–${date(latest.start) === date(latest.end) ? time(latest.end).slice(6) : time(latest.end)}${energy ? ` · ${value(latest.durationMs / 60000, ' 分钟')}` : ''}`),
    row([['平均心率', latest.heart?.avg], ['最高心率', latest.heart?.max]].map(([label, n]) =>
      column([note(label), md(`**${value(n, ' 次/分')}**`)]))),
  ];
  const facts = [];
  if (!energy) facts.push('热量未同步');
  facts.push(finite(latest.recovery?.drop1m) ? `1 分钟恢复 ${value(latest.recovery.drop1m, ' 次/分')}` : '恢复心率未同步');
  if (latest.heart?.basis === 'matched_minutes') facts.push(`心率覆盖 ${latest.heart.coveredMinutes} 分钟`);
  if (latest.durationBasis === 'elapsed') facts.push('时长按起止时间计算');
  details.push(note(facts.join(' · ')));
  if (workouts.some(w => w !== latest && w.start < latest.end && w.end > latest.start)) {
    details.push(note('存在重叠记录，此处展示结束较晚的一条；当日消耗暂不合计。'));
  }
  return row([column(details, 'blue-50', '12px')]);
}
function energyChart(workouts, now) {
  const days = energyDays(workouts, now), values = days.map(({ day, kcal }) => ({ day, kcal }));
  const max = Math.max(100, Math.ceil(Math.max(0, ...values.map(d => d.kcal ?? 0)) * 1.15 / 100) * 100);
  const chart = { tag: 'chart', height: '190px', preview: true, chart_spec: {
    type: 'bar', animation: false, xField: 'day', yField: 'kcal', invalidType: 'break', barMaxWidth: 32,
    data: { id: 'workouts', values, fields: { day: { domain: values.map(d => d.day), sortIndex: 0 } } },
    padding: { top: 20, right: 4, bottom: 0, left: 0 },
    bar: { style: { fill: '#397CF6', cornerRadius: [4, 4, 0, 0] } },
    label: { visible: true, position: 'top', style: { fill: '#1F2329', fontSize: 12 }, smartInvert: false },
    axes: [
      { orient: 'bottom', type: 'band', label: { autoHide: false, autoRotate: false, style: { fontSize: 10 } }, tick: { visible: false }, grid: { visible: false } },
      { orient: 'left', type: 'linear', min: 0, max, tickCount: 3, domainLine: { visible: false }, tick: { visible: false },
        grid: { visible: true, style: { lineDash: [3, 3], stroke: '#E8EAED' } }, label: { style: { fontSize: 10 } } },
    ], legends: { visible: false },
  } };
  const gaps = [['missing', '热量缺失'], ['overlap', '记录重叠']].map(([reason, label]) => {
    const affected = days.filter(d => d.reason === reason).map(d => d.day);
    return affected.length ? `${affected.join('、')} ${label}` : null;
  }).filter(Boolean);
  gaps.push('空白日期未收到完整锻炼消耗，不补零。');
  return row([column([md('**近 7 天锻炼消耗**'),
    note(`${days[0].day}–${days.at(-1).day} · kcal · 仅统计 ≥20 分钟锻炼`), chart, note(gaps.join('；'))])]);
}
export function buildOverviewCard(data, { now = Date.now(), syncedAt = null, dashboardUrl, deviceLabel } = {}) {
  const today = date(now), p = data.healthIndices?.pressure ?? {}, sleep = data.healthIndices?.sleep ?? {};
  const night = data.sleep?.filter(s => s.main !== false && s.date === today && !s.conflict).at(-1);
  const sleepScore = sleep.date === today ? sleep.score : null;
  const heart = data.heart?.latest, hrv = data.recoveryHrv;
  const workouts = (data.workoutHistory?.records ?? []).filter(w => w.durationMs >= 20 * 60000 && w.end <= now &&
    date(w.start) >= date(now - 6 * DAY) && w.start <= now);
  const confidence = ({ short_baseline: '短期基线', personal_baseline: '个人基线' })[p.confidence] ?? '个人基线';
  const pressureColor = ({ relaxed: 'green', balanced: 'blue', elevated: 'orange', high: 'red' })[p.state] ?? 'grey-900';
  const elements = [row([column([
    row([tile('最近压力 · /100', value(p.score), finite(p.score) ? `${time(p.evidenceAt)} · ${confidence}` : '暂无有效记录', pressureColor),
      tile('睡眠评分 · /100', value(sleepScore), night ? `${duration(night.asleepMinutes)} · ${shortDate(today)}` : '今日暂无睡眠记录')]),
    row([tile('心率 · 次/分', value(heart?.value), heart ? `${time(heart.start)} · 窗口均值` : '暂无测量'),
      tile('恢复 HRV · ms', value(hrv?.value), hrv ? `${time(hrv.start)} · RMSSD` : '暂无测量')]),
  ])]), workoutBlock(workouts), energyChart(workouts, now)];
  // Deployment-owned URL only; never accept links or mentions from uploaded metric text.
  if (dashboardUrl) {
    try {
      const url = new URL(dashboardUrl);
      if (url.protocol === 'https:' && !url.username && !url.password) elements.push({
        tag: 'button', type: 'primary', width: 'fill', size: 'medium', margin: '20px 0px 0px 0px',
        text: { tag: 'plain_text', content: '查看完整健康看板 ↗' },
        behaviors: [{ type: 'open_url', default_url: url.href }],
      });
    } catch { /* An invalid optional link must not block health delivery. */ }
  }
  elements.push(note(`来源：${deviceLabel ? `${escape(deviceLabel)} / ` : ''}Apple 健康 · 自动化同步\n评分与看板同源；各指标按自己的测量时间展示。`));
  return {
    schema: '2.0', config: { compact_width: false, width_mode: 'default', update_multi: true,
      summary: { content: `健康速览 · 最近压力 ${value(p.score)} · 睡眠 ${value(sleepScore)}` } },
    header: { template: 'blue', title: { tag: 'plain_text', content: '健康速览' },
      subtitle: { tag: 'plain_text', content: `${today.replaceAll('-', '/')} · 数据同步 ${finite(syncedAt) ? time(syncedAt) : '-'} · 北京时间` } },
    body: { direction: 'vertical', padding: '12px', vertical_spacing: '12px', elements },
  };
}
