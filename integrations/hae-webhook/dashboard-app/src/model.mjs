const HOUR = 3600000,
  DAY = 24 * HOUR;
export const finite = (value) =>
  typeof value === "number" && Number.isFinite(value);
export const number = (value, digits = 0) =>
  finite(value)
    ? value.toLocaleString("zh-CN", { maximumFractionDigits: digits })
    : "—";
export const beijingDate = (t) =>
  finite(t) ? new Date(t + 8 * HOUR).toISOString().slice(0, 10) : null;
export function formatTime(t) {
  if (!finite(t)) return "—";
  return new Date(t + 8 * HOUR)
    .toISOString()
    .slice(5, 16)
    .replace("-", "/")
    .replace("T", " ");
}
export function median(values) {
  const sorted = values.filter(finite).sort((a, b) => a - b),
    n = sorted.length;
  return n
    ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2
    : null;
}
export const pressureMode = (range, history) =>
  range === "7d" &&
  (history?.days ?? []).filter(
    (r) => r.status === "available" && finite(r.median),
  ).length >= 2
    ? "day"
    : "time";
export const hrvPoints = (dto, method = "RMSSD") =>
  (method === "SDNN" ? dto?.hrv : dto?.recoveryHrv) ?? [];
export function workoutView(dto, range = "7d", now = Date.now()) {
  const history = dto?.workoutHistory;
  const available = Boolean(dto) && (range === "7d" || Boolean(history));
  const startAt = now - (range === "30d" ? 30 : 7) * 86400000;
  const records = available ? (history?.records ?? dto.workouts ?? []).filter(r =>
    r.start >= startAt && r.end <= now && r.durationMs >= 1200000).sort((a, b) => b.start - a.start) : [];
  const energies = records.filter(r => finite(r.activeEnergyKcal));
  return { available, records, durationMs: records.reduce((n, r) => n + r.durationMs, 0),
    energyCount: energies.length, kcal: energies.length ? energies.reduce((n, r) => n + r.activeEnergyKcal, 0) : null };
}
export function workoutIcon(name = "") {
  if (/足球|soccer|football/i.test(name)) return "⚽";
  if (/健身|力量|strength|fitness|resistance/i.test(name)) return "🏋️";
  if (/跑步|running|run\b/i.test(name)) return "🏃";
  if (/游泳|swim/i.test(name)) return "🏊";
  return "🏅";
}
export const pressureReason = (reason) =>
  ({
    missing_hrv: "暂无 HRV",
    expired_hrv: "HRV 已过期",
    missing_or_conflicting_aligned_hr: "配对心率缺失或冲突",
    short_baseline: "个人基线不足",
    sleep_or_workout: "睡眠或锻炼时段",
    source_or_sample_conflict: "来源或采样冲突",
    expired_sleep: "睡眠评分已过期",
    sleep_settling: "睡眠数据等待稳定",
    short_sleep_baseline: "睡眠历史不足",
    incomplete_or_conflicting_sleep: "睡眠记录不完整或存在冲突",
    missing_sleep: "暂无睡眠记录",
    source_conflict: "来源冲突",
    unsupported_unit: "单位暂不支持",
    insufficient_samples: "样本不足",
    mixed_rules: "规则混合",
    mixed_sources: "设备来源混合",
    missing: "缺测",
  })[reason] ?? (reason ? `暂不可用 · ${reason}` : "暂无评分");
