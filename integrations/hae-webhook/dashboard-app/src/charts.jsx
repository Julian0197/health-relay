import { useEffect, useMemo, useRef } from "react";
import { init, use } from "echarts/core";
import { LineChart, BarChart, ScatterChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkAreaComponent,
  MarkLineComponent,
} from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import { AmbientButton } from "@ambientcss/components";
import {
  dailyMetricRows,
  finite,
  formatTime,
  heartDays,
  heartTimeline,
  hrvPoints,
  number,
  pressureDayRows,
  pressureReason,
} from "./model.mjs";
use([
  LineChart,
  BarChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkAreaComponent,
  MarkLineComponent,
  SVGRenderer,
]);

const teal = "#237f7c",
  coral = "#cd6358",
  violet = "#827ba8",
  ink = "#45585b";
const axis = {
  axisLine: { show: false },
  axisTick: { show: false },
  axisLabel: { color: "#52675a", fontSize: 12, hideOverlap: true },
  splitLine: { lineStyle: { color: "#edf0ed" } },
};
const coarsePointer = () =>
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
function base({ zoom = false, unit = "", time = false } = {}) {
  return {
    animation: false,
    color: [teal, coral, violet],
    textStyle: { fontFamily: "system-ui, sans-serif" },
    grid: { left: 46, right: 24, top: 57, bottom: zoom ? 65 : 30 },
    tooltip: {
      trigger: "item",
      renderMode: "richText",
      confine: true,
      backgroundColor: "#fff",
      borderColor: "#dae0dc",
      textStyle: { color: ink, fontSize: 12 },
    },
    legend: {
      top: 2,
      left: 4,
      itemWidth: 12,
      itemHeight: 7,
      textStyle: { color: ink, fontSize: 12 },
    },
    xAxis: {
      ...axis,
      type: time ? "time" : "category",
      splitNumber: 4,
      splitLine: { show: false },
      ...(time
        ? {
            axisLabel: {
              ...axis.axisLabel,
              formatter: (v) => formatTime(v).replace(" ", "\n"),
            },
          }
        : {}),
    },
    yAxis: {
      ...axis,
      type: "value",
      name: unit,
      nameTextStyle: { color: "#52675a", align: "right" },
    },
    ...(zoom
      ? {
          dataZoom: [
            {
              type: "slider",
              height: 16,
              bottom: 6,
              borderColor: "#e3e8e3",
              fillerColor: "#237f7c20",
              handleStyle: { color: teal },
              textStyle: { fontSize: 11 },
              labelFormatter: (v) => (time ? formatTime(v) : v),
            },
            {
              type: "inside",
              zoomOnMouseWheel: "ctrl",
              moveOnMouseWheel: false,
              // On touch screens a swipe over a chart must keep scrolling the page; the slider zooms.
              ...(coarsePointer() ? { moveOnMouseMove: false, preventDefaultMouseMove: false } : {}),
            },
          ],
        }
      : {}),
  };
}
export function Chart({ option, label, zoom = false, onSelect }) {
  const node = useRef(null),
    chart = useRef(null);
  useEffect(() => {
    const c = init(node.current, null, { renderer: "svg" });
    chart.current = c;
    const observer = new ResizeObserver(() => c.resize());
    observer.observe(node.current);
    return () => {
      observer.disconnect();
      chart.current = null;
      c.dispose();
    };
  }, []);
  useEffect(() => {
    chart.current?.setOption(option, {
      replaceMerge: ["series", "xAxis", "yAxis"],
    });
  }, [option]);
  useEffect(() => {
    if (!onSelect) return;
    const fn = (event) => onSelect(event.dataIndex, event);
    chart.current?.on("click", fn);
    return () => chart.current?.off("click", fn);
  }, [onSelect]);
  return (
    <div className="chart-shell">
      <div ref={node} className="chart" role="img" aria-label={label} />
      {zoom && (
        <div className="zoom-caption">
          <span>拖动底部滑块缩放 · Ctrl + 滚轮</span>
          <AmbientButton
            size="sm"
            onPress={() =>
              chart.current?.dispatchAction({
                type: "dataZoom",
                start: 0,
                end: 100,
              })
            }
            aria-label={`重置${label}缩放`}
          >
            重置视图
          </AmbientButton>
        </div>
      )}
    </div>
  );
}
export function workoutChartOption(records, { range = '7d', now = Date.now(), selectedIndex = 0 } = {}) {
  const o = base({ time: true, unit: 'kcal', zoom: true });
  const known = [], missing = [];
  records.forEach((record, workoutIndex) => {
    const hasEnergy = finite(record.activeEnergyKcal);
    const selected = workoutIndex === selectedIndex;
    (hasEnergy ? known : missing).push({
      value: [record.start, hasEnergy ? record.activeEnergyKcal : 0], workoutIndex,
      symbolSize: selected ? 20 : 15,
      itemStyle: { color: selected ? teal : '#8bb9ae', borderColor: selected ? teal : '#fff', borderWidth: selected ? 2 : 1 },
    });
  });
  const timeAxis = { ...o.xAxis, min: now - (range === '30d' ? 30 : 7) * 86400000, max: now,
    axisLabel: { ...axis.axisLabel, formatter: value => formatTime(value).split(' ')[0] } };
  o.legend = { show: false };
  o.grid = [{ ...o.grid, top: 30 }];
  o.xAxis = [{ ...timeAxis, gridIndex: 0 }];
  const missingAxis = { ...axis, type: 'category', data: ['缺测'], splitLine: { show: false } };
  o.yAxis = [known.length ? { ...o.yAxis, min: 0 } : missingAxis];
  o.series = [];
  if (known.length) o.series.push({ id: 'workout-energy', name: '活动消耗', type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: known });
  if (missing.length) {
    const index = known.length ? 1 : 0;
    if (index) {
      o.grid[0].bottom = 112;
      o.grid.push({ left: 46, right: 24, bottom: 64, height: 24 });
      o.xAxis.push({ ...timeAxis, gridIndex: 1, axisLabel: { show: false }, axisLine: { show: false }, axisTick: { show: false } });
      o.yAxis.push({ ...missingAxis, gridIndex: 1 });
    }
    o.series.push({ id: 'workout-missing', name: '消耗缺测', type: 'scatter', symbol: 'emptyCircle',
      xAxisIndex: index, yAxisIndex: index, data: missing });
  }
  o.dataZoom.forEach(zoom => { zoom.xAxisIndex = o.xAxis.map((_, index) => index); });
  o.tooltip.triggerOn = 'mousemove|click';
  o.tooltip.formatter = point => {
    const record = records[point.data.workoutIndex];
    const energy = finite(record.activeEnergyKcal) ? `活动消耗 ${number(record.activeEnergyKcal)} kcal` : '活动消耗缺测';
    return `${record.name} · ${formatTime(record.start)}\n${energy} · 时长 ${number(record.durationMs / 60000)} min\n平均 ${number(record.heart?.avg)} · 最高 ${number(record.heart?.max)} bpm`
      + (finite(record.recovery?.drop1m) ? `\n1 分钟降幅 ${number(record.recovery.drop1m)} bpm` : '');
  };
  return o;
}
export function WorkoutChart({ records, range, now, selectedIndex, onSelect }) {
  const option = useMemo(() => workoutChartOption(records, { range, now, selectedIndex }), [records, range, now, selectedIndex]);
  return <div className="workout-timeline"><Chart key={range} option={option} label="锻炼时间线" zoom
    onSelect={(_, event) => { if (Number.isInteger(event.data?.workoutIndex)) onSelect(event.data.workoutIndex); }} /></div>;
}
export function pressureChartOption(history, mode, window) {
  if (mode === "day") {
    const rows = pressureDayRows(history),
      o = base({ unit: "指数" });
    o.xAxis.data = rows.map((r) => r.date.slice(5).replace("-", "/"));
    o.yAxis.max = 100;
    o.tooltip.formatter = (p) => {
      const r = rows[p.dataIndex];
      return `${r.date}${r.partial ? " · 当天未完" : ""}\n中位 ${number(r.value)} · 四分位 ${number(r.q1)}–${number(r.q3)}\n${r.count ?? 0} 个样本 · 覆盖 ${number(r.spanMinutes)} min\n>60 样本占比 ${finite(r.highFraction) ? number(r.highFraction * 100) + "%" : "—"}`;
    };
    o.series = [
      {
        type: "bar",
        stack: "iqr",
        data: rows.map((r) => (r.value === null ? null : r.q1)),
        itemStyle: { color: "transparent" },
        silent: true,
        barWidth: 24,
        tooltip: { show: false },
      },
      {
        name: "四分位区间",
        type: "bar",
        stack: "iqr",
        data: rows.map((r) => (r.value === null ? null : r.q3 - r.q1)),
        itemStyle: { color: "#9acbc4", borderRadius: 5 },
        barWidth: 24,
      },
      {
        name: "每日中位",
        type: "scatter",
        data: rows.map((r) => r.value),
        symbolSize: 9,
        itemStyle: { color: teal, borderColor: "#fff", borderWidth: 2 },
      },
    ];
    return o;
  }
  const o = base({ time: true, unit: "指数", zoom: true });
  o.yAxis.max = 100;
  o.xAxis.min = finite(history?.since)
    ? Math.max(window?.startAt ?? history.since, history.since)
    : window?.startAt;
  o.xAxis.max = window?.endAt;
  o.tooltip.formatter = (p) =>
    `${formatTime(p.value[0])}\n清醒压力 ${number(p.value[1])}`;
  o.series = [
    {
      name: "清醒观测",
      type: "scatter",
      symbolSize: 9,
      itemStyle: { color: teal },
      data: (history?.points ?? []).map((p) => ({
        value: [p.t, p.score],
        ruleVersion: p.ruleVersion,
      })),
    },
  ];
  return o;
}
export function PressureChart({ history, mode, window }) {
  const option = useMemo(
    () => pressureChartOption(history, mode, window),
    [history, mode, window],
  );
  return (
    <Chart
      key={`${mode}:${window?.endAt - window?.startAt}`}
      option={option}
      label="压力轨迹"
      zoom={mode === "time"}
    />
  );
}
export function heartLineSeries(dto, areas = []) {
  return {
    name: "心率",
    type: "line",
    showSymbol: true,
    symbol: "circle",
    symbolSize: 3,
    connectNulls: false,
    lineStyle: { color: coral, width: 1.5 },
    itemStyle: { color: coral },
    data: heartTimeline(dto).map((p) => ({
      value: [p.s, p.v],
      min: p.min,
      max: p.max,
    })),
    markArea: { silent: true, data: areas },
  };
}
export function timelineChartOption(dto, { overlay = true, mode = "time", hrvMethod = "RMSSD" } = {}) {
  if (mode === "day") {
    const rows = heartDays(dto),
      o = base({ unit: "bpm" });
    o.xAxis.data = rows.map((r) => r.date.slice(5).replace("-", "/"));
    o.tooltip.formatter = (p) => {
      const r = rows[p.dataIndex];
      return `${r.date}\n范围 ${number(r.min)}–${number(r.max)} bpm\n桶均值 ${number(r.avg, 1)} bpm · ${r.count} 桶`;
    };
    o.series = [
      {
        type: "bar",
        stack: "range",
        data: rows.map((r) => r.min),
        itemStyle: { color: "transparent" },
        silent: true,
        barWidth: 18,
        tooltip: { show: false },
      },
      {
        name: "每日心率范围",
        type: "bar",
        stack: "range",
        data: rows.map((r) => r.max - r.min),
        itemStyle: { color: "#e8b4ab", borderRadius: 6 },
        barWidth: 18,
      },
      {
        name: "桶均值",
        type: "scatter",
        data: rows.map((r) => r.avg),
        symbolSize: 7,
        itemStyle: { color: coral, borderColor: "#fff", borderWidth: 1 },
      },
    ];
    return o;
  }
  const o = base({ time: true, zoom: true, unit: "bpm" });
  o.grid.right = 44;
  o.xAxis.min = dto.window?.startAt;
  o.xAxis.max = dto.window?.endAt;
  o.yAxis = [
    o.yAxis,
    {
      ...axis,
      type: "value",
      name: `${hrvMethod} · ms`,
      position: "right",
      splitLine: { show: false },
      nameTextStyle: { color: violet, align: "right" },
    },
  ];
  const areas = overlay
    ? [
        ...(dto.workouts ?? []).map((w) => [
          { xAxis: w.start, itemStyle: { color: "#dfaf4920" } },
          { xAxis: w.end },
        ]),
      ]
    : [];
  const hrvLabel = hrvMethod === "SDNN" ? "HRV（SDNN）" : "恢复 HRV（RMSSD）";
  o.tooltip.formatter = (p) =>
    p.seriesName === hrvLabel
      ? `${formatTime(p.value[0])}\n${hrvMethod} ${number(p.value[1])} ms · 独立采样`
      : `${formatTime(p.value[0])}\n心率 ${number(p.value[1])} bpm\n桶内 ${number(p.data.min)}–${number(p.data.max)} bpm`;
  o.series = [
    heartLineSeries(dto, areas),
    {
      name: hrvLabel,
      type: "scatter",
      yAxisIndex: 1,
      symbolSize: 8,
      itemStyle: { color: violet, borderWidth: 2, borderColor: "#fff" },
      data: hrvPoints(dto, hrvMethod).map((p) => [p.t, p.v]),
    },
  ];
  return o;
}
export function TimelineChart({ dto, overlay, mode, hrvMethod = "RMSSD" }) {
  const option = useMemo(() => timelineChartOption(dto, { overlay, mode, hrvMethod }), [dto, overlay, mode, hrvMethod]);
  return (
    <Chart
      key={`${dto.range}:${mode}:${hrvMethod}`}
      option={option}
      label={mode === "day" ? "每日心率范围" : hrvMethod === "SDNN" ? "心率与 HRV（SDNN）" : "心率与恢复 HRV"}
      zoom={mode === "time"}
    />
  );
}
export function sleepChartOption(nights) {
  const o = base({ unit: "小时" });
  o.xAxis.data = nights.map((n) => n.date.slice(5).replace("-", "/"));
  const stages = [
    ["deep", "深睡", "#576e99"],
    ["core", "核心睡眠", "#9fbbd2"],
    ["rem", "REM", "#aca5cb"],
    ["awake", "清醒", "#e2b887"],
  ];
  // Unspecified sleep is kept separate; it must not silently disappear from totals.
  const values = (n) => ({
    ...n.stages,
    awake: n.awakeMinutes,
    unspecified: Math.max(
      0,
      (n.asleepMinutes ?? 0) -
        ["deep", "core", "rem"].reduce((s, k) => s + (n.stages?.[k] ?? 0), 0),
    ),
  });
  stages.push(["unspecified", "未分期", "#d2d9dd"]);
  o.tooltip.formatter = (p) => {
    const n = nights[p.dataIndex];
    return `${n.date}${n.conflict ? " · 来源冲突" : ""}\n${p.seriesName} ${number(p.value * 60)} min`;
  };
  o.series = stages.map(([key, name, color]) => ({
    name,
    type: "bar",
    stack: "sleep",
    barMaxWidth: 32,
    itemStyle: { color },
    data: nights.map((n) => ({
      value: (values(n)[key] ?? 0) / 60,
      itemStyle: { color, opacity: n.conflict ? 0.5 : 1 },
    })),
  }));
  return o;
}
export function SleepChart({ nights, onSelect }) {
  const option = useMemo(() => sleepChartOption(nights), [nights]);
  return <Chart option={option} label="睡眠分期" onSelect={onSelect} />;
}
export function ActivityChart({ dto, metric, now }) {
  const option = useMemo(() => {
    const { rows, median } = dailyMetricRows(dto, metric.key, now),
      o = base({ unit: metric.unit });
    o.xAxis.data = rows.map((r) => r.date.slice(5).replace("-", "/"));
    o.tooltip.formatter = (p) => {
      const r = rows[p.dataIndex];
      return `${r.date}${r.partial ? " · 当天未完" : ""}\n${metric.label} ${number(r.value, 1)} ${metric.unit}${r.reason ? "\n" + pressureReason(r.reason) : ""}`;
    };
    o.series = [
      {
        name: metric.label,
        type: "bar",
        barMaxWidth: 28,
        data: rows.map((r) => ({
          value: r.value,
          itemStyle: {
            color: r.partial ? teal : "#a9c7bb",
            borderRadius: [5, 5, 0, 0],
          },
        })),
        ...(finite(median)
          ? {
              markLine: {
                symbol: "none",
                silent: true,
                lineStyle: { color: "#94a099", type: "dashed" },
                label: { show: false },
                data: [{ yAxis: median }],
              },
            }
          : {}),
      },
    ];
    return o;
  }, [dto, metric, now]);
  return <Chart key={metric.key} option={option} label={metric.label} />;
}
