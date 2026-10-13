# 从 watch_monitor 迁移自动化配置

迁移保留了五条自动化的数据选择、分组、间隔和接收路径。公开版本删去端点、密钥、设备身份及飞书资源绑定；[profile.json](../examples/watch-monitor/profile.json) 是迁移清单，**不能作为一个 App 任务导入**。五个单独的 JSON 文件可在 HealthRelay 中导入。

本配置来自已提交的 `watch_monitor` 服务契约，不表示本轮重新检查或修改了手机上的 HAE 设置。先在 iPhone 跑通，再逐项对照 HAE；Watch 作为后续执行端单独验收。

## 五条数据流

共用 POST、HAE JSON v2、北京时间、`X-API-Key`。间隔表示上传尝试下限，分钟/天表示数据汇总粒度。

| 任务 | 路径 | 数据 / 粒度 | 最小间隔 | HealthRelay 配置 |
| --- | --- | --- | --- | --- |
| HRV | `/ingest/hrv` | SDNN + RMSSD，分钟平均 | 30 分钟 | [hrv.json](../examples/watch-monitor/hrv.json) |
| 心率 | `/ingest/heart` | 心率，分钟 Min / Avg / Max | 30 分钟 | [heart.json](../examples/watch-monitor/heart.json) |
| 每日概览 | `/ingest/health` | 静息心率平均；步数、活动能量、锻炼时间、步行跑步距离总和；按天 | 60 分钟 | [activity.json](../examples/watch-monitor/activity.json) |
| 睡眠明细 | `/ingest/sleep-segments` | 睡眠阶段原始区间，无汇总 | 6 小时 | [sleep.json](../examples/watch-monitor/sleep.json) |
| 锻炼 | `/ingest/workouts` | HAE v2 workouts 摘要 | 30 分钟 | [workouts.json](../examples/watch-monitor/workouts.json) |

RMSSD 需要对应系统、设备及真实可用样本；目录中存在不代表一定有数据。缺失时不把 SDNN 改名为 RMSSD。

## 在 iPhone 中配置

1. 导入单个 JSON。任务默认关闭，示例 ID 只是固定合成身份；多个副本请通过 App 的复制任务功能生成新 ID。
2. 将 `https://health.example.com` 换成自己部署的最终 HTTPS 地址。不要使用重定向或把飞书 webhook 直接作为此任务端点。
3. 在认证项中填写 `X-API-Key`。它是 Worker 上传密钥，和机器人签名 secret、飞书应用 secret 完全不同。公开文件只有 `requiredSecretHeaders`，导入后必须重新绑定。
4. 为指标选择期望的数据来源并授予权限。多设备累加型数据需要先确认 HealthKit 汇总口径，不要直接合并多个导出器。
5. 手动运行一次，从 `/status` 检查 `stream`、`aggregation`、`dataRange`、`stats`，与 App 的运行记录对照。重复运行不应增加已存在的事实。
6. 再启用数据变化、前台补跑和周期检查。样例无需通知权限；提醒和 Shortcuts 时间触发是独立选项。

每日概览读取“昨天至今”，以完整自然日重新计算；不要改为部分日增量汇总。睡眠读取昨天至今覆盖常见跨午夜区间；长历史使用独立补传。HRV 和心率可以增量读取，汇总后的时间锚点仍须按分钟对齐。

配置使用 `acknowledgement: http2xx`：迁入 Worker 在事务提交后返回 `stored:true`，但不返回原生 `batchId/committed` receipt。HTTP 上传成功只表示入库，群卡、签名和看板需分别看发布状态。

## 与 HAE 对照及切换

至少对照同一时间范围、来源和单位的心率 Min/Avg/Max、两种 HRV、累计活动以及睡眠区间。当前合成测试证明编码契约兼容，不能代替健康设备数值一致性验收。

- HAE 和 HealthRelay 可能报告不同 source，时间桶和记录身份也可能不同。不要同时写入同一个生产对象后直接相加；用独立 Worker 先对照。
- HealthRelay 心率汇总不带 source，HRV 汇总报告 `source=HealthRelay`，睡眠明细保留来源名。默认可入库，但来源不能配对时不输出压力分。若已在 App 严格选择同一设备来源，可用独立部署的单来源评分绑定：`HEALTH_REPORTED_SOURCE=HealthRelay`，并设定自己的设备 profile 和新基线起点；它会在评分副本中将缺失来源的心率与 HealthRelay HRV 归入同一个显式导出范围。夜间压力回退还要求睡眠来源匹配，当前不能自动桥接另一来源名。不得用这个绑定掩盖多设备数据混合。
- `HEALTH_DEVICE_PROFILE`、`HEALTH_DEVICE_EPOCH_START`、`HEALTH_REPORTED_SOURCE` 是原服务的可选单来源评分绑定，必须三项一起填写；它只修改评分副本，不改原始记录。当前单字符串绑定不能证明多个不同导出来源等价。
- HAE 格式不携带此服务可执行的删除协议。样例使用 `deletionPolicy=reject`；出现删除需处理后端旧事实并复核，不能跳过后声称已同步删除。
- 锻炼样例关闭路线与关联曲线，仅上传摘要；运动详情已实现，但逐字段真实 HAE 对照与迟到详情补齐仍需独立验收。

## 切换到 Watch

在 iPhone 上选择 Watch 为任务执行设备并同步配置；等待 Watch 确认接收，再在 Watch 本机授权、绑定密钥和启用。使用最终 HTTPS 端点，验证独立上传、断网重试、重复抑制和设备切换。手表没有 iPhone 的完整历史数据库，不能把 iPhone 的游标搬过去。

本次没有切换原有手机任务、Cloudflare namespace、群绑定或线上数据。配置迁移与生产切换分开验收。
