import test from "node:test";
import assert from "node:assert/strict";
import * as model from "./src/model.mjs";
import {
  activitySummary,
  beijingDate,
  formatTime,
  freshness,
  pressureMode,
  pressureDayRows,
  dailyMetricRows,
  heartTimeline,
  heartDays,
  pressureReason,
  workoutIcon,
} from "./src/model.mjs";

const now = Date.parse("2026-10-02T12:00:00+08:00");
test('workout period filters both cards and totals and does not pass weekly data off as a month', () => {
  assert.equal(typeof model.workoutView, 'function');
  const make = (days, durationMs, kcal) => ({ start: now - days * 86400000, end: now - days * 86400000 + 3600000, durationMs, activeEnergyKcal: kcal });
  const dto = { workoutHistory: { startAt: now - 30 * 86400000, endAt: now,
    records: [make(1, 1200000, 200), make(2, 1199999, 999), make(20, 3600000, null), make(3, 1200000, 0)] } };
  const week = model.workoutView(dto, '7d', now), month = model.workoutView(dto, '30d', now);
  assert.equal(week.records.length, 2); assert.equal(week.durationMs, 2400000);
  assert.equal(week.kcal, 200); assert.equal(week.energyCount, 2);
  assert.equal(month.records.length, 3); assert.equal(month.durationMs, 6000000);
  assert.equal(month.energyCount, 2); assert.equal(month.kcal, 200);
  assert.equal(model.workoutView({ workouts: [make(1, 3600000, 100)] }, '30d', now).available, false);
  assert.equal(model.workoutView({ workouts: [make(1, 3600000, 100)] }, '7d', now).records.length, 1);
});
test("HRV method selection never substitutes SDNN for missing recovery measurements", () => {
  assert.equal(typeof model.hrvPoints, 'function');
  const dto = { hrv: [{ t: now, v: 70 }], recoveryHrv: [{ t: now - 60000, v: 35 }] };
  assert.deepEqual(model.hrvPoints(dto), dto.recoveryHrv);
  assert.deepEqual(model.hrvPoints(dto, "SDNN"), dto.hrv);
  assert.deepEqual(model.hrvPoints({ hrv: dto.hrv }), []);
  const coverage = model.dataCoverage({ channels: { recoveryHrv: { count: 3, latestAt: now } } }, now);
  assert.equal(coverage.find(row => row.key === 'recoveryHrv').label, '恢复 HRV（RMSSD）');
});
test("sleep coverage uses the received calendar date without a wake timestamp", () => {
  const row = model.dataCoverage({ channels: { sleep: { count: 10, latestDate: '2026-10-08' } } }, now)
    .find(row => row.key === 'sleep');
  assert.equal(row.latest, '2026-10-08');
  assert.equal(row.status, '有数据');
});
test("data coverage distinguishes received activity conflicts from a day awaiting upload", () => {
  assert.equal(typeof model.dataCoverage, "function");
  const midnight = Date.parse("2026-10-04T00:40:00+08:00");
  const dto = {
    generatedAt: midnight,
    channels: {
      heart: { latestAt: midnight - 60000 },
      hrv: { latestAt: midnight - 3600000 },
      daily: { latestAt: Date.parse("2026-10-03T00:00:00+08:00") },
      sleep: { latestAt: Date.parse("2026-10-03T09:00:00+08:00") },
      workout: { latestAt: null },
    },
    daily: [
      {
        date: "2026-10-03",
        metrics: { step_count: { v: null, reason: "source_conflict" } },
      },
      { date: "2026-10-04", metrics: {} },
    ],
    sleep: [{ date: "2026-10-03", conflict: false }],
  };
  const rows = model.dataCoverage(dto, midnight);
  assert.equal(
    rows.find((r) => r.key === "daily").status,
    "1 项来源冲突 · 今日待同步",
  );
  assert.equal(rows.find((r) => r.key === "heart").latest, "10/04 00:39");
  assert.equal(rows.find((r) => r.key === "sleep").latest, "2026-10-03");
  assert.equal(rows.find((r) => r.key === "workout").status, "尚无记录");
  assert.equal(rows.find((r) => r.key === "hrv").label, "HRV（SDNN）");
  dto.daily[1].metrics = { step_count: { v: 100 } };
  dto.channels.daily.latestAt = Date.parse("2026-10-04T00:00:00+08:00");
  assert.equal(
    model.dataCoverage(dto, midnight).find((r) => r.key === "daily").status,
    "有日汇总",
  );
});
test("calendar labels use Beijing time independent of the browser zone", () => {
  assert.equal(beijingDate(Date.parse("2026-10-01T17:00:00Z")), "2026-10-02");
  assert.equal(formatTime(Date.parse("2026-10-01T17:05:00Z")), "10/02 01:05");
  assert.equal(formatTime(null), "—");
});
test("pressure shows sparse history as observations and mature history by day", () => {
  const history = { days: [{ status: "available", median: 74 }] };
  assert.equal(pressureMode("7d", history), "time");
  history.days.push({ status: "available", median: 50 });
  assert.equal(pressureMode("7d", history), "day");
  assert.equal(pressureMode("24h", history), "time");
  assert.equal(pressureMode("7d", {}), "time");
});
test("workout icons distinguish the requested sports and retain a fallback", () => {
  for (const [name, icon] of [
    ["足球", "⚽"],
    ["Soccer", "⚽"],
    ["传统力量训练", "🏋️"],
    ["健身", "🏋️"],
    ["Strength Training", "🏋️"],
    ["户外跑步", "🏃"],
    ["Running", "🏃"],
    ["泳池游泳", "🏊"],
    ["Swimming", "🏊"],
  ])
    assert.equal(workoutIcon(name), icon, name);
  assert.equal(workoutIcon("网球"), "🏅");
});
test("daily pressure preserves missing and insufficient gaps and rule boundaries", () => {
  const rows = pressureDayRows({
    days: [
      {
        date: "2026-09-28",
        status: "available",
        median: 40,
        q1: 30,
        q3: 50,
        ruleVersion: "v1",
      },
      { date: "2026-09-29", status: "insufficient_samples", median: null },
      {
        date: "2026-09-30",
        status: "available",
        median: 35,
        q1: 25,
        q3: 45,
        ruleVersion: "v1",
      },
      {
        date: "2026-10-01",
        status: "available",
        median: 55,
        q1: 40,
        q3: 65,
        ruleVersion: "v2",
      },
      { date: "2026-10-02", status: "missing", median: null, partial: true },
    ],
  });
  assert.deepEqual(
    rows.map((r) => r.value),
    [40, null, 35, 55, null],
  );
  assert.equal(rows[2].connectPrevious, false);
  assert.equal(rows[3].connectPrevious, false);
  assert.equal(rows[4].partial, true);
});
test("activity summary excludes unfinished today and retains source-conflict days", () => {
  const result = dailyMetricRows(
    {
      daily: [
        {
          date: "2026-10-02",
          metrics: { active_energy: { v: 2000, unit: "kcal" } },
        },
        {
          date: "2026-09-30",
          metrics: { active_energy: { v: 100, unit: "kcal" } },
        },
        {
          date: "2026-10-01",
          metrics: { active_energy: { v: 200, unit: "kcal" } },
        },
        {
          date: "2026-09-29",
          metrics: {
            active_energy: { v: null, unit: "kcal", reason: "source_conflict" },
          },
        },
      ],
    },
    "active_energy",
    now,
  );
  assert.equal(result.median, 150);
  assert.deepEqual(
    result.rows.map((r) => r.value),
    [null, 100, 200, 2000],
  );
  assert.equal(result.rows[0].reason, "source_conflict");
  assert.equal(result.rows.at(-1).partial, true);
  assert.equal(
    dailyMetricRows(
      { daily: [{ date: "2026-10-02", metrics: { step_count: { v: 100 } } }] },
      "step_count",
      now,
    ).median,
    null,
  );
});
test("activity details keep an empty new day separate from the previous day's records", () => {
  const midnight = Date.parse("2026-10-04T00:14:00+08:00");
  const dto = {
    daily: [
      {
        date: "2026-10-03",
        metrics: {
          step_count: { v: null, reason: "source_conflict" },
          apple_exercise_time: { v: 30 },
          resting_heart_rate: { v: 60 },
        },
      },
      { date: "2026-10-04", metrics: {} },
    ],
  };
  const today = activitySummary(dto, null, midnight);
  assert.equal(today.date, "2026-10-04");
  assert.equal(today.hasRecords, false);
  assert.ok(today.rows.every((row) => row.value === null));
  assert.equal(today.rows.find((row) => row.key === "step_count").unit, "步");
  const yesterday = activitySummary(dto, "2026-10-03", midnight);
  assert.equal(yesterday.date, "2026-10-03");
  assert.equal(yesterday.hasRecords, true);
  assert.equal(
    yesterday.rows.find((row) => row.key === "apple_exercise_time").value,
    30,
  );
  assert.equal(
    yesterday.rows.find((row) => row.key === "resting_heart_rate").value,
    60,
  );
  assert.equal(
    yesterday.rows.find((row) => row.key === "step_count").reason,
    "source_conflict",
  );
  assert.equal(yesterday.partial, false);
  assert.equal(activitySummary(dto, "2026-09-01", midnight).date, "2026-10-04");
  assert.equal(
    activitySummary(dto, null, midnight + 86400000).date,
    "2026-10-05",
  );
});
test("fresh generation does not change measurement age or expire a recorded score", () => {
  assert.equal(
    freshness({ generatedAt: now, dataUpdatedAt: now - 13 * 3600000 }, now)
      .kind,
    "err",
  );
  assert.equal(
    freshness(
      {
        generatedAt: now,
        dataUpdatedAt: now,
        healthIndices: { pressure: { validUntil: now - 1 } },
      },
      now,
    ).kind,
    "ok",
  );
  assert.equal(
    freshness({ generatedAt: now, dataUpdatedAt: now - 60000 }, now).kind,
    "ok",
  );
  assert.equal(
    freshness({ generatedAt: now, dataUpdatedAt: null }, now).kind,
    "warn",
  );
});
test("a scheduled signature refresh does not mean the pressure evidence expired", () => {
  assert.equal(freshness({ generatedAt: now, dataUpdatedAt: now,
    healthIndices: { validUntil: now - 1, pressure: { validUntil: now + 30 * 60000 } } }, now).kind, "ok");
});
test("heart timeline keeps original samples and explicitly breaks across missing buckets", () => {
  const rows = heartTimeline({
    heart: {
      bucketMinutes: 2,
      points: [
        { s: now, e: now + 120000, v: 65, min: 60, max: 70 },
        { s: now + 120000, e: now + 240000, v: 68, min: 61, max: 75 },
        { s: now + 1200000, e: now + 1320000, v: 80, min: 70, max: 90 },
      ],
    },
  });
  assert.deepEqual(
    rows.filter((r) => r.v !== null).map((r) => r.v),
    [65, 68, 80],
  );
  assert.ok(
    rows.some((r) => r.v === null && r.s > now + 120000 && r.s < now + 1200000),
  );
});
test("heart day ranges use raw bucket extrema, with no fabricated missing days", () => {
  const rows = heartDays({
    heart: {
      points: [
        { s: now, v: 70, min: 55, max: 100 },
        { s: now + 120000, v: 80, min: 65, max: 130 },
        { s: now - 2 * 86400000, v: 60, min: 50, max: 90 },
      ],
    },
  });
  assert.deepEqual(
    rows.map((r) => r.date),
    ["2026-09-30", "2026-10-02"],
  );
  assert.deepEqual(
    [rows[1].min, rows[1].avg, rows[1].max, rows[1].count],
    [55, 75, 130, 2],
  );
});
test("unavailable pressure retains actionable reasons", () => {
  assert.match(pressureReason("short_baseline"), /基线不足/);
  assert.match(pressureReason("source_or_sample_conflict"), /来源|冲突/);
  assert.match(pressureReason("missing_hrv"), /HRV/);
});

