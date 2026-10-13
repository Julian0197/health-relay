// 确定性签名状态机（M1）：只消费可验证事实，输出 SignatureSnapshot。
// 规则优先级：数据有效性 → 已证实的运动后窗口 → 基线充足度 → 基线比较（推断态仅影子）。
// 纯函数：不触网、不发消息、不读自由文本；AI 与发布器都只能消费这里的输出。
import { analyze, RULES, sleepSessions } from './analysis.mjs';

const MIN = 60000;
export const SIGNATURE_SCHEMA_VERSION = 'signature-v1';
export const SIGNATURE_RULE_VERSION = 'state-facts-v1';

export const STATES = {
  pending: 'pending',                       // 无证据 / 陈旧 / 不可靠
  post_workout: 'post_workout',             // 已结束训练后的观察窗口
  baseline_building: 'baseline_building',   // 历史可比日不足
  steady: 'steady',                         // 推断态（影子）：平稳
  drift: 'drift',                           // 推断态（影子）：持续波动
};

// 公开 title 只来自固定模板，永远不拼接数值或外部文本。
export const TITLES = {
  pending: '🫀 状态待更新',
  post_workout: '🏃 运动后，调整节奏中',
  baseline_building: '🌱 正在了解自己的节奏',
  steady: '🌿 按自己的节奏来',
  drift: '🍃 今天放慢一点节奏',
};

// 推断态（需要基线比较）第一版只做影子评估，不用于公开发布。
const SHADOW_STATES = new Set([STATES.steady, STATES.drift]);

const PUBLISHABLE = new Set([STATES.pending, STATES.post_workout, STATES.baseline_building]);

/**
 * @param {object} series SeriesStore 形状：{ hrv, heart, sleep, daily, workout }
 * @param {number} now 评估时刻（ms）
 * @returns {object} SignatureSnapshot
 */
