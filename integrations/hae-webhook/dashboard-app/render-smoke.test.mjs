import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { makeFixture } from "./fixtures.mjs";

const dir = mkdtempSync(new URL("./.render-test-", import.meta.url).pathname);
let render, renderSparseHeart, pressureChartOption, sleepChartOption, timelineChartOption, workoutChartOption, renderWorkoutTimeline;
try {
  const bundle = await build({
    stdin: {
      contents:
        "export { renderToStaticMarkup } from 'react-dom/server'; export { createElement } from 'react'; export { DashboardView } from './src/App.jsx'; export * from './src/charts.jsx'; export { init } from 'echarts/core';",
      resolveDir: new URL(".", import.meta.url).pathname,
      loader: "jsx",
    },
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    jsx: "automatic",
    loader: { ".svg": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const path = join(dir, "render.cjs");
  writeFileSync(path, bundle.outputFiles[0].text);
  const {
    renderToStaticMarkup,
    createElement,
    DashboardView,
    heartLineSeries,
    pressureChartOption: pressureOption,
    sleepChartOption: sleepOption,
    timelineChartOption: timelineOption,
    workoutChartOption: workoutOption,
    init,
  } = createRequire(import.meta.url)(path);
  pressureChartOption = pressureOption;
  sleepChartOption = sleepOption;
  timelineChartOption = timelineOption;
  workoutChartOption = workoutOption;
  renderWorkoutTimeline = option => {
    const chart = init(null, null, { renderer: 'svg', ssr: true, width: 500, height: 280 });
    try { chart.setOption(option); return chart.renderToSVGString(); }
    finally { chart.dispose(); }
  };
  renderSparseHeart = (dto) => {
    const chart = init(null, null, {
      renderer: "svg",
      ssr: true,
      width: 500,
      height: 200,
    });
    try {
      chart.setOption({
        animation: false,
        xAxis: { type: "time" },
        yAxis: { type: "value" },
        series: [heartLineSeries(dto)],
      });
      return chart.renderToSVGString();
    } finally {
      chart.dispose();
    }
  };
  render = (data, range = data.range, props = {}) =>
    renderToStaticMarkup(
      createElement(DashboardView, {
        snapshot: { range, data, loading: false, error: null, stale: false },
        onRange() {},
        onRefresh() {},
        now,
        ...props,
      }),
    );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const now = Date.parse("2026-10-02T20:00:00+08:00");
test('workout panel offers its own month switch and emphasizes calories and heart without showing short sessions', () => {
  const dto = makeFixture('7d', now);
  dto.workoutHistory = { startAt: now - 30 * 86400000, endAt: now, records: [
    { name: '足球训练', start: now - 3600000, end: now - 1800000, durationMs: 1800000, durationBasis: 'recorded', activeEnergyKcal: 321,
      heart: { avg: 135, max: 172, basis: 'workout_summary' }, recovery: { drop1m: 25 } },
    { name: '短暂热身', start: now - 7200000, end: now - 6600000, durationMs: 600000, activeEnergyKcal: 999 },
    { name: '力量训练', start: now - 86400000, end: now - 84600000, durationMs: 1800000, activeEnergyKcal: 100 },
  ] };
  const html = render(dto);
  const section = html.split('01 / MOVEMENT')[1].split('class="trend-controls"')[0];
  assert.match(section, /锻炼时间范围/); assert.match(section, /近 30 天/);
  assert.match(section, /活动消耗/); assert.match(section, /321/);
  assert.match(section, /平均.*135/); assert.match(section, /最高.*172/);
  assert.match(section, /1 分钟降幅.*25/);
  assert.doesNotMatch(section, /短暂热身|999/);
  assert.match(section, /至少 20 分钟/);
  assert.match(section, /role="img" aria-label="锻炼时间线"/);
  assert.match(section, /aria-label="选择锻炼记录"/);
  assert.equal((section.match(/class="workout-card/g) ?? []).length, 1, 'only the selected workout has an expanded card');
  assert.match(section, /点击节点/);
});

test('workout timeline keeps zero energy distinct from missing and maps both tracks to original records', () => {
  assert.equal(typeof workoutChartOption, 'function');
  const records = [
    { name: '足球', start: now - 86400000, end: now - 80000000, durationMs: 6400000, activeEnergyKcal: 321, heart: { avg: 135, max: 172 }, recovery: { drop1m: 25 } },
    { name: '步行', start: now - 2 * 86400000, end: now - 2 * 86400000 + 1800000, durationMs: 1800000, activeEnergyKcal: null },
    { name: '器械', start: now - 3 * 86400000, end: now - 3 * 86400000 + 1800000, durationMs: 1800000, activeEnergyKcal: 0 },
  ];
  const option = workoutChartOption(records, { range: '30d', now, selectedIndex: 1 });
  const energy = option.series.find(s => s.id === 'workout-energy'), missing = option.series.find(s => s.id === 'workout-missing');
  assert.deepEqual(energy.data.map(p => p.value[1]), [321, 0]);
  assert.deepEqual(energy.data.map(p => p.workoutIndex), [0, 2]);
  assert.equal(missing.data[0].workoutIndex, 1);
  assert.notEqual(missing.yAxisIndex, energy.yAxisIndex);
  assert.equal(option.xAxis[0].min, now - 30 * 86400000);
  assert.equal(option.xAxis[0].max, now);
  assert.deepEqual(option.dataZoom[0].xAxisIndex, [0, 1]);
  assert.equal(option.tooltip.renderMode, 'richText');
  assert.match(option.tooltip.formatter({ data: energy.data[0] }), /足球.*\n.*321 kcal[\s\S]*平均 135.*最高 172[\s\S]*1 分钟降幅 25/);
  assert.match(option.tooltip.formatter({ data: missing.data[0] }), /活动消耗缺测/);
  assert.doesNotMatch(option.tooltip.formatter({ data: missing.data[0] }), /1 分钟降幅|活动消耗 0/);
  const svg = renderWorkoutTimeline(option);
  assert.match(svg, /<svg/); assert.match(svg, /缺测/); assert.doesNotMatch(svg, /NaN/);
});

test('all missing workout energy remains selectable without inventing a numeric calorie axis', () => {
  assert.equal(typeof workoutChartOption, 'function');
  const option = workoutChartOption([{ name: '<img src=x onerror=alert(1)>', start: now - 3600000, durationMs: 1800000, activeEnergyKcal: null }], { now });
  assert.equal(option.yAxis[0].type, 'category');
  assert.deepEqual(option.yAxis[0].data, ['缺测']);
  assert.equal(option.series[0].data[0].workoutIndex, 0);
  assert.equal(option.tooltip.renderMode, 'richText');
  assert.match(option.tooltip.formatter({ data: option.series[0].data[0] }), /活动消耗缺测/);
  assert.doesNotMatch(renderWorkoutTimeline(option), /<img/);
});
test("cards and notes use recovery HRV while preserving the independent SDNN choice", () => {
  const fixture = makeFixture("24h", now);
  fixture.healthIndices.pressure.hrvMethod = "RMSSD";
  fixture.recoveryHrv = [{ t: now - 60000, v: 37 }];
  fixture.hrv = [{ t: now - 3600000, v: 99 }];
  const html = render(fixture);
  const cards = html.split('class="stats">')[1].split('01 / MOVEMENT')[0];
  assert.match(cards, /最新恢复 HRV（RMSSD）/);
  assert.match(cards, />37</);
  assert.doesNotMatch(cards, />99</);
  assert.match(html, /心率与恢复 HRV/);
  assert.match(html, /aria-label="HRV 指标"/);
  assert.match(html, /HRV（SDNN）/);
  assert.match(html, /基于恢复 HRV（RMSSD）与配对心率/);
  assert.match(html, /SDNN 仅作独立参考/);
  assert.match(html, /轨迹只记录实际有效评分/);
  fixture.recoveryHrv = [];
  assert.doesNotMatch(render(fixture).split('class="stats">')[1].split('01 / MOVEMENT')[0], />99</);
});
test("signal chart defaults to RMSSD and switches data, units and tooltip together", () => {
  assert.equal(typeof timelineChartOption, 'function');
  const dto = { window: { startAt: now - 3600000, endAt: now },
    heart: { points: [] }, hrv: [{ t: now - 60000, v: 99 }], recoveryHrv: [{ t: now, v: 37 }] };
  const recovery = timelineChartOption(dto, { mode: 'time' });
  assert.equal(recovery.yAxis[1].name, 'RMSSD · ms');
  assert.deepEqual(recovery.series[1].data, [[now, 37]]);
  assert.match(recovery.tooltip.formatter({ seriesName: recovery.series[1].name, value: [now, 37] }), /RMSSD 37 ms/);
  const sdnn = timelineChartOption(dto, { mode: 'time', hrvMethod: 'SDNN' });
  assert.equal(sdnn.yAxis[1].name, 'SDNN · ms');
  assert.deepEqual(sdnn.series[1].data, [[now - 60000, 99]]);
  assert.match(sdnn.tooltip.formatter({ seriesName: sdnn.series[1].name, value: [now - 60000, 99] }), /SDNN 99 ms/);
  assert.deepEqual(timelineChartOption({ ...dto, recoveryHrv: [] }, { mode: 'time' }).series[1].data, []);
});
test("current RMSSD pressure is distinct from daily aggregates and project sleep", () => {
  const fixture = makeFixture("24h", now);
  fixture.healthIndices.ruleVersion = "health-indices-v4-rmssd";
  fixture.healthIndices.pressure.hrvMethod = "RMSSD";
  fixture.healthIndices.pressure.score = null;
  fixture.healthIndices.pressure.reason = "short_baseline";
  const html = render(fixture);
  assert.match(html, /最近压力/);
  assert.match(html, /RMSSD · 个人基线不足/);
  assert.match(html, /至少 7 个合格历史日/);
  fixture.healthIndices.pressure.context = "nightly";
  assert.match(render(fixture), /最近夜间负荷/);
});
test("recorded pressure remains visible with its own time after the live deadline", () => {
  const fixture = makeFixture("24h", now);
  Object.assign(fixture.healthIndices.pressure, {
    score: 52, evidenceAt: now - 2 * 3600000, validUntil: now - 1,
    retained: true, reason: null,
  });
  const html = render(fixture);
  const cards = html.split('class="stats">')[1].split('01 / MOVEMENT')[0];
  assert.match(cards, /最近压力/);
  assert.match(cards, />52</);
  assert.match(cards, /10\/02 18:00/);
  assert.doesNotMatch(html, /评分已过期|等待新测量|有效至|已过期/);
});
test("warmup pressure explains the single-day baseline beside the current score", () => {
  const fixture = makeFixture("24h", now);
  fixture.healthIndices.ruleVersion = "health-indices-v5-rmssd-warmup";
  Object.assign(fixture.healthIndices.pressure, {
    hrvMethod: "RMSSD", confidence: "short_baseline", baselineDays: { hrv: 1, heart: 1 },
  });
  const html = render(fixture);
  const cards = html.split('class="stats">')[1].split('01 / MOVEMENT')[0];
  assert.match(cards, /短期基线/);
  assert.match(html, /各至少 1 个合格历史日/);
  assert.doesNotMatch(html, /RMSSD 独立基线需要至少 7/);
  fixture.healthIndices.pressure.context = "nightly";
  assert.match(render(fixture), /至少 7 个合格历史夜晚/);
});
test("data notes render native formulas and the configured watch automation source", () => {
  const fixture = makeFixture("24h", now);
  fixture.healthIndices.ruleVersion = "health-indices-v5-rmssd-warmup";
  fixture.healthIndices.pressure.hrvMethod = "RMSSD";
  const html = render(fixture);
  assert.match(html, /Apple Watch.*Apple 健康.*HealthRelay \/ HAE/);
  assert.match(html, /<math[^>]*aria-label="压力指数公式"/);
  assert.match(html, /<mfrac>/);
  assert.match(html, /<math[^>]*aria-label="每日压力中位数公式"/);
  fixture.healthIndices.pressure.context = "nightly";
  const nightly = render(fixture);
  assert.match(nightly, /R、H 为夜间中位数/);
  assert.doesNotMatch(nightly, /R、H 为近 20 分钟中位数/);
});
test("sleep and workouts use weekly data while the selected charts remain 24h", () => {
  const daily = makeFixture("24h", now);
  daily.workouts = [];
  const weekly = makeFixture("7d", now);
  weekly.workouts[0].name = "周末徒步";
  const html = render(daily, "24h", {
    snapshot: { range: "24h", data: daily, weeklyData: weekly, loading: false, error: null, stale: false },
  });
  assert.match(html, /近 7 天 · 每晚分期与时长/);
  assert.match(html, /近 7 天 · 已完成的活动/);
  assert.match(html, /周末徒步/);
  assert.equal((html.match(/<option value="[0-6]"/g) ?? []).length, 7);
  assert.match(html.replace(/<[^>]*>/g, ""), /心率 2 min 桶均值/);
});
test("missing weekly data shows a sync message instead of a daily fallback", () => {
  const daily = makeFixture("24h", now);
  daily.workouts[0].name = "仅日窗口运动";
  const html = render(daily, "24h", {
    snapshot: { range: "24h", data: daily, weeklyData: null, weeklyError: "waiting_first_sync", loading: false, error: null, stale: false },
  });
  assert.doesNotMatch(html, /仅日窗口运动/);
  assert.match(html, /近 7 天数据等待同步/);
});
test("selected sleep breakdown renders server values including a zero regularity score", () => {
  const fixture = makeFixture("7d", now);
  Object.assign(fixture.sleep.at(-1), { score: 67,
    components: { duration: 50, regularity: 0, continuity: 17.3 },
    bedtimeDeviationMinutes: 181, baselineDays: 12 });
  const html = render(fixture);
  const section = html.split('aria-label="睡眠评分拆解"')[1]?.split('</section>')[0] ?? '';
  assert.match(section, /时长/);
  assert.match(section, /50.*\/50/);
  assert.match(section, /就寝规律/);
  assert.match(section, />0<.*\/30/);
  assert.match(section, /连续性/);
  assert.match(section, /17.3.*\/20/);
  assert.match(section, /181.*min/);
  assert.match(section, /项目评分/);
  assert.doesNotMatch(section, /23:|07:/);
});
test("missing sleep components remain missing instead of borrowing the current score", () => {
  const fixture = makeFixture("7d", now);
  Object.assign(fixture.sleep.at(-1), { score: null, components: null, reason: 'short_sleep_baseline' });
  const html = render(fixture);
  const section = html.split('aria-label="睡眠评分拆解"')[1]?.split('</section>')[0] ?? '';
  assert.match(section, /睡眠历史不足/);
  assert.doesNotMatch(section, /86|>0</);
});
test("no awake observations shows an explanation instead of an empty pressure chart", () => {
  const fixture = makeFixture("24h", now);
  fixture.pressureHistory.points = [];
  fixture.pressureHistory.totalPoints = 0;
  fixture.healthIndices.pressure.score = null;
  fixture.healthIndices.pressure.reason = "short_baseline";
  const html = render(fixture);
  assert.match(html, /还没有有效清醒观测/);
  assert.match(html, /个人基线不足/);
  assert.doesNotMatch(html, /role="img" aria-label="压力轨迹"|重置压力轨迹缩放/);
});
test("renders empty dashboard without made-up measurements", () => {
  const html = render({ schemaVersion: "dashboard-v1", range: "24h" });
  assert.match(html, /暂无测量数据/);
  assert.match(html, /暂无评分/);
  assert.doesNotMatch(html, /NaN|undefined/);
});
test("renders all original semantics using genuine Ambient controls", () => {
  const fixture = makeFixture("7d", now);
  const html = render(fixture);
  for (const text of [
    "压力轨迹",
    "夜间观测",
    "置信度",
    "证据时间",
    "基线",
    "规则",
    "心率与恢复 HRV",
    "锻炼时段",
    "活动能量",
    "kcal",
    "当前签名",
    "户外跑步",
    "样本不足",
    "缺测",
    "来源冲突",
    "最新心率 68 bpm",
    "完整历史日中位",
    "当天未完",
    "压力指数怎么算",
    "签名合并 30 s、最短间隔 2 min",
    "看板按数据变化和时间边界更新",
  ])
    assert.ok(html.includes(text), text);
  assert.match(html, /ambx-panel/);
  assert.match(html, /role="radio"/);
  assert.match(html, /role="switch"/);
  assert.match(
    html,
    /aria-label="按天"[^>]*aria-checked="true"|aria-checked="true"[^>]*aria-label="按天"/,
  );
  assert.doesNotMatch(html, /NaN|undefined/);
});
test("activity details name their date and explain the unsynced day after midnight", () => {
  const midnight = Date.parse("2026-10-04T00:14:00+08:00");
  const html = render(
    {
      schemaVersion: "dashboard-v1",
      range: "24h",
      daily: [
        { date: "2026-10-03", metrics: { step_count: { v: 1234 } } },
        { date: "2026-10-04", metrics: {} },
      ],
    },
    "24h",
    { now: midnight },
  );
  assert.match(html, /aria-label="活动摘要日期"/);
  assert.match(html, /value="2026-10-04" selected=""/);
  assert.match(html, /今日活动尚未同步/);
  const details =
    html.match(/class="metric-grid">(.*?)<\/section>/s)?.[1] ??
    html.split('class="metric-grid">')[1];
  assert.doesNotMatch(details, /1,234/);
  assert.match(details, /待同步/);
});
test("renders hostile labels as text and discloses sampling without expiring recorded scores", () => {
  const fixture = makeFixture("7d", now);
  fixture.workouts[0].name = "<img src=x onerror=alert(1)>";
  fixture.healthIndices.pressure.validUntil = now - 1;
  fixture.pressureHistory.sampled = true;
  fixture.pressureHistory.totalPoints = 700;
  const html = render(fixture);
  assert.ok(!html.includes("<img src=x"));
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /评分已过期|已过期/);
  assert.match(html, /30\/700/);
});
test("permission-cleared snapshot contains no prior health readings", () => {
  const html = render({}, "24h", {
    snapshot: {
      data: null,
      range: "24h",
      error: { code: "permission_denied" },
      stale: false,
      loading: false,
    },
  });
  assert.match(html, /没有访问权限/);
  assert.doesNotMatch(html, /压力指数38|68 bpm/);
});
test("expired sessions offer only a configured HTTPS reopen destination", () => {
  const snapshot = { data: null, range: "24h", error: { code: "session_expired" }, loading: false };
  const html = render({}, "24h", { snapshot, reopenUrl: "https://example.com/health?view=dashboard" });
  assert.match(html, /href="https:\/\/example.com\/health\?view=dashboard"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /重新打开文档<\/a>/);
  for (const reopenUrl of [undefined, "", "javascript:alert(1)", "data:text/html,hi", "http://example.com", "//example.com", "/health", "https://user:password@example.com/"]) {
    const fallback = render({}, "24h", { snapshot, reopenUrl });
    assert.doesNotMatch(fallback, /class="reopen-link"|href=/, String(reopenUrl));
    assert.match(fallback, /页面会话已过期/);
    assert.match(fallback, /重试/);
  }
});
test("nightly explanation does not present the awake formula as the nightly model", () => {
  const fixture = makeFixture("24h", now);
  fixture.healthIndices.pressure.context = "nightly";
  const html = render(fixture);
  assert.match(html, /夜间恢复观测/);
  assert.match(html, /单独解释/);
});
test("uses the real scorer confidence vocabulary", () => {
  const fixture = makeFixture("24h", now);
  fixture.healthIndices.pressure.confidence = "personal_baseline";
  assert.match(render(fixture), /个人基线成熟/);
  fixture.healthIndices.pressure.confidence = "short_baseline";
  assert.match(render(fixture), /短期基线/);
});

test("isolated heart buckets remain visible SVG marks across measurement gaps", () => {
  const svg = renderSparseHeart({
    heart: {
      bucketMinutes: 2,
      points: [
        { s: now, v: 65, min: 60, max: 70 },
        { s: now + 3600000, v: 75, min: 70, max: 80 },
      ],
    },
  });
  assert.ok(
    (svg.match(/fill="#cd6358"/g) ?? []).length >= 2,
    "each isolated heart bucket needs a visible mark",
  );
});

test("sleep boundaries are private and evidence is confined to the final section", () => {
  const dto = makeFixture("7d", now);
  dto.sleep.at(-1).start = Date.parse("2026-10-01T22:17:00+08:00");
  dto.sleep.at(-1).end = Date.parse("2026-10-02T06:43:00+08:00");
  const html = render(dto);
  assert.doesNotMatch(html, /22:17|06:43|显示睡眠/);
  const end = html.indexOf('class="data-notes"');
  assert.ok(end > html.indexOf("CURRENT SIGNATURE"));
  assert.ok(html.indexOf("证据时间") > end);
  assert.ok(html.indexOf("压力指数怎么算") > end);
  assert.doesNotMatch(html.slice(0, end), /置信度|个人基线|规则 /);
});

test("pressure time axis starts at actual recording history and retains all sparse points", () => {
  const points = [0, 3600000, 7200000].map((offset, i) => ({
    t: now + offset,
    score: [67, 87, 74][i],
  }));
  const option = pressureChartOption({ since: now, points }, "time", {
    startAt: now - 7 * 86400000,
    endAt: now + 10800000,
  });
  assert.equal(option.xAxis.min, now);
  assert.deepEqual(
    option.series[0].data.map((p) => p.value),
    points.map((p) => [p.t, p.score]),
  );
  assert.doesNotMatch(
    option.tooltip.formatter({ value: [now, 74], data: {} }),
    /规则/,
  );
});
test("sleep tooltip never renders either sleep boundary", () => {
  const option = sleepChartOption([
    { date: "2026-10-02", start: now, end: now + 3600000, asleepMinutes: 60 },
  ]);
  assert.equal(
    option.tooltip.formatter({ dataIndex: 0, seriesName: "深睡", value: 1 }),
    "2026-10-02\n深睡 60 min",
  );
});