test("pressure headline follows the signature basis and keeps each result's own time", () => {
  const dto = (headline, pressure = {}) => ({ healthIndices: { headline, pressure: { hrvMethod: "RMSSD", score: 51, state: "balanced",
    evidenceAt: now - 600000, validUntil: now + 3600000, confidence: "personal_baseline", ...pressure } } });
  let h = model.pressureHeadline(dto({ basis: "today_median", score: 70, state: "elevated", date: "2026-10-02", count: 14 }), now);
  assert.deepEqual([h.title, h.score, h.caption, h.time], ["今日压力", 70, "RMSSD · 注意压力", "全天中位 · 14 次观测"]);
  h = model.pressureHeadline(dto({ basis: "current", score: 51, state: "balanced", evidenceAt: now - 600000 }), now);
  assert.deepEqual([h.title, h.caption, h.historical], ["最近压力", "RMSSD · 状态正常", false]);
  h = model.pressureHeadline(dto({ basis: "current", score: 51, state: "balanced", evidenceAt: now - 600000 }, { validUntil: now - 1 }), now);
  assert.deepEqual([h.title, h.caption, h.historical], ["上次压力", "RMSSD · 状态正常 · 历史结果", true]);
  h = model.pressureHeadline(dto({ basis: "retained", score: 75, state: "elevated", evidenceAt: now - 3 * 86400000 }, { score: null }), now);
  assert.deepEqual([h.title, h.score, h.caption, h.time], ["上次压力", 75, "RMSSD · 注意压力 · 历史结果", formatTime(now - 3 * 86400000)]);
  h = model.pressureHeadline(dto({ basis: "building_baseline", score: null, reason: "insufficient_samples" }, { score: null }), now);
  assert.deepEqual([h.score, h.caption], [null, "RMSSD · 个人基线不足"]);
  h = model.pressureHeadline(dto({ basis: "building_baseline", score: null, reason: "short_baseline" },
    { score: null, baselineDays: { hrv: 3, heart: 2 }, baselineRequirement: { hrv: 7, heart: 3 } }), now);
  assert.equal(h.caption, "RMSSD · 个人基线不足 · RMSSD 3/7 天 · 心率 2/3 天");
  h = model.pressureHeadline(dto({ basis: "missing", score: null, reason: "expired_hrv" }, { score: null }), now);
  assert.deepEqual([h.score, h.caption, h.time], [null, "RMSSD · HRV 已过期", null]);
  // Payloads written before the headline existed keep their previous meaning.
  h = model.pressureHeadline(dto(undefined, { retained: true, score: 52 }), now);
  assert.equal(h.title, "上次压力");
  assert.equal(model.signatureText("🔵 状态正常 睡眠 - ｜恢复HRV42｜10/14 15:00｜详情 ↗"), "🔵 状态正常 睡眠 - ｜恢复HRV42｜10/14 15:00");
  assert.equal(model.signatureText(null), null);
});