// Same four-tier words as the published signature.
export const pressureLabels = { relaxed: "状态优秀", balanced: "状态正常", elevated: "注意压力", high: "压力过载" };
// The headline follows the signature's choice: today's aggregate, the current (or last night's)
// result, a retained historical result, a baseline still building, or missing. Each keeps its time.
export function pressureHeadline(dto, now = Date.now()) {
  const p = dto?.healthIndices?.pressure ?? {};
  const h = dto?.healthIndices?.headline ?? (finite(p.score)
    ? { basis: p.retained ? "retained" : p.context === "nightly" ? "nightly" : "current", score: p.score, state: p.state, evidenceAt: p.evidenceAt }
    : { basis: p.reason === "short_baseline" ? "building_baseline" : "missing", score: null, reason: p.reason });
  const method = p.hrvMethod ?? "SDNN", label = pressureLabels[h.state] ?? "已评分";
  // A current result past its own deadline reads as the signature will after the service
  // republishes it: a historical result at its measurement time, never "expired".
  const historical = h.basis === "retained" || (h.basis === "current" && finite(p.validUntil) && now >= p.validUntil);
  const title = historical ? "上次压力" : { today_median: "今日压力", nightly: "最近夜间负荷" }[h.basis]
    ?? (h.score == null && p.context === "nightly" ? "最近夜间负荷" : "最近压力");
  const caption = h.score == null
    ? `${method} · ${pressureReason(h.basis === "building_baseline" ? "short_baseline" : h.reason ?? p.reason)}`
    : `${method} · ${label}${historical ? " · 历史结果" : ""}`;
  const time = h.basis === "today_median" ? `全天中位 · ${h.count ?? "—"} 次观测`
    : h.basis === "nightly" ? beijingDate(h.evidenceAt) : finite(h.evidenceAt) ? formatTime(h.evidenceAt) : null;
  return { basis: h.basis, title, score: h.score ?? null, caption, time, historical,
    shortBaseline: h.score != null && p.confidence === "short_baseline" && h.basis !== "today_median" };
}
// The published signature without its link marker; the title already carries its measurement time.
export const signatureText = (title) => (typeof title === "string" ? title.replace(/｜详情 ↗$/, "") : null);
export function freshness(d, now = Date.now()) {
  const hi = d.healthIndices;
  // Recorded scores keep their measurement time; only describe data freshness here.
  const measuredAt = hi?.asOfAt ?? d.dataUpdatedAt;
  if (!finite(measuredAt)) return { kind: "warn", text: "暂无测量数据" };
  const hours = (now - measuredAt) / HOUR;
  return hours > 3
    ? {
        kind: hours > 12 ? "err" : "warn",
        text: `数据已 ${Math.floor(hours)} 小时未更新`,
      }
    : { kind: "ok", text: "已更新" };
}
export function pressureDayRows(history) {
  const rows = [...(history?.days ?? [])].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  return rows.map((r, i) => {
    const p = rows[i - 1];
    const available = r.status === "available" && finite(r.median);
    return {
      ...r,
      value: available ? r.median : null,
      connectPrevious: Boolean(
        available &&
        p?.status === "available" &&
        finite(p.median) &&
        p.ruleVersion === r.ruleVersion &&
        Date.parse(r.date) - Date.parse(p.date) === DAY,
      ),
    };
  });
}
export function dailyMetricRows(dto, key, now = Date.now()) {
  const today = beijingDate(now);
  const rows = [...(dto.daily ?? [])]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => {
      const m = r.metrics[key];
      return {
        date: r.date,
        value: finite(m?.v) ? m.v : null,
        unit: m?.unit,
        reason: m?.reason ?? (finite(m?.v) ? null : "missing"),
        partial: r.date === today,
      };
    });
  return {
    rows,
    median: median(rows.filter((r) => r.date < today).map((r) => r.value)),
  };
}
export function activitySummary(dto, selectedDate, now = Date.now()) {
  const today = beijingDate(now);
  const dates = [
    ...new Set([today, ...(dto.daily ?? []).map((day) => day.date)]),
  ]
    .sort()
    .reverse();
  const date = dates.includes(selectedDate) ? selectedDate : today;
  const day = dto.daily?.find((day) => day.date === date);
  return {
    dates,
    date,
    partial: date === today,
    hasRecords: metrics.some((metric) => day?.metrics[metric.key] != null),
    rows: metrics.map((metric) => ({
      ...metric,
      ...(dailyMetricRows(dto, metric.key, now).rows.find(
        (row) => row.date === date,
      ) ?? { value: null, reason: "missing" }),
      unit: metric.unit,
    })),
  };
}
export function dataCoverage(dto, now = Date.now()) {
  const today = activitySummary(dto, null, now);
  return [
    ["heart", "心率"],
    ["recoveryHrv", "恢复 HRV（RMSSD）"],
    ["hrv", "HRV（SDNN）"],
    ["daily", "日常活动"],
    ["sleep", "睡眠分期"],
    ["workout", "锻炼记录"],
  ].map(([key, label]) => {
    const channel = dto.channels?.[key];
    const at = channel?.latestAt;
    const date = key === "sleep" ? (channel?.latestDate ?? beijingDate(at)) : beijingDate(at);
    let status = (key === "sleep" ? Boolean(date) : finite(at)) ? "有数据" : "尚无记录";
    if (key === "daily") {
      const day = dto.daily?.find((row) => row.date === date);
      const conflicts = Object.values(day?.metrics ?? {}).filter(
        (metric) => metric.reason === "source_conflict",
      ).length;
      status = conflicts
        ? `${conflicts} 项来源冲突`
        : finite(at)
          ? "有日汇总"
          : status;
      if (!today.hasRecords) status += " · 今日待同步";
    }
    if (key === "sleep" && dto.sleep?.at(-1)?.conflict) status = "来源冲突";
    return {
      key,
      label,
      latest:
        key === "daily" || key === "sleep" ? (date ?? "—") : formatTime(at),
      status,
    };
  });
}
export function heartTimeline(dto) {
  const points = [...(dto.heart?.points ?? [])].sort((a, b) => a.s - b.s),
    result = [];
  const step = (dto.heart?.bucketMinutes ?? 1) * 60000;
  for (const p of points) {
    const previous = result.at(-1);
    if (previous && p.s - previous.s > step * 1.5)
      result.push({ s: previous.s + step, v: null });
    result.push(p);
  }
  return result;
}
export function heartDays(dto) {
  const days = new Map();
  for (const p of dto.heart?.points ?? []) {
    if (!finite(p.s) || !finite(p.v)) continue;
    const date = beijingDate(p.s),
      d = days.get(date) ?? {
        date,
        min: Infinity,
        max: -Infinity,
        sum: 0,
        count: 0,
      };
    d.min = Math.min(d.min, p.min ?? p.v);
    d.max = Math.max(d.max, p.max ?? p.v);
    d.sum += p.v;
    d.count += 1;
    days.set(date, d);
  }
  return [...days.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ sum, ...d }) => ({ ...d, avg: sum / d.count }));
}
export const metrics = [
  { key: "step_count", label: "步数", unit: "步" },
  { key: "active_energy", label: "活动能量", unit: "kcal" },
  { key: "apple_exercise_time", label: "锻炼时间", unit: "min" },
  { key: "walk_run_distance", label: "步行与跑步", unit: "km" },
  { key: "resting_heart_rate", label: "静息心率", unit: "bpm" },
];
