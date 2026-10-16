// Presentation only. Scores and daily aggregates are supplied by the scorer/store.
const MINUTE = 60000, HOUR = 60 * MINUTE;
// The signature names only the state; whether it is today's, current or historical is shown on the dashboard.
export const SIGNATURE_TEXT_VERSION = 'health-signature-text-v1';
export const RETAINED_PRESSURE_MS = 7 * 24 * HOUR;
export const PRESSURE_LABELS = { relaxed: '状态优秀', balanced: '状态正常', elevated: '注意压力', high: '压力过载' };
const labels = PRESSURE_LABELS;
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
export function pressureHeadline(indices, now, history = null) {
  const p = indices.pressure, method = indices.features.hrv.method ?? p.hrvMethod ?? 'SDNN';
  const today = history?.days?.find(d => d.date === dateKey(now) && d.status === 'available' &&
    d.ruleVersion === indices.ruleVersion && Number.isFinite(d.median) &&
    (!d.method || d.method === method) && (!d.deviceEpoch || d.deviceEpoch === p.deviceEpoch) &&
    (p.deviceEpoch ? d.sourceScope === `hae-profile:${p.deviceEpoch}` : !d.sourceScope));
  const result = (basis, score, fields) => {
    const presentation = scorePresentation('pressure', score);
    return { version: SIGNATURE_TEXT_VERSION, basis, score, state: presentation.state, color: presentation.color,
      label: labels[presentation.state], evidenceAt: null, date: null, reason: null, ...fields };
  };
  if (today) return result('today_median', today.median, { date: today.date, count: today.count });
  if (Number.isFinite(p.score)) return result(p.context === 'nightly' ? 'nightly' : 'current', p.score, { evidenceAt: p.evidenceAt });
  const last = retainedPressure(indices, now);
  if (last) return result('retained', last.score, { evidenceAt: last.evidenceAt, context: last.context, reason: p.reason });
  const buildingBaseline = p.reason === 'short_baseline' || (['expired_hrv', 'insufficient_samples'].includes(p.reason) &&
    (p.hrvBaseline.days < (method === 'RMSSD' ? 1 : 3) || p.heartBaseline.days < (method === 'RMSSD' ? 1 : 3)));
  return { ...result(buildingBaseline ? 'building_baseline' : 'missing', null, { reason: p.reason }), label: null };
}

export function renderHealthSignature(indices, now, history = null) {
  const p = indices.pressure, sleep = indices.sleep, hrv = indices.features.hrv;
  const method = hrv.method ?? p.hrvMethod ?? 'SDNN';
  const headline = pressureHeadline(indices, now, history);
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
