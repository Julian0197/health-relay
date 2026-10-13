// Presentation only. Scores and daily aggregates are supplied by the scorer/store.
const MINUTE = 60000, HOUR = 60 * MINUTE;
const labels = { relaxed: '状态优秀', balanced: '状态正常', elevated: '注意压力', high: '压力过载' };
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

export function renderHealthSignature(indices, now, history = null) {
  const p = indices.pressure, sleep = indices.sleep, hrv = indices.features.hrv;
  const last = indices.lastValidPressure;
  const retained = last && last.ruleVersion === indices.ruleVersion && last.source === p.source &&
    Number.isFinite(last.score) && Number.isFinite(last.evidenceAt) && last.evidenceAt <= now &&
    now - last.evidenceAt < 7 * 24 * HOUR;
  const method = hrv.method ?? p.hrvMethod ?? 'SDNN';
  const today = history?.days?.find(d => d.date === dateKey(now) && d.status === 'available' &&
    d.ruleVersion === indices.ruleVersion && Number.isFinite(d.median) &&
    (!d.method || d.method === method) && (!d.deviceEpoch || d.deviceEpoch === p.deviceEpoch) &&
    (p.deviceEpoch ? d.sourceScope === `hae-profile:${p.deviceEpoch}` : !d.sourceScope));
  const buildingBaseline = p.reason === 'short_baseline' || (['expired_hrv', 'insufficient_samples'].includes(p.reason) &&
    (p.hrvBaseline.days < (method === 'RMSSD' ? 1 : 3) || p.heartBaseline.days < (method === 'RMSSD' ? 1 : 3)));
  let heading = buildingBaseline ? '压力积累中' : '压力暂无';
  if (today) {
    const presentation = scorePresentation('pressure', today.median);
    heading = `${presentation.color} ${labels[presentation.state]}`;
  } else if (Number.isFinite(p.score)) {
    const context = p.context === 'nightly' ? '昨夜' : '';
    heading = `${p.presentation.color} ${context}${labels[p.presentation.state]}`;
  } else if (retained) {
    const presentation = scorePresentation('pressure', last.score);
    heading = `${presentation.color} ${labels[presentation.state]}`;
  }
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
  if (!today && !Number.isFinite(p.score) && !retained && !Number.isFinite(sleep.endAt) && !hrvText && !heartText) return '⌚ 健康记录｜详情 ↗';
  const states = [heading, sleepText].filter(Boolean).join(' ');
  const measurements = [hrvText, heartText].filter(Boolean).join(' ');
  const content = [states, measurements].filter(Boolean).join('｜');
  // One clock shows the latest displayed measurement; per-metric times remain in the API.
  return `${content}${Number.isFinite(indices.asOfAt) ? `｜${stamp(indices.asOfAt)}` : ''}｜详情 ↗`;
}
