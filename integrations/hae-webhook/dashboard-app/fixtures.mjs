// Synthetic data only. This module is never imported by the production entry point.
const stamp = (t) => new Date(t + 8 * 3600000).toISOString().slice(5, 16).replace("-", "/").replace("T", " ");
export function makeFixture(range = "24h", now = Date.now()) {
  const H = 3600000,
    D = H * 24,
    date = (t) => new Date(t + 8 * H).toISOString().slice(0, 10);
  const startAt = now - (range === "7d" ? 7 * D : D);
  const midnight = Math.floor((now + 8 * H) / D) * D - 8 * H;
  const bucketMinutes = range === "7d" ? 10 : 2;
  const heart = [];
  for (let t = startAt, i = 0; t < now; t += bucketMinutes * 60000, i++) {
    if (i % 180 > 140 && i % 180 < 158) continue;
    const hour = ((t + 8 * H) / H) % 24;
    const v = Math.round(
      (hour < 7 ? 55 : 72) +
        Math.sin(i / 12) * 8 +
        Math.cos(i / 3) * 3 +
        (i % 240 > 210 ? 40 : 0),
    );
    heart.push({
      s: t,
      e: t + bucketMinutes * 60000,
      v,
      min: v - 6,
      max: v + 10,
    });
  }
  const sleep = Array.from({ length: range === "7d" ? 7 : 1 }, (_, i) => {
    const end = midnight - (i + (now < midnight + 7 * H ? 1 : 0)) * D + 7 * H;
    const asleepMinutes = 430 - i * 7, awakeMinutes = 22 + i;
    const components = { duration: 50 * asleepMinutes / 480,
      regularity: 22 - i, continuity: 20 * asleepMinutes / (asleepMinutes + awakeMinutes) };
    return {
      date: date(end),
      start: end - 8 * H,
      end,
      asleepMinutes, awakeMinutes,
      score: i === 3 ? null : Math.round(Object.values(components).reduce((a, b) => a + b)),
      reason: i === 3 ? 'incomplete_or_conflicting_sleep' : null,
      components: i === 3 ? null : components,
      baselineDays: 10 - i, bedtimeDeviationMinutes: (1 - components.regularity / 30) * 120,
      stages: { deep: 90 - i * 2, rem: 102 - i, core: 238 - i * 4 },
      conflict: i === 3,
      sources: i === 3 ? 2 : 1,
    };
  })
    .filter((n) => n.end <= now)
    .reverse();
  const days = Array.from({ length: range === "7d" ? 8 : 2 }, (_, i) => {
    const t = midnight - (range === "7d" ? 7 - i : 1 - i) * D;
    const unavailable = i === 2 || i === 4;
    return {
      date: date(t),
      status:
        i === 2 ? "insufficient_samples" : i === 4 ? "missing" : "available",
      count: i === 2 ? 1 : i === 4 ? 0 : 5 + i,
      median: unavailable ? null : 28 + i * 4,
      q1: unavailable ? null : 20 + i * 3,
      q3: unavailable ? null : 39 + i * 4,
      highFraction: unavailable ? null : i / 25,
      spanMinutes: unavailable ? 0 : 240 + i * 20,
      partial: date(t) === date(now),
      ruleVersion: i < 5 ? "v2-demo" : "v3-demo",
    };
  });
  return {
    schemaVersion: "dashboard-v1",
    range,
    generatedAt: now,
    dataUpdatedAt: now - 120000,
    timezone: "Asia/Shanghai",
    window: { startAt, endAt: now },
    receivedAt: now - 60000,
    healthIndices: {
      ruleVersion: "health-indices-v6-rmssd",
      textVersion: "health-signature-text-v1",
      headline: { basis: "current", score: 38, state: "balanced", label: "状态正常", evidenceAt: now - H / 2 },
      asOfAt: now - H / 2,
      evaluatedAt: now,
      validUntil: now + H * 5,
      pressure: {
        hrvMethod: "RMSSD",
        score: 38,
        state: "balanced",
        context: "awake_sample",
        confidence: "personal_baseline",
        evidenceAt: now - H / 2,
        validUntil: now + H * 5,
        baselineDays: { hrv: 19, heart: 17 },
        baselineRequirement: { hrv: 7, heart: 3 },
        arrow: "↓",
      },
      sleep: {
        score: 86,
        state: "good",
        date: sleep.at(-1)?.date,
        endAt: sleep.at(-1)?.end,
      },
    },
    publication: {
      mode: "health-indices-v1",
      sentTitle: `🔵 状态正常 🙂 睡眠86｜恢复HRV40 心率68｜${stamp(now - 120000)}｜详情 ↗`,
      lastSentAt: now - 60000,
      pending: false,
      measuredAt: now - 120000,
    },
    hrv: Array.from({ length: range === "7d" ? 46 : 8 }, (_, i) => ({
      t: startAt + ((i + 0.5) * (now - startAt)) / (range === "7d" ? 46 : 8),
      v: Math.round(48 + Math.sin(i * 1.3) * 15 + (i % 4) * 2),
    })),
    recoveryHrv: Array.from({ length: range === "7d" ? 2016 : 288 }, (_, i) => ({
      t: startAt + (i + 0.5) * 5 * 60000,
      v: Math.round(35 + Math.sin(i / 9) * 12),
    })),
    heart: {
      points: heart,
      bucketMinutes,
      latest: { s: now - 60000, e: now, v: 68, min: 64, max: 74 },
      truncated: false,
    },
    sleep,
    workouts: [
      {
        name: "户外跑步",
        start: now - H * 4,
        end: now - H * 3.3,
        durationMs: H * 0.7,
      },
    ],
    daily: days.map((r, i) => ({
      date: r.date,
      metrics: {
        step_count: { v: 4800 + i * 712, unit: "count" },
        active_energy: {
          v: i === 2 ? null : 312 + i * 24,
          unit: "kcal",
          ...(i === 2 ? { reason: "source_conflict" } : {}),
        },
        apple_exercise_time: { v: 24 + i * 3, unit: "min" },
        walk_run_distance: { v: 3.2 + i * 0.6, unit: "km" },
        resting_heart_rate: { v: 52 + (i % 4), unit: "bpm" },
      },
    })),
    pressureHistory: {
      since: now - 7 * D,
      points: Array.from({ length: range === "7d" ? 30 : 6 }, (_, i) => ({
        t: startAt + ((i + 0.6) * (now - startAt)) / (range === "7d" ? 30 : 6),
        score: Math.round(40 + Math.sin(i) * 20),
        context: "awake_sample",
        confidence: "personal_baseline",
        ruleVersion: "v3-demo",
      })),
      days,
      nights: sleep.map((n) => ({
        t: n.end,
        score: 22,
        context: "nightly",
        ruleVersion: "night-v1-demo",
      })),
      sampled: false,
    },
    channels: {
      heart: { latestAt: now },
      hrv: {
        latestAt: now - (now - startAt) / (2 * (range === "7d" ? 46 : 8)),
      },
      recoveryHrv: { latestAt: now - 150000 },
      daily: { latestAt: midnight },
      sleep: { latestAt: sleep.at(-1)?.end ?? null },
      workout: { latestAt: now - H * 3.3 },
    },
  };
}
