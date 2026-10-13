export function DataFlow({ showTitle = true }) {
  return (
    <figure className="data-flow" aria-label="数据如何变成看板与签名">
      {showTitle && <h3>数据如何变成看板与签名</h3>}
      <ol className="data-flow-stages">
        <li>
          <h4>01 · 采集与上传</h4>
          <div className="data-flow-path">
            <p><strong>Apple Watch</strong><span>HR / HRV · 睡眠 · 活动</span></p>
            <p><strong>Apple 健康</strong><span>HealthKit 保存与授权读取</span></p>
            <p><strong>HealthRelay / HAE</strong><span>JSON v2 · REST 上传</span></p>
          </div>
          <dl className="data-flow-tasks">
            <div><dt>HRV</dt><dd>/ingest/hrv · SDNN + RMSSD · 分钟汇总 · 30 min</dd></div>
            <div><dt>心率</dt><dd>/ingest/heart · Min / Avg / Max · 分钟窗口 · 30 min</dd></div>
            <div><dt>活动</dt><dd>/ingest/health · 静息心率、步数、能量 · 日汇总 · 60 min</dd></div>
            <div><dt>睡眠</dt><dd>/ingest/sleep-segments · 原始分期 · 6 h</dd></div>
            <div><dt>锻炼</dt><dd>/ingest/workouts · 活动摘要 · 30 min</dd></div>
          </dl>
          <p>五条独立任务；配置周期 ≠ 准点执行，测量时间 ≠ 上传时间。</p>
        </li>
        <li>
          <h4>02 · 接入、存储与调度</h4>
          <div className="data-flow-path">
            <p><strong>Cloudflare Gateway</strong><span>转发上传与读取请求</span></p>
            <p><strong>Worker</strong><span>鉴权 · 大小与格式校验 · 五流解析</span></p>
            <p><strong>Durable Object · SQLite</strong><span>幂等去重 · 样本、压力观测与发布状态</span></p>
          </div>
          <p><strong>Alarm</strong> 入库重算、有效期复查与失败退避；签名合并 30 s、最短间隔 2 min；看板按数据变化和时间边界更新。</p>
          <p><strong>鉴权接口</strong> GET /dashboard?range=24h|7d、/status、/snapshot、/analysis；POST /signature/refresh、/dashboard-cache/refresh。读取或重算不生成新测量。</p>
        </li>
        <li>
          <h4>03 · 评分与展示</h4>
          <div className="data-flow-branches">
            <div>
              <strong>动态签名</strong>
              <p>20 min 配对 RMSSD / HR 与个人基线 → 压力评分；剔除睡眠、运动及其后 1 h。</p>
              <p>睡眠评分 = 时长 50 + 规律 30 + 连续性 20。</p>
              <p>算法拼接状态、数值与测量时间 → Base title → 妙笔个性签名 → 点击进入本文档。</p>
            </div>
            <div>
              <strong>健康看板</strong>
              <p>同一份评分与测量 → 展示 DTO → Base 展示副本 → 妙笔 HTMLBox。</p>
              <p>页面约每 2 min 检查更新；睡眠近 7 天，锻炼可选 7 / 30 天且至少 20 min。</p>
              <p>采集密钥和签名写入由服务端持有。</p>
            </div>
          </div>
        </li>
      </ol>
      <figcaption>
        签名状态：当天合格汇总 → 当前有效评分 → 同规则、同设备近 7 天有效观测。
        数值可保留最近记录；末尾为测量时间，上传与发布不改变它。
      </figcaption>
    </figure>
  );
}
