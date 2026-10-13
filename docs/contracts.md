# 配置与上传契约 v1

2026-10-13。本文区分当前实现与后续协议。HealthRelay 配置文件不是 HEA 配置文件；示例均为合成数据。

## AutomationConfig

完整例子见 [多指标明细](../examples/task.raw.json)、[汇总配置](../examples/task.daily.json)。数量和睡眠汇总已可执行，见[混合汇总示例](../examples/task.mixed-aggregate.json)。

| 字段 | 当前语义 |
| --- | --- |
| schemaVersion | 配置版本，当前 1 |
| device | iPhone / watch；省略时默认 iPhone，兼容旧配置 |
| id / revision | 任务 UUID / 保存时递增的版本 |
| name / enabled | 名称 / 自动执行开关；导入和复制默认禁用；iOS 可手动运行未启用任务，Watch 需本机授权并启用 |
| data.family | healthMetrics（数量/分类/关联混选）、quantity、category、correlation、workout |
| data.selections | HealthKit 标识符、数量输出单位、每项来源包含集合，可选 statistics 覆盖 |
| data.excludedSources | 任务来源排除集合，排除优先 |
| range | 增量或日历范围 |
| export | 格式、明细/汇总、分组、统计、IANA 时区 |
| destination | HTTPS URL、POST、Header、Keychain 引用、超时、确认模式 |
| execution | 数据变化、前台补跑、可选 periodicPolling、最小间隔、批次上限、通知偏好 |

来源筛选使用 `HKSource.bundleIdentifier`，不是可修改的显示名称。关联记录按父对象来源筛选，子样本在原生载荷中保留各自来源。删除通知仅包含 UUID；接收端应忽略未导入过的 UUID。

日期策略：

- `incremental`：首次以所选时区当天起点向前 `bootstrapDays` 天确定下界；以后冻结这个下界，以 anchor 读取新增/删除。
- `today` / `yesterday`：所选时区的日历日。
- `pastDays`：从当天起点向前 `days` 天到次日零点，包含今天。
- `previousDays`：完整前 N 天，不含今天；`defaultRange`：昨天零点至次日零点，包含今天。
- `custom`：带时区的 ISO 8601 起止；明细按样本开始时间落入 `[start,end)` 筛选，汇总扩展到相交的完整窗口。

日历范围改变会产生新的检查点键，可能再次上传重叠历史，接收端仍需去重。只改名称、启停或执行偏好不会改变查询键；改变数据选择、来源、范围、单位或格式会改变查询键。只改接口不会自动向新接收端回填已确认历史。

`raw` 必须 `grouping=none`、`statistics=[]`。`aggregate` 支持数量/睡眠；每指标优先用 `selection.statistics`，其次旧任务级非空 `export.statistics`，最后目录默认值。显式空覆盖数组会被拒绝，睡眠使用专用时段算法。锻炼路线/时序选项当前仍拒绝执行。格式执行范围见下表。

| 格式 | 当前执行范围 |
| --- | --- |
| healthrelay.v1 | 数量/分类/关联明细、锻炼摘要、数量/睡眠汇总，包含 upsert/delete |
| csv / markdown | 同一标准记录，复杂 payload 放在 JSON 单元格中 |
| hea.v2 | 20 项显式映射的数量明细/汇总、睡眠分段/日汇总；删除策略见下文 |
| hea.csv | 以同一 HEA 数据形状生成每指标一个文件的 multipart profile；真实 HEA 文件布局待核对 |
| hea.v1 | 仅配置，不能执行 |

`credentialRef`、`secretHeaders` 指向本机 Keychain；`credentialHeader` / `credentialPrefix` 定义认证 Header。导入/导出剥离认证值和设备引用，只保留 `requiredSecretHeaders`，必须重新绑定才能执行。配置校验拒绝重复 Header、CR/LF、保留 Header 冲突和 URL 内嵌用户名/密码。

Watch 配置以完整快照同步，最大 60 KiB，携带单调递增 generation 和独立快照 ID；接收端整体校验可执行能力后原子保存任务与确认。配置不携带 iPhone 的 Keychain 值或引用，Watch 本机绑定认证后启用。切回 iPhone 要等待 Watch 移除确认；设备之间不复制 anchor。迁移前的 iPhone 请求指纹保持兼容，Watch 使用自己的指纹与持久状态，上传正文仍遵守下述协议。

## Native batch

见 [上传批次](../examples/batch.json)。HTTP POST，`Content-Type: application/json`，`Idempotency-Key` 为 `batchId`。CSV、Markdown、HEA v2 同样发送这个 Header，批次 ID 不一定包含在格式正文中。

原生顶层字段为 `schemaVersion=1`、`batchId`、`taskId`、`configRevision`、`createdAt`、`records`。数量案例：

```json
{
  "op": "upsert",
  "typeIdentifier": "HKQuantityTypeIdentifierBodyMass",
  "recordId": "c2602dc6-58ce-4e76-bc1d-e265a43299a0",
  "start": "2026-01-01T10:15:12.000Z",
  "end": "2026-01-01T10:15:12.000Z",
  "source": {"id": "test.synthetic", "name": "Synthetic data"},
  "payload": {"value": 70, "unit": "kg"}
}
```

| 记录 | payload / 接收语义 |
| --- | --- |
| quantity upsert | value、unit；按认证用户、typeIdentifier、recordId 去重 |
| category upsert | 原始枚举 value、起止时间；不伪造数字平均 |
| correlation upsert | objects 为完整子记录数组，子单位采用目录默认值 |
| workout upsert | activityType、durationSeconds、events、已有统计摘要；不含路线和关联时序 |
| delete | typeIdentifier、recordId，无样本载荷；删除或软删除，可重复执行 |