export async function buildSignatureSnapshot(series, now) {
  const a = analyze(series, now);
  const reasons = [];
  const evidenceIds = [];

  // ── 事实 1：最近的锻炼（进行中 / 刚结束；必须来自真实 workout 记录）──
  const workouts = [...series.workout].filter(w => Number.isFinite(w.start) && Number.isFinite(w.end));
  const latestWorkout = workouts.sort((x, y) => y.end - x.end || String(y.id).localeCompare(String(x.id)))[0] ?? null;
  const workoutOngoing = latestWorkout && now >= latestWorkout.start && now < latestWorkout.end;
  const postWorkoutMs = latestWorkout ? now - latestWorkout.end : Infinity;
  const inPostWindow = latestWorkout && !workoutOngoing && postWorkoutMs >= 0 && postWorkoutMs <= RULES.postWorkoutMinutes * MIN;

  // ── 事实 2：新鲜度与可靠性（HRV 6h / 心率 90min / 主睡眠 36h / RHR 今昨）──
  const day = a.daytime;
  const night = a.nightly;
  const rest = a.resting;
  const heart = a.heart;

  const hasAnyRecord = series.hrv.length + series.heart.length + series.sleep.length + series.daily.length > 0;
  const freshSignals = [];
  if (heart.status === 'available') freshSignals.push('heart');
  if (night.status === 'comparable') freshSignals.push('nightly_hrv');
  if (day.status === 'comparable') freshSignals.push('daytime_hrv');
  if (rest.status === 'comparable') freshSignals.push('resting_hr');

  const conflicts = [];
  if (day.status === 'source_conflict') conflicts.push('daytime_hrv_source_conflict');
  if (night.status === 'source_conflict') conflicts.push('nightly_hrv_source_conflict');
  if (rest.status === 'source_conflict') conflicts.push('resting_hr_source_conflict');

  // ── 事实 3：基线充足度（以夜间主睡眠 HRV 为主恢复信号，RHR 为辅）──
  const nightBaselineDays = night.baseline?.days ?? 0;
  const restBaselineDays = rest.baseline?.days ?? 0;
  // ── 证据新鲜度（判定链使用 recoveryReady/recoveryBuilding）──

  // ── 证据行（用于 evidenceVersion 与 evidenceIds）──
  const mainSession = latestMainSession(series.sleep, now);
  const evidence = {
    hrvDay: day.measuredAt ? { measuredAt: day.measuredAt, value: day.current, source: day.source, position: day.position ?? null } : null,
    hrvNight: mainSession ? {
      start: night.start ?? mainSession.start, end: night.end ?? mainSession.end,
      value: pick(night.current), samples: night.samples ?? 0, sources: mainSession.sources ?? [],
      conflict: Boolean(mainSession.conflict), position: night.position ?? null,
    } : null,
    resting: rest.measuredAt ? { measuredAt: rest.measuredAt, value: rest.current, source: rest.source, date: rest.date, position: rest.position ?? null } : null,
    heart: heart.measuredAt ? { measuredAt: heart.measuredAt, value: heart.value } : null,
    workout: latestWorkout ? { id: String(latestWorkout.id), start: latestWorkout.start, end: latestWorkout.end } : null,
  };
  if (evidence.hrvDay && day.measuredAt) evidenceIds.push(...matchingKeys(series.hrv, day.measuredAt, day.source));
  if (evidence.hrvNight && mainSession) evidenceIds.push(...series.sleep.filter(r => r.key && r.end <= mainSession.end && r.start >= mainSession.start).map(r => r.key));
  if (evidence.resting && rest.measuredAt) evidenceIds.push(...matchingKeys(series.daily, rest.measuredAt, rest.source));
  if (evidence.heart && heart.measuredAt) evidenceIds.push(...matchingKeys(series.heart, heart.measuredAt, null));
  if (evidence.workout) evidenceIds.push(String(latestWorkout.id));

  // ── 证据新鲜度：心率代表当下；恢复结论需新鲜夜间 HRV 或新鲜 RHR ──────────
  const nightFresh = evidence.hrvNight && now - evidence.hrvNight.end <= 36 * 3600000 && !evidence.hrvNight.conflict;
  const recoveryReady = (night.status === 'comparable' && nightFresh) ||
    (night.status === 'missing' && rest.status === 'comparable');
  const recoveryBuilding = (night.status === 'baseline_building' && nightFresh) ||
    (night.status === 'missing' && rest.status === 'baseline_building');

  // ── 状态判定（严格优先级）─────────────────────────────────────────────
  let state;
  let publishable = true;

  if (!hasAnyRecord) {
    state = STATES.pending; reasons.push('no_data');
  } else if (workoutOngoing) {
    // 训练进行中不输出任何恢复/压力结论
    state = STATES.pending; reasons.push('workout_in_progress');
  } else if (conflicts.length && freshSignals.length === 0) {
    state = STATES.pending; reasons.push(...conflicts);
  } else if (inPostWindow) {
    state = STATES.post_workout;
    reasons.push('post_workout_window');
  } else if (recoveryReady) {
    // 推断态：需要多源证据相互支持才判「持续波动」，否则平稳；第一版均为影子。
    const driftDecision = isDriftCandidate({ day, night, rest, heart });
    state = driftDecision.drift ? STATES.drift : STATES.steady;
    publishable = false;
    reasons.push(...driftDecision.driftReasons);
    if (conflicts.length) reasons.push(...conflicts);
  } else if (recoveryBuilding) {
    // 有新鲜恢复信号，但可比历史不足 14 晚
    state = STATES.baseline_building;
    if (night.status === 'baseline_building') reasons.push(`nightly_baseline_building:${nightBaselineDays}/${RULES.minimumDays}`);
    if (rest.status === 'baseline_building') reasons.push(`resting_baseline_building:${restBaselineDays}/${RULES.minimumDays}`);
    if (night.status === 'missing') reasons.push('nightly_hrv_missing');
  } else {
    // 无新鲜恢复信号：不按固定钟点猜测睡眠，不硬给状态
    state = STATES.pending;
    reasons.push(...staleReasons(day, night, rest, heart));
    if (heart.status === 'available') reasons.push('recovery_signal_missing');
  }

  // 影子态发布时回落为中性 pending 文案（M3 验收后才允许推断态公开）。
  const publishState = PUBLISHABLE.has(state) ? state : STATES.pending;
  const quality = state === STATES.pending ? 'insufficient'
    : state === STATES.baseline_building ? 'limited'
    : 'verified';

  const measuredAt = maxTime([day.measuredAt, night.end, rest.measuredAt, heart.measuredAt, latestWorkout?.end]);
  const validUntil = computeValidUntil(state, { day, night, rest, heart, latestWorkout, now });
  const evidenceVersion = await hashEvidence(evidence);

  return {
    schemaVersion: SIGNATURE_SCHEMA_VERSION,
    ruleVersion: SIGNATURE_RULE_VERSION,
    evidenceVersion,
    evidenceIds: [...new Set(evidenceIds)].slice(0, 50),
    measuredAt,
    validUntil,
    state,
    publishState,
    publishable,
    reasons,
    quality,
    title: TITLES[publishState],
    shadow: SHADOW_STATES.has(state) ? { state, title: TITLES[state] } : null,
    generatedAt: now,
  };
}

