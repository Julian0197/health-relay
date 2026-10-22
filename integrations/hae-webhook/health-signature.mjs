// Presentation only. Scores and daily aggregates are supplied by the scorer/store.
const MINUTE = 60000, HOUR = 60 * MINUTE;
// The signature names only the state; whether it is today's, current or historical is shown on the dashboard.
export const SIGNATURE_TEXT_VERSION = 'health-signature-text-v1';
export const STATUS_SIGNATURE_TEXT_VERSION = 'health-status-signature-text-v5';
export const RETAINED_PRESSURE_MS = 7 * 24 * HOUR;
export const PRESSURE_LABELS = { relaxed: '状态优秀', balanced: '状态正常', elevated: '注意压力', high: '压力过载' };
const labels = PRESSURE_LABELS;
const statusEmojis = { relaxed: '🌟', balanced: '🌿', elevated: '⚡', high: '🚨',
  excellent: '💤', good: '🌜', fair: '🌓', rest_needed: '🌑' };
const dateKey = time => new Date(time + 8 * HOUR).toISOString().slice(0, 10);
const stamp = time => Number.isFinite(time)
  ? new Date(time + 8 * HOUR).toISOString().slice(5, 16).replace('-', '/').replace('T', ' ') : '—';

export function scorePresentation(kind, score) {
  if (!Number.isFinite(score)) return { color: '⚪', emoji: '⚪', state: 'unavailable' };
  if (kind === 'pressure') {
    if (score <= 25) return { color: '🟢', emoji: '😌', state: 'relaxed' };
    if (score <= 60) return { color: '🔵', emoji: '🙂', state: 'balanced' };
    if (score <= 80) return { color: '🟡', emoji: '😮‍💨', state: 'elevated' };
    return { color: '🔴', emoji: '😵‍💫', state: 'high' };
  }
  if (score >= 80) return { color: '🟢', emoji: '😴', state: 'excellent' };
  if (score >= 60) return { color: '🔵', emoji: '🙂', state: 'good' };
  if (score >= 40) return { color: '🟡', emoji: '🥱', state: 'fair' };
  return { color: '🔴', emoji: '🛌', state: 'rest_needed' };
}

// A recorded result from the same rule and device, never reused after a correction at its own anchor.
export function retainedPressure(indices, now) {
  const p = indices.pressure, last = indices.lastValidPressure;
  if (Number.isFinite(p.score) || !last || last.ruleVersion !== indices.ruleVersion || last.source !== p.source ||
    !Number.isFinite(last.score) || !Number.isFinite(last.evidenceAt) || last.evidenceAt > now ||
    now - last.evidenceAt >= RETAINED_PRESSURE_MS) return null;
  return last.evidenceAt !== p.evidenceAt || p.reason === 'expired_hrv' ? last : null;
}

// Which pressure result is shown, shared by the signature and the dashboard headline:
// today's aggregate > the current result (or last night's) > a retained historical result >
// baseline still building > missing. Each keeps its own measurement time.
export function pressureHeadline(indices, now, history = null, { today = true } = {}) {
  const p = indices.pressure, method = indices.features.hrv.method ?? p.hrvMethod ?? 'SDNN';
  const todayRow = today ? history?.days.find(d =>
    d.date === dateKey(now) && d.status === 'available' &&
    d.ruleVersion === indices.ruleVersion && Number.isFinite(d.median) &&
    (!d.method || d.method === method) && (!d.deviceEpoch || d.deviceEpoch === p.deviceEpoch) &&
    (p.deviceEpoch ? d.sourceScope === `hae-profile:${p.deviceEpoch}` : !d.sourceScope)) : null;
  const result = (basis, score, fields) => {
    const presentation = scorePresentation('pressure', score);
    return { version: SIGNATURE_TEXT_VERSION, basis, score, state: presentation.state, color: presentation.color,
      label: labels[presentation.state], evidenceAt: null, date: null, reason: null, ...fields };
  };
  if (todayRow) return result('today_median', todayRow.median, { date: todayRow.date, count: todayRow.count });
  if (Number.isFinite(p.score)) return result(p.context === 'nightly' ? 'nightly' : 'current', p.score, { evidenceAt: p.evidenceAt });
  const last = retainedPressure(indices, now);
  if (last) return result('retained', last.score, { evidenceAt: last.evidenceAt, context: last.context, reason: p.reason });
  const buildingBaseline = p.reason === 'short_baseline' || (['expired_hrv', 'insufficient_samples'].includes(p.reason) &&
    (p.hrvBaseline.days < (p.baselineRequirement?.hrv ?? 3) || p.heartBaseline.days < (p.baselineRequirement?.heart ?? 3)));
  return { ...result(buildingBaseline ? 'building_baseline' : 'missing', null, { reason: p.reason }), label: null };
}