来源另可含版本与设备型号。metadata 保留字符串、日期、数值和布尔；不支持的值以 `unsupportedMetadataKeys` 标明，不宣称任意 HealthKit 对象无损序列化。原生样本时间使用带毫秒和明确 `Z` 的 UTC ISO 8601。

不能只用日期与指标名覆盖多来源样本。接收端认证决定用户归属，不信任客户端声明的用户 ID。

HEA v2 正文为 `data.metrics[]`，一般数量点为 `date/qty/source`，心率为 `date/Min/Avg/Max/source`；原始心率的三个值相同，汇总只发送实际取得的统计。时间按配置时区输出到秒，心率单位可输出 bpm。睡眠分段为 `startDate/endDate/value/qty`；睡眠日汇总包含 `date=yyyy-MM-dd`、总时长和阶段时长（小时）。这个兼容载荷不保留原生 UUID、全部 metadata 或删除语义，服务端必须采用自己已验证的去重规则。

原生汇总仍是 `upsert/delete`，不新增 `snapshot` 操作。`recordId=window:<UTC start>:<UTC end>`，source 为 `org.healthrelay.aggregate`；数量 payload 包含 aggregation=true、unit、选择的 sum/average/minimum/maximum 和首选 value。接收端按 task/type/window 覆盖，不能将修正值再次累加。

`export.deletionPolicy` 仅影响 HEA：省略或 `reject` 停止，`omit` 跳过并记录删除数。原生始终传播删除。HEA 的整个窗口清空无法表达；选择 omit 后旧窗口可能留在远端。

HEA 自动 Header 为 automation-name/id/aggregation/period、session-id，重试时冻结。具体 profile、日期映射和 CSV 捕获边界见[核心实现](implementation-automation-core.md#hea-兼容边界)。

## Confirmation 与重试

`receipt` 模式要求 HTTP 200/201、正确 `batchId`、`committed=true`，且非负 `accepted+duplicates` 等于整批记录数，见 [服务端确认](../examples/receipt.json)。不接受部分成功、错误批次或计数。

`http2xx` 接受 2xx 成功状态与空正文，包括 204，但排除 202。它只证明接口接受，不能证明数据库提交。

| 结果 | 当前处理 |
| --- | --- |
| 断网、超时、408、429、5xx | 保留原批次；指数退避，初始 30 秒，常规退避最多 1 小时；支持 Retry-After 秒值与 HTTP-date |
| 401/403、409、413、422、重定向 | 保留原批次，停止自动重试，等待人工检查 |
| 无效 receipt | 保留批次，不推进 anchor，停止自动重试 |
| 取消或系统中断 | 未确认批次保留，下一次继续 |

本地编码超出字节上限时减小读取页重试；**服务端返回 413 尚不自动拆批**。单条记录超限会报错，不截断。需要调整配置时，可明确取消待上传批次；取消不推进已提交 anchor，后续从原位置重新读取。服务端可能已经收到了之前的请求，因此仍必须去重。

服务端推荐：同事务写批次去重、样本与确认；相同 ID/相同正文返回原回执，不同正文返回 409。网络响应丢失、手动回填、重装或变更范围都可能重发，客户端无法独自实现恰好一次入库。

## 本地状态与日志

当前运行状态为 `running / succeeded / noData / queued / failed`。每任务 JSON 文件包含查询检查点、一个待上传批次、下次重试时间、独立 lastConfirmedAt、整轮 cycleStartedAt/cycleFingerprint、nextSelectionID 及最近 30 条运行日志；iOS / Watch 原子写入并使用完整文件保护。

先保存固定正文、batch ID 与建议新 anchor，再发 HTTP；有效确认后，同次原子写入提交 anchor 并清除批次。网络失败不会先推进进度，也不重新扫这一页历史。没有新事件只保存读取检查点，不发送空批次。

默认日志展示结果、条数、批次数、HTTP 状态和时间，不打印认证值或完整健康请求体。空结果不能判断为“用户拒绝了健康读取权限”；已有过确认的任务显示正常无新记录状态，不提示重新检查权限。

## 历史补传与汇总状态

补传 job 保存独立 UUID、原任务配置快照、固定 custom 范围和完成时间。磁盘同步文件使用 job.id，外发 taskId 仍为原任务 ID；所以补传可幂等覆盖原数据，但不会修改日常检查点。未完成期间禁止原任务编辑/删除，取消补传仅移除本地补传状态。

聚合 checkpoint 保存变更 anchor、受影响窗口队列、有限 UUID→窗口索引和结果哈希；拟提交状态随 pending 同步持久化。跨午夜续跑保持 cycleStartedAt 对应范围，完成整轮后清除，下一轮使用新日期。

诊断导出包含 RunLog 的 trigger、durationSeconds、metricCounts、omittedDeletions，不包含请求正文、认证或完整健康历史。Keychain 与完整文件保护仍要求可读设备状态。iOS 使用普通 URLSession；Watch 使用系统后台文件上传，另存精确批次身份及待应用回执。Apple 后台 URLSession 会跟随重定向，因此 Watch 必须配置最终 HTTPS 接收地址；最终 URL 校验只拒绝异常确认，不能承诺阻止重定向的数据传输。详见 [Watch 实现说明](implementation-watch.md)。
