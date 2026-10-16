import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { DataFlow } from "./DataFlow.jsx";
import { safeReopenUrl } from "./config.mjs";
import {
  AmbientProvider,
  AmbientPanel,
  AmbientButton,
  AmbientSelect,
  AmbientSwitch,
} from "@ambientcss/components";
import {
  ActivityChart,
  PressureChart,
  SleepChart,
  TimelineChart,
  WorkoutChart,
} from "./charts.jsx";
import {
  beijingDate,
  workoutIcon,
  workoutView,
  dailyMetricRows,
  activitySummary,
  dataCoverage,
  finite,
  formatTime,
  freshness,
  median,
  hrvPoints,
  metrics,
  number,
  pressureDayRows,
  pressureHeadline,
  pressureLabels,
  pressureMode,
  pressureReason,
  signatureText,
} from "./model.mjs";

const stateLabels = {
  ...pressureLabels,
  excellent: "好眠",
  good: "尚可",
  fair: "欠佳",
  rest_needed: "待恢复",
};
const errorLabels = {
  timeout: "读取超时，请重试",
  permission_denied: "没有访问权限，请确认数据源授权后重新打开",
  session_expired: "页面会话已过期，请重新打开文档",
  waiting_first_sync: "等待首次数据同步",
  bad_response: "数据格式异常，请稍后重试",
  base_record_missing: "未找到数据记录",
  base_read_failed: "数据源读取失败，请稍后重试",
  unknown: "读取失败，请重试",
};
const confidenceLabels = {
  personal_baseline: "个人基线成熟",
  short_baseline: "短期基线",
  high: "高",
  medium: "中",
  low: "低",
};
function Selector({ label, value, onChange, options }) {
  return (
    <AmbientSelect
      aria-label={label}
      orientation="horizontal"
      size="sm"
      value={value}
      onChange={onChange}
      options={options.map(([value, label]) => ({
        value,
        label,
        ariaLabel: label,
      }))}
    />
  );
}
function Panel({ index, title, subtitle, controls, children, className = "" }) {
  return (
    <AmbientPanel material="matte" className={`panel ${className}`}>
      <div className="panel-head">
        <div>
          <div className="section-id">{index}</div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <div className="controls">{controls}</div>
      </div>
      {children}
    </AmbientPanel>
  );
}
function Stat({ label, value, unit, caption, detail, tone, progress, compact = false }) {
  return (
    <AmbientPanel material="matte" className={`stat ${tone ?? ""}${compact ? " stat-compact" : ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        {number(value)}
        {finite(value) && <span>{unit}</span>}
      </div>
      <div className="stat-caption">{caption}</div>
      {detail && <div className="stat-detail">{detail}</div>}
      {finite(progress) && (
        <div className="meter" aria-hidden="true">
          <i style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
        </div>
      )}
    </AmbientPanel>
  );
}
function Workouts({ dto, now, emptyText }) {
  const [range, setRange] = useState("7d");
  const [selectedKey, setSelectedKey] = useState(null);
  const view = useMemo(() => workoutView(dto, range, now), [dto, range, now]);
  const recordKey = w => `${w.start}:${w.end}:${w.name}`;
  const selected = view.records.find(w => recordKey(w) === selectedKey) ?? view.records[0];
  const selectedIndex = view.records.indexOf(selected);
  return <Panel index="01 / MOVEMENT" title="锻炼记录" className="movement-panel"
    subtitle={`${range === "30d" ? "近 30 天" : "近 7 天"} · 已完成的活动 · 至少 20 分钟`}
    controls={<Selector label="锻炼时间范围" value={range} onChange={value => { setRange(value); setSelectedKey(null); }}
      options={[["7d", "近 7 天"], ["30d", "近 30 天"]]} />}>
    {view.available ? <>
      <div className="workout-totals" aria-label="锻炼汇总">
        <span>活动消耗 <b>{number(view.kcal)}</b> kcal
          {view.energyCount < view.records.length && <small> · {view.energyCount}/{view.records.length} 条有数据</small>}
        </span>
        <span>总时长 <b>{number(view.durationMs / 60000)}</b> min</span>
        <span>锻炼 <b>{view.records.length}</b> 次</span>
      </div>
      {selected ? <>
        <WorkoutChart records={view.records} range={range} now={now} selectedIndex={selectedIndex}
          onSelect={index => setSelectedKey(recordKey(view.records[index]))} />
        <p className="meta-line">节点代表一次锻炼的活动消耗；悬浮查看摘要，点击节点切换详情。空心节点在缺测轨道显示。</p>
        <label className="select-label workout-detail-picker">查看详情
          <select aria-label="选择锻炼记录" value={recordKey(selected)} onChange={event => setSelectedKey(event.target.value)}>
            {view.records.map(w => <option key={recordKey(w)} value={recordKey(w)}>{formatTime(w.start)} · {w.name}</option>)}
          </select>
        </label>
        <WorkoutDetail workout={selected} />
      </> : <p className="muted">所选范围暂无至少 20 分钟的锻炼</p>}
    </> : <p className="muted">{range === "30d" ? "近 30 天锻炼数据等待同步" : emptyText ?? "锻炼数据等待同步"}</p>}
    <p className="meta-line">仅汇总已收到且至少 20 分钟的锻炼。活动消耗为设备估计；恢复心率只用专属恢复测量，缺失时不估算。</p>
  </Panel>;
}
function WorkoutDetail({ workout: w }) {
  return <article className="workout-card workout-detail">
    <div className="workout-row">
      <span className="workout-symbol" aria-hidden="true">{workoutIcon(w.name)}</span>
      <div><b>{w.name}</b><span>{formatTime(w.start)} — {formatTime(w.end)}</span></div>
    </div>
    <div className="workout-metrics">
      <span>活动消耗 <b>{number(w.activeEnergyKcal)} <small>kcal</small></b></span>
      <span>时长 <b>{number(w.durationMs / 60000)} <small>min</small></b></span>
      <span>平均心率 <b>{number(w.heart?.avg)} <small>bpm</small></b></span>
      <span>最高心率 <b>{number(w.heart?.max)} <small>bpm</small></b></span>
    </div>
    {finite(w.recovery?.drop1m) && <p className="workout-recovery">恢复心率 · 1 分钟降幅 <b>{number(w.recovery.drop1m)} bpm</b></p>}
    <p className="workout-note">
      {w.heart?.basis === "matched_minutes" ? `运动时段匹配 · 心率覆盖 ${number(w.heart.coveredMinutes)} min`
        : w.heart?.basis === "workout_series" ? "运动专属采样 · 心率为采样均值"
          : w.heart?.basis === "workout_summary" ? "心率来自锻炼摘要" : "暂无可用运动心率"}
      {w.durationBasis === "elapsed" && " · 旧记录按起止跨度计时"}
    </p>
  </article>;
}
function Pressure({ dto, range }) {
  const h = dto.pressureHistory;
  const signal = dto.healthIndices?.pressure?.hrvMethod === "RMSSD" ? "恢复 HRV（RMSSD）" : "HRV（SDNN）";
  const [mode, setMode] = useState(() => pressureMode(range, h));
  useEffect(() => setMode(pressureMode(range, h)), [range]);
  const hasObservations = mode === "day"
    ? pressureDayRows(h).some((row) => finite(row.value))
    : (h?.points ?? []).some((point) => finite(point.score));
  return (
    <Panel
      index="02 / PRESSURE"
      title="压力轨迹"
      subtitle={
        mode === "day"
          ? `基于${signal}与配对心率 · 每日中位与四分位区间`
          : `基于${signal}与配对心率 · 每个点为有效清醒评分`
      }
      controls={
        <Selector
          label="压力显示方式"
          value={mode}
          onChange={setMode}
          options={[
            ["time", "按时间"],
            ["day", "按天"],
          ]}
        />
      }
    >
      {hasObservations ? (
        <PressureChart history={h} mode={mode} window={dto.window} />
      ) : (
        <div className="chart-empty" role="status">
          <span className="empty-symbol" aria-hidden="true">—</span>
          <b>{mode === "day" ? "全天汇总还在积累" : "还没有有效清醒观测"}</b>
          <p>{mode === "day"
            ? "每天至少 3 次有效观测、跨度达到 2 小时后显示汇总。可以切换到按时间查看已有观测。"
            : dto.healthIndices?.pressure?.reason
              ? `${pressureReason(dto.healthIndices.pressure.reason)}，满足条件后会记录有效观测。`
              : "有效观测会随数据同步逐步积累，缺测不会按零分展示。"}</p>
        </div>
      )}
      <p className="meta-line">
        已记录 {h?.totalPoints ?? h?.points?.length ?? 0} 次清醒观测
        {mode === "time" && !pressureDayRows(h).some((row) => finite(row.value)) && hasObservations
          ? " · 全天汇总待积累" : ""}
      </p>
      <div className="night-strip">
        <span className="night-label">夜间观测</span>
        {h?.nights?.length ? (
          h.nights.map((n, i) => (
            <span key={`${n.t}-${i}`}>
              <time>{beijingDate(n.t) ?? "—"}</time>
              <b>{number(n.score)}</b>
            </span>
          ))
        ) : (
          <span className="muted">暂无夜间观测</span>
        )}
      </div>
    </Panel>
  );
}
function DataNotes({ dto, now }) {
  const p = dto.healthIndices?.pressure ?? {},
    h = dto.pressureHistory,
    nightly = p.context === "nightly",
    rmssd = p.hrvMethod === "RMSSD";
  // Nightly evidence can coincide with sleep end; only disclose its calendar date.
  const evidence = nightly
    ? (beijingDate(p.evidenceAt) ?? "—")
    : formatTime(p.evidenceAt);
  return (
    <section className="data-notes" aria-label="口径与数据说明">
      <h2>口径与数据说明</h2>
      <p className="data-source">
        <b>数据来源</b> Apple Watch → Apple 健康 → HealthRelay / HAE → 看板
      </p>
      <div className="notes-formulas">
        <div className="formula-card">
          <h3>{nightly ? "夜间恢复观测" : "最近压力"}</h3>
          <math display="block" aria-label="压力指数公式">
            <mi>P</mi><mo>=</mo><mi mathvariant="normal">round</mi><mo>(</mo>
            <mfrac>
              <mn>100</mn>
              <mrow><mn>1</mn><mo>+</mo><msup><mi>e</mi><mrow><mo>−</mo><mi>z</mi></mrow></msup></mrow>
            </mfrac>
            <mo>)</mo>
          </math>
          <math display="block" aria-label="压力信号权重">
            <mi>z</mi><mo>=</mo><mn>0.6</mn><msub><mi>z</mi><mi>R</mi></msub>
            <mo>+</mo><mn>0.4</mn><msub><mi>z</mi><mi>H</mi></msub>
          </math>
          <p>{nightly ? "R、H 为夜间中位数" : rmssd ? "R、H 为近 20 分钟中位数" : "R 为最新 HRV，H 为配对心率"}</p>
          <p>R = {rmssd ? "恢复 HRV（RMSSD）" : "HRV（SDNN）"}；H = 配对心率</p>
        </div>
        <div className="formula-card">
          <h3>今日压力</h3>
          <math display="block" aria-label="每日压力中位数公式">
            <msub><mi>P</mi><mtext>日</mtext></msub><mo>=</mo>
            <mi mathvariant="normal">median</mi><mo>(</mo><msub><mi>P</mi><mi>i</mi></msub><mo>)</mo>
          </math>
          <p>同规则、同设备的清醒观测</p>
          <p>n ≥ 3，跨度 ≥ 120 min</p>
          <p>色带 = [Q₂₅, Q₇₅]；&gt;60 为样本占比</p>
        </div>
      </div>
      <p>清醒统计剔除睡眠、运动及其后 1 h；缺测不补零。夜间观测单独解释。</p>
      <p>轨迹只记录实际有效评分；最近压力卡片保留原评分及其测量时间，不向后延伸轨迹。</p>
      <details>
        <summary>压力指数怎么算</summary>
        <div className="formula-details">
          <span>z<sub>R</sub> = clip((b<sub>R</sub> − ln R) / s<sub>R</sub>)</span>
          <span>z<sub>H</sub> = clip((H − b<sub>H</sub>) / s<sub>H</sub>)</span>
          <span>b<sub>R</sub> = median(ln R<sub>d</sub>)</span>
          <span>b<sub>H</sub> = median(H<sub>d</sub>)</span>
          <span>s<sub>R</sub> = max(1.4826 MAD(ln R<sub>d</sub>), ln 1.15)</span>
          <span>s<sub>H</sub> = max(1.4826 MAD(H<sub>d</sub>), 5 bpm)</span>
        </div>
        <p>d 为合格历史{nightly ? "夜晚" : "日"}；MAD 为中位绝对偏差；clip 限于 [−3, 3]。基线按同设备、同方法{nightly ? "计算" : "、相近时段计算"}。</p>
        {nightly ? (
          <p>夜间基线：{rmssd ? "RMSSD 至少 7 个合格历史夜晚" : "HRV ≥ 3 个合格历史夜晚"}，心率 ≥ 3 晚；不计入今日压力。</p>
        ) : rmssd ? (
          <>
            <p>20 min 窗口：RMSSD ≥ 3 点、跨度 ≥ 10 min；HR ≥ 10 点。按测量时点计算，保留最近有效评分。</p>
            <p>
              {dto.healthIndices?.ruleVersion === "health-indices-v5-rmssd-warmup"
                ? "初估：两项各至少 1 个合格历史日；成熟：RMSSD ≥ 14 天，心率 ≥ 3 天。"
                : `RMSSD 至少 ${p.baselineRequirement?.hrv ?? 7} 个合格历史日（当日 ≥ 3 点、跨度 ≥ 10 min），心率 ≥ ${p.baselineRequirement?.heart ?? 3} 天（当日 ≥ 10 分钟）；≥ 14 天为成熟基线。`}
              SDNN 仅作独立参考，不参与 RMSSD 压力评分。
            </p>
          </>
        ) : (
          <p>两项基线各 ≥ 3 个合格历史日。</p>
        )}
      </details>
      <details>
        <summary>已收到哪些数据</summary>
        <p>测量 / 记录时间；收到 ≠ 可评分。最近接收 <time>{formatTime(dto.receivedAt)}</time>，接收时间不是测量时间。</p>
        <div className="data-coverage" role="list">
          {dataCoverage(dto, now).map((row) => (
            <div className="coverage-row" role="listitem" key={row.key}>
              <b>{row.label}</b>
              <span>{row.latest}</span>
              <span>{row.status}</span>
            </div>
          ))}
        </div>
        <p>
          证据时间 {evidence} · {p.score != null ? "最近有效记录" : "测量记录"}
        </p>
        <p>
          {nightly ? "夜间恢复观测" : p.context === "awake_sample" ? "清醒采样" : "—"}
          {" · "}置信度 {confidenceLabels[p.confidence] ?? "—"}
          {p.baselineDays && <> · 基线 {p.hrvMethod ?? "SDNN"} {p.baselineDays.hrv} 天 / 心率 {p.baselineDays.heart} 天</>}
        </p>
        <p>
          规则 {dto.healthIndices?.ruleVersion ?? "—"}
          {p.score == null ? ` · ${pressureReason(p.reason)}` : ""}
          {" · "}历史始于 {beijingDate(h?.since) ?? "—"}，不回填起点前的压力。
        </p>
        <p>
          {pressureDayRows(h)
            .filter((r) => r.value === null || r.partial)
            .map((r) => `${r.date} · ${r.value === null ? pressureReason(r.status) : "当天未完"}`)
            .join("；")}
        </p>
        {h?.sampled && <p>散点抽样 {(h.points ?? []).length}/{h.totalPoints}；日统计用全部样本。</p>}
        {dto.heart?.truncated && <p>心率展示最近 {dto.heart.cap} 点。</p>}
      </details>
      <details>
        <summary>心率、睡眠与锻炼口径</summary>
        <div className="notes-chart-key">
          <p><b>心率</b> {dto.heart?.bucketMinutes ?? 1} min 桶均值；日范围 = min–max，圆点 = mean(桶均值)。</p>
          <p><b>恢复 HRV</b> 默认展示 RMSSD 独立测量点；SDNN 可切换参考。两种方法分开统计，数值与基线不混用。</p>
          <p><b>睡眠</b> 日期 / 分期 / 时长；睡眠评分由本项目计算，尚未接入 Apple 原生评分。</p>
          <p><b>锻炼</b> 默认近 7 天，可切换近 30 天；仅计入 ≥20 min 的记录。活动消耗统一 kcal；时长优先锻炼记录，旧记录用起止跨度。心率注明摘要或时段匹配；1 分钟恢复降幅要求结束时及 1 分钟后的专属测量，不作健康评级。</p>
        </div>
      </details>
      <details className="flow-details">
        <summary>数据如何变成看板与签名</summary>
        <DataFlow showTitle={false} />
      </details>
    </section>
  );
}
function Physiology({ dto, range }) {
  const [overlay, setOverlay] = useState(true),
    [mode, setMode] = useState("time"),
    [hrvMethod, setHrvMethod] = useState("RMSSD");
  const latest = dto.heart?.latest,
    hrv = hrvPoints(dto, hrvMethod);
  const scoringSignal = dto.healthIndices?.pressure?.hrvMethod === "RMSSD" ? "恢复 HRV（RMSSD）" : "HRV（SDNN）";
  return (
    <Panel
      index="03 / SIGNALS"
      title={mode === "day" ? "每日心率范围" : hrvMethod === "SDNN" ? "心率与 HRV（SDNN）" : "心率与恢复 HRV"}
      subtitle={`最新心率 ${number(latest?.v)} bpm · ${formatTime(latest?.e)}`}
      controls={
        <>
          {mode === "time" && <Selector
            label="HRV 指标"
            value={hrvMethod}
            onChange={setHrvMethod}
            options={[["RMSSD", "恢复 HRV"], ["SDNN", "HRV（SDNN）"]]}
          />}
          <Selector
            label="心率显示方式"
            value={mode}
            onChange={setMode}
            options={[
              ["time", "时间轴"],
              ["day", "每日范围"],
            ]}
          />
        </>
      }
    >
      <TimelineChart dto={dto} overlay={overlay} mode={mode} hrvMethod={hrvMethod} />
      {mode === "time" ? (
        <>
          <div className="chart-controls">
            <AmbientSwitch
              size="sm"
              value={overlay}
              onChange={setOverlay}
              aria-label="显示锻炼时段"
            />
            <span>
              锻炼时段 <i className="swatch workout" />
            </span>
          </div>
        </>
      ) : null}
      <div className="telemetry">
        <span>
          最新分钟范围{" "}
          <b>
            {number(latest?.min)}–{number(latest?.max)} bpm
          </b>
        </span>
        <span>
          {hrvMethod} 中位 <b>{number(median(hrv.map((p) => p.v)))} ms</b>
        </span>
        <span>
          {hrvMethod} 采样 <b>{hrv.length} 次</b>
        </span>
      </div>
      <p className="meta-line">{mode === "day" ? "每日范围仅展示心率；HRV 统计对应所选时间范围。" : `图中 ${hrvMethod} 为独立测量点；压力评分使用${scoringSignal}的合格窗口与配对心率。`}</p>
    </Panel>
  );
}
function Sleep({ dto, emptyText }) {
  const nights = dto?.sleep ?? [],
    [selected, setSelected] = useState(null);
  const index =
      selected == null
        ? nights.length - 1
        : Math.min(selected, nights.length - 1),
    night = nights[index];
  return (
    <Panel
      index="05 / RECOVERY"
      title="睡眠"
      subtitle="近 7 天 · 每晚分期与时长"
      controls={
        nights.length > 0 && (
          <label className="select-label">
            选择夜晚
            <select
              aria-label="选择睡眠夜晚"
              value={index}
              onChange={(e) => setSelected(Number(e.target.value))}
            >
              {nights.map((n, i) => (
                <option key={`${n.date}-${i}`} value={i}>
                  {n.date}
                  {n.conflict ? " · 来源冲突" : ""}
                </option>
              ))}
            </select>
          </label>
        )
      }
    >
      <SleepChart nights={nights} onSelect={setSelected} />
      {night ? (
        <>
          <div className="sleep-detail">
            <div>
              <span>睡眠时长</span>
              <strong>
                {number(night.asleepMinutes / 60, 1)}
                <small> h</small>
              </strong>
            </div>
            <div>
              <span>清醒</span>
              <strong>
                {number(night.awakeMinutes)}
                <small> min</small>
              </strong>
            </div>
            <div>
              <span>{night.date}</span>
              <b>睡眠记录</b>
            </div>
          </div>
          <section className="sleep-breakdown" aria-label="睡眠评分拆解">
            <p className="sleep-breakdown-heading">
              {night.date} · 项目评分 {finite(night.score) ? `${night.score}/100` : "—"}
            </p>
            {night.components ? (
              <>
                <div className="sleep-score-grid">
                  <div>
                    <span>时长</span>
                    <strong>{number(night.components.duration, 1)}<small>/50</small></strong>
                    <p>已睡 {number(night.asleepMinutes / 60, 1)} h · 满 8 h 得满分</p>
                  </div>
                  <div>
                    <span>就寝规律</span>
                    <strong>{number(night.components.regularity, 1)}<small>/30</small></strong>
                    <p>入睡习惯偏差 {number(night.bedtimeDeviationMinutes)} min · {night.baselineDays} 晚参考</p>
                  </div>
                  <div>
                    <span>连续性</span>
                    <strong>{number(night.components.continuity, 1)}<small>/20</small></strong>
                    <p>清醒 {number(night.awakeMinutes)} min · 按睡眠时长占比计算</p>
                  </div>
                </div>
                <details>
                  <summary>计算方式</summary>
                  <p>时长：50 × min(睡眠分钟 ÷ 480, 1)。</p>
                  <p>就寝规律：30 × max(1 − 入睡偏差分钟 ÷ 120, 0)；参考过去 13 天内的有效夜晚。</p>
                  <p>连续性：20 × 睡眠分钟 ÷ (睡眠分钟 + 清醒分钟)，未纳入醒来次数。</p>
                  <p>总分为三项之和取整；本项目计算，尚未接入 Apple 原生评分。</p>
                </details>
              </>
            ) : <p className="empty-note">{night.reason ? pressureReason(night.reason) : "评分拆解等待同步"}</p>}
          </section>
          {night.conflict && (
            <p className="notice">
              来源冲突 · 本晚存在 {night.sources} 个来源，仅作记录展示。
            </p>
          )}
        </>
      ) : (
        <div className="empty-note">{emptyText ?? "近 7 天暂无睡眠记录"}</div>
      )}
    </Panel>
  );
}
function Activity({ dto, now }) {
  const [key, setKey] = useState("step_count"),
    [selectedDate, setSelectedDate] = useState(null),
    metric = metrics.find((m) => m.key === key),
    data = dailyMetricRows(dto, key, now),
    summary = activitySummary(dto, selectedDate, now);
  return (
    <Panel
      index="04 / ACTIVITY"
      title="日常活动"
      className="activity-panel"
      subtitle="完整历史日与当天进度"
      controls={
        <label className="select-label">
          指标
          <select
            aria-label="活动指标"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          >
            {metrics.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      }
    >
      <ActivityChart dto={dto} metric={metric} now={now} />
      <div className="telemetry">
        <span>
          完整历史日中位{" "}
          <b>
            {number(data.median, key === "walk_run_distance" ? 1 : 0)} {metric.unit}
          </b>
        </span>
        <span>
          深色柱 <b>当天未完</b>
        </span>
      </div>
      <div className="day-notes">
        {data.rows
          .filter((r) => r.reason)
          .map((r) => (
            <span key={r.date}>
              {r.date.slice(5).replace("-", "/")} ·{" "}
              {r.partial && r.reason === "missing"
                ? "待同步"
                : pressureReason(r.reason)}
            </span>
          ))}
      </div>
      <div className="activity-summary">
        <label className="select-label">
          查看日期
          <select
            aria-label="活动摘要日期"
            value={summary.date}
            onChange={(event) => setSelectedDate(event.target.value)}
          >
            {summary.dates.map((date) => (
              <option key={date} value={date}>
                {date.slice(5).replace("-", "/")}
                {date === beijingDate(now) ? " · 今日" : ""}
              </option>
            ))}
          </select>
        </label>
        {!summary.hasRecords && (
          <p>{summary.partial ? "今日活动尚未同步" : "该日暂无活动记录"}</p>
        )}
      </div>
      <div className="metric-grid">
        {summary.rows.map((row) => (
          <div key={row.key}>
            <span>{row.label}</span>
            <b>
              {number(row.value, row.key === "walk_run_distance" ? 1 : 0)} <small>{row.unit}</small>
            </b>
            {row.reason && (
              <em>
                {summary.partial && row.reason === "missing"
                  ? "待同步"
                  : pressureReason(row.reason)}
              </em>
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}
export function DashboardView({
  snapshot,
  onRange,
  onRefresh,
  now = Date.now(),
  demo = false,
  reopenUrl,
}) {
  const reopenHref = safeReopenUrl(reopenUrl);
  const { data: dto, weeklyData, weeklyError, range, loading, error, stale } = snapshot;
  const weekly = weeklyData ?? (range === "7d" ? dto : null);
  const weeklyEmptyText = weekly ? null
    : weeklyError && weeklyError !== "waiting_first_sync"
      ? `近 7 天${errorLabels[weeklyError] ?? "数据读取失败，请重试"}`
      : "近 7 天数据等待同步";
  const errorText =
    typeof error === "string"
      ? error
      : (errorLabels[error?.code] ?? "读取失败，请重试");
  const status = dto
    ? freshness(dto, now)
    : { kind: "warn", text: loading ? "正在读取健康数据" : "等待数据" };
  const headline = pressureHeadline(dto, now),
    s = dto?.healthIndices?.sleep ?? {},
    publication = dto?.publication;
    latest = dto?.heart?.latest;
  const hrv = [...hrvPoints(dto)].sort((a, b) => a.t - b.t).at(-1);
  const sdnn = [...hrvPoints(dto, "SDNN")].sort((a, b) => a.t - b.t).at(-1);
  return (
    <AmbientProvider
      theme={{
        lightX: -0.6,
        lightY: -1,
        keyLight: 0.95,
        fillLight: 0.8,
        lightHue: 100,
        lightSaturation: 0,
        highlightColor: "#58b9ac",
      }}
      className="health-scene"
    >
      <main>
        {demo && (
          <div className="demo-banner">
            演示数据 · 用于界面与交互验证，不是真实健康记录
          </div>
        )}
        <header>
          <div>
            <div className="eyebrow">
              <i /> PERSONAL HEALTH
            </div>
            <h1>
              我的健康看板
            </h1>
          </div>
          <div className="header-controls">
            <AmbientButton
              size="sm"
              onPress={onRefresh}
              disabled={loading}
              aria-label="刷新健康数据"
            >
              {loading ? "读取中…" : "刷新"}
            </AmbientButton>
          </div>
        </header>
        <div className="status-row" aria-live="polite">
          <span className={`status ${error || stale ? "warn" : status.kind}`}>
            <i />
            {error ? "读取异常" : status.text}
          </span>
          <span>
            最近测量 <time>{formatTime(Math.max(...[latest?.e, hrv?.t, sdnn?.t].filter(finite)))}</time>
          </span>
          <span>
            看板更新 <time>{formatTime(dto?.generatedAt)}</time> · 北京时间
          </span>
        </div>
        {error && (
          <div className="error" role="alert">
            {errorText}
            {stale && dto ? " · 保留上次成功读取的数据" : ""}
          </div>
        )}
        {dto ? (
          <>
            {publication && (
              <p className="signature-line" aria-label="当前签名">
                <span>当前签名</span>
                <b>{signatureText(publication.sentTitle) ?? "尚未发布"}</b>
                {publication.sentTitle && <small>
                  发布于 <time>{formatTime(publication.lastSentAt)}</time>
                  {publication.pending ? " · 新签名等待发布" : ""}
                </small>}
              </p>
            )}
            <div className="stats">
              <Stat
                label={headline.title}
                value={headline.score}
                unit="/100"
                tone={`teal${headline.historical ? " historical" : ""}`}
                progress={headline.score}
                caption={headline.caption}
                detail={headline.time ? <>
                  <time>{headline.time}</time>
                  {headline.shortBaseline ? " · 短期基线" : null}
                </> : null}
              />
              <Stat
                label="睡眠评分"
                value={s.score}
                unit="/100"
                tone="blue"
                progress={s.score}
                caption={
                  s.score == null
                    ? pressureReason(s.reason)
                    : `项目评分 · ${stateLabels[s.state] ?? "已评分"}`
                }
                detail={s.date ? <time>{s.date}</time> : null}
              />
              <Stat
                label="最新心率"
                value={latest?.v}
                unit="bpm"
                tone="coral"
                compact
                caption="最近一分钟"
                detail={<time>{formatTime(latest?.e)}</time>}
              />
              <Stat
                label="最新恢复 HRV（RMSSD）"
                value={hrv?.v}
                unit="ms"
                tone="violet"
                compact
                caption="独立测量 · 压力计算输入"
                detail={<time>{formatTime(hrv?.t)}</time>}
              />
            </div>
            <Workouts dto={weekly} now={now} emptyText={weeklyEmptyText} />
            <section className="trend-controls" aria-label="健康趋势时间范围">
              <div>
                <h2>健康趋势</h2>
                <p>时间范围仅影响压力、心率与日常活动</p>
              </div>
              <Selector
                label="压力、心率与活动时间范围"
                value={range}
                onChange={onRange}
                options={[["24h", "近 24 小时"], ["7d", "近 7 天"]]}
              />
            </section>
            <div className="main-grid">
              <Pressure dto={dto} range={range} now={now} />
              <Physiology dto={dto} range={range} />
              <Activity dto={dto} now={now} />
            </div>
            <Sleep dto={weekly} emptyText={weeklyEmptyText} />
            <DataNotes dto={dto} now={now} />
            <footer>
              <p>Apple Health → 私有数据源</p>
              <p>每 2 分钟检查更新 · 所有日期使用北京时间</p>
            </footer>
          </>
        ) : (
          <AmbientPanel material="matte" className="panel empty-state">
            <h2>{loading ? "正在连接数据源" : "暂时无法显示看板"}</h2>
            <p>
              {loading ? "等待初始化与数据读取…" : (errorLabels[error?.code] ?? "请检查访问权限或稍后重试。")}
            </p>
            {error?.code === "session_expired" && reopenHref ? (
              <a className="reopen-link" href={reopenHref}
                target="_blank" rel="noopener noreferrer">重新打开文档</a>
            ) : (
              <AmbientButton size="sm" onPress={onRefresh} disabled={loading}>重试</AmbientButton>
            )}
          </AmbientPanel>
        )}
      </main>
    </AmbientProvider>
  );
}
export default function App({ client, demo = false, reopenUrl }) {
  const snapshot = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getSnapshot,
  );
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    client.start();
    const refresh = () => {
      if (!document.hidden) {
        setNow(Date.now());
        client.load(false);
      }
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      client.stop();
    };
  }, [client]);
  useEffect(() => {
    let last = 0;
    const observer = new ResizeObserver(() => {
      const height = document.documentElement.scrollHeight;
      if (height !== last) {
        last = height;
        Promise.resolve(window.magic?.updateHeight?.()).catch(() => {});
      }
    });
    observer.observe(document.querySelector("main"));
    return () => observer.disconnect();
  }, []);
  return (
    <DashboardView
      snapshot={snapshot}
      onRange={client.setRange}
      onRefresh={() => client.load()}
      now={now}
      demo={demo}
      reopenUrl={reopenUrl}
    />
  );
}