// Public LAN signature: state words with their scoring HRV, sleep score, activity and committed-sync time.
export function renderStatusSignature(indices, now, activity = null, syncedAt = null) {
  const headline = pressureHeadline(indices, now, null, { today: false });
  const prefix = { nightly: '夜间', retained: '上次' }[headline.basis] ?? '';
  const hrv = headline.basis === 'retained' ? indices.lastValidPressure?.hrv : indices.pressure.evidence?.hrv;
  const hrvText = Number.isFinite(hrv) && hrv > 0 ? Math.round(hrv * 10) / 10 : '暂无';
  const hrvLabel = (indices.features.hrv.method ?? indices.pressure.hrvMethod) === 'RMSSD' ? '恢复HRV' : 'HRV';
  const heading = headline.basis === 'building_baseline' ? '⏳ 状态数据积累中'
    : headline.basis === 'missing' ? '❔ 状态暂无' : `${statusEmojis[headline.state]} ${prefix}${headline.label}(${hrvLabel} ${hrvText})`;
  const sleep = indices.sleep;
  const todaySleep = sleep?.date === dateKey(now) && Number.isFinite(sleep.score) && sleep.score >= 0 && sleep.score <= 100;
  const sleepLabels = { excellent: '优秀', good: '良好', fair: '一般', rest_needed: '待改善' };
  const sleepPresentation = scorePresentation('sleep', sleep?.score);
  const parts = [heading, todaySleep ? `${statusEmojis[sleepPresentation.state]} 睡眠${sleepLabels[sleepPresentation.state]}(${Math.round(sleep.score)}分)` : '🛏️ 睡眠暂无'];
  if (activity) {
    const h = indices.displayedHeart;
    if (h && Number.isFinite(h.value) && Number.isFinite(h.measuredAt) && h.measuredAt <= now) {
      const heart = Math.round(h.value), emoji = heart < 60 ? '💙' : heart < 100 ? '❤️' : heart < 140 ? '💓' : '🔥';
      parts.push(`${emoji} ${now-h.measuredAt >= 90*MINUTE ? '上次' : ''}心率${heart}`);
    } else parts.push('🤍 心率暂无');
    if (Number.isFinite(activity.steps?.value)) {
      const steps = Math.round(activity.steps.value), emoji = steps < 3000 ? '🪑' : steps < 8000 ? '🚶' : steps < 12000 ? '🏃' : '🏅';
      parts.push(`${emoji} 今日${steps}步`);
    } else parts.push('👣 今日步数暂无');
    const workout = activity.workouts;
    if (Number.isFinite(workout?.minutes) && workout.minutes >= 10) parts.push(`💪 今日锻炼${workout.minutes}分`);
  }
  parts.push(Number.isFinite(syncedAt) && syncedAt <= now ? `同步时间: ${stamp(syncedAt)}` : '同步时间: 暂无');
  return [...parts, '详情 ↗'].join('｜');
}

export function renderHealthSignature(indices, now, history = null) {
  const p = indices.pressure, sleep = indices.sleep, hrv = indices.features.hrv;
  const method = hrv.method ?? p.hrvMethod ?? 'SDNN';
  // The signature names the most recent result only; the daily aggregate stays on the dashboard.
  const headline = pressureHeadline(indices, now, history, { today: false });
  const heading = headline.basis === 'building_baseline' ? '压力积累中' : headline.basis === 'missing' ? '压力暂无'
    : `${headline.color} ${({ nightly: '昨夜' })[headline.basis] ?? ''}${headline.label}`;
  const todaySleep = sleep.date === dateKey(now) && Number.isFinite(sleep.score);
  const sleepText = todaySleep
    ? `${sleep.presentation.emoji} 睡眠${sleep.score}` : '睡眠 - ';
  const heart = indices.displayedHeart;
  const measurement = (label, value, measuredAt) => {
    if (!Number.isFinite(value) || !Number.isFinite(measuredAt) || measuredAt > now) return '';
    return `${label}${Math.round(value)}`;
  };
  const hrvText = measurement(method === 'RMSSD' ? '恢复HRV' : 'HRV', hrv.current, hrv.measuredAt);
  const heartText = heart ? measurement('心率', heart.value, heart.measuredAt) : '';
  if (headline.score === null && !Number.isFinite(sleep.endAt) && !hrvText && !heartText) return '⌚ 健康记录｜详情 ↗';
  const states = [heading, sleepText].filter(Boolean).join(' ');
  const measurements = [hrvText, heartText].filter(Boolean).join(' ');
  const content = [states, measurements].filter(Boolean).join('｜');
  // One clock shows the latest displayed measurement; per-metric times remain in the API.
  return `${content}${Number.isFinite(indices.asOfAt) ? `｜${stamp(indices.asOfAt)}` : ''}｜详情 ↗`;
}