/** 「持续波动」影子判定：HRV 偏低需要 RHR 偏高或实时心率负荷互相印证，单指标不定性。 */
function isDriftCandidate({ day, night, rest, heart }) {
  // 描述性规则用四分位定位；基线零方差（q1=q3）时回退到相对中位数偏离。
  const hrvLow = (night.status === 'comparable' &&
    (night.position === 'below_usual' || (night.position === 'flat_baseline' && (night.changePercent ?? 0) <= -20)))
    ? 'nightly_hrv_below_usual'
    : (day.status === 'comparable' &&
      (day.position === 'below_usual' || (day.position === 'flat_baseline' && (day.changePercent ?? 0) <= -20)))
      ? 'daytime_hrv_below_usual' : null;
  if (!hrvLow) return { drift: false, driftReasons: ['no_hrv_deviation'] };
  const reasons = [hrvLow];
  const rhrHigh = rest.status === 'comparable' &&
    (rest.position === 'above_usual' || (rest.position === 'flat_baseline' && (rest.changePercent ?? 0) >= 10));
  const heartLoad = heart.status === 'available' && rest.current && heart.value / rest.current > 1.35;
  if (rhrHigh) reasons.push('resting_hr_above_usual');
  if (heartLoad) reasons.push('heart_load_ratio_gt_1.35');
  return { drift: Boolean(rhrHigh || heartLoad), driftReasons: rhrHigh || heartLoad ? reasons : ['single_signal_not_enough'] };
}

function staleReasons(day, night, rest, heart) {
  const r = [];
  if (['stale', 'missing'].includes(day.status)) r.push(`daytime_hrv_${day.status}`);
  if (['stale', 'missing'].includes(night.status)) r.push(`nightly_hrv_${night.status}`);
  if (['stale', 'missing'].includes(rest.status)) r.push(`resting_hr_${rest.status}`);
  if (['stale', 'missing'].includes(heart.status)) r.push(`heart_${heart.status}`);
  return r.length ? r : 'no_fresh_signal';
}

function latestMainSession(sleepRows, now) {
  const sessions = sleepSessions(sleepRows.filter(r => r.end <= now));
  return sessions.filter(s => s.main).sort((a, b) => b.end - a.end)[0] ?? null;
}

function matchingKeys(rows, time, source) {
  return rows.filter(r => r.start === time && (source === null || r.source === source) && r.key).map(r => r.key);
}

const pick = v => (Number.isFinite(v) ? v : null);
const maxTime = values => values.filter(Number.isFinite).reduce((m, t) => Math.max(m, t), null);

/** 快照有效期：支撑状态的关键证据一旦陈旧，发布内容即到期；5 分钟下限、24 小时上限。 */
function computeValidUntil(state, { day, night, rest, heart, latestWorkout, now }) {
  const deadlines = [];
  if (state === STATES.post_workout && latestWorkout) deadlines.push(latestWorkout.end + RULES.postWorkoutMinutes * MIN);
  if (heart.measuredAt) deadlines.push(heart.measuredAt + RULES.heartFreshMinutes * MIN);
  if (day.measuredAt) deadlines.push(day.measuredAt + RULES.hrvFreshHours * 3600000);
  if (night.end) deadlines.push(night.end + 36 * 3600000);
  if (rest.measuredAt) deadlines.push(rest.measuredAt + 2 * 86400000);
  if (!deadlines.length) return now + 60 * MIN;
  const until = Math.min(...deadlines);
  return Math.max(now + 5 * MIN, Math.min(until, now + 24 * 3600000));
}

/** 规范化哈希：相同导出不产生新版本；测量值/时间/来源/修订变化才变。不含 evaluatedAt/接收时间。 */
export async function hashEvidence(evidence) {
  const canonical = JSON.stringify(sortKeys(evidence));
  // 用 Web Crypto（Workers 运行时内置），不依赖 node:crypto
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, sortKeys(value[k])]));
  }
  return value;
}

// 一次性 dry-run：node signature.mjs <fixture.json>
// fixture 形如 { "now": "ISO（可选，默认当前）", "series": {hrv,heart,sleep,daily,workout} }
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { readFileSync } = await import('node:fs');
  const fixture = JSON.parse(readFileSync(process.argv[2] ?? 'signature-fixture.json', 'utf8'));
  const now = fixture.now ? Date.parse(fixture.now) : Date.now();
  process.stdout.write(`${JSON.stringify(await buildSignatureSnapshot(fixture.series, now), null, 2)}\n`);
}
