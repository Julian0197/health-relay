# 配置与上传契约 v1

2026-10-12。本文区分当前实现与后续协议。HealthRelay 配置文件不是 HEA 配置文件；示例均为合成数据。

## AutomationConfig

完整例子见 [多指标明细](../examples/task.raw.json)、[汇总配置](../examples/task.daily.json)。汇总配置可以保存，但当前不能执行。

| 字段 | 当前语义 |
| --- | --- |
| schemaVersion | 配置版本，当前 1 |
| id / revision | 任务 UUID / 保存时递增的版本 |
| name / enabled | 名称 / 自动执行开关；导入和复制默认禁用，手动运行独立于开关 |
| data.family | healthMetrics（数量/分类/关联混选）、quantity、category、correlation、workout |
| data.selections | HealthKit 标识符、数量输出单位、每项来源包含集合 |
| data.excludedSources | 任务来源排除集合，排除优先 |
| range | 增量或日历范围 |
| export | 格式、明细/汇总、分组、统计、IANA 时区 |
| destination | HTTPS URL、POST、Header、Keychain 引用、超时、确认模式 |
| execution | 数据变化、前台补跑、最小间隔、批次上限、通知偏好 |

来源筛选使用 `HKSource.bundleIdentifier`，不是可修改的显示名称。关联记录按父对象来源筛选，子样本在原生载荷中保留各自来源。删除通知仅包含 UUID；接收端应忽略未导入过的 UUID。

日期策略：

- `incremental`：首次以所选时区当天起点向前 `bootstrapDays` 天确定下界；以后冻结这个下界，以 anchor 读取新增/删除。
- `today` / `yesterday`：所选时区的日历日。
- `pastDays`：从当天起点向前 `days` 天到次日零点，包含今天。
- `custom`：带时区的 ISO 8601 起止，按样本开始时间落入 `[start,end)` 筛选。

日历范围改变会产生新的检查点键，可能再次上传重叠历史，接收端仍需去重。只改名称、启停或执行偏好不会改变查询键；改变数据选择、来源、范围、单位或格式会改变查询键。只改接口不会自动向新接收端回填已确认历史。

`raw` 必须 `grouping=none`、`statistics=[]`。`aggregate` 和锻炼路线/时序选项可以保存，但当前执行校验拒绝。格式执行范围见下表。

| 格式 | 当前执行范围 |
| --- | --- |
| healthrelay.v1 | 数量/分类/关联明细、锻炼摘要，包含 upsert/delete |
| csv / markdown | 同一标准记录，复杂 payload 放在 JSON 单元格中 |
| hea.v2 | HEAEncoder 中显式映射的数量明细和睡眠分段；删除事件报错，不静默丢弃 |
| hea.v1 | 仅配置，不能执行 |

`credentialRef`、`secretHeaders` 指向本机 Keychain；`credentialHeader` / `credentialPrefix` 定义认证 Header。导入/导出剥离认证值和设备引用，只保留 `requiredSecretHeaders`，必须重新绑定才能执行。配置校验拒绝重复 Header、CR/LF、保留 Header 冲突和 URL 内嵌用户名/密码。

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

HEA v2 正文为 `data.metrics[]`，数量点为 `date/qty/source`，时间按配置时区输出到秒，心率单位可输出 bpm。睡眠分段为 `startDate/endDate/value/qty`。这个兼容载荷不保留原生 UUID、全部 metadata 或删除语义，服务端必须采用自己已验证的去重规则。

`snapshot`、汇总窗口版本和复杂对象子块协议属于后续设计，当前编码器不发送这些操作。

## Confirmation 与重试

`receipt` 模式要求 HTTP 200/201、正确 `batchId`、`committed=true`，且非负 `accepted+duplicates` 等于整批记录数，见 [服务端确认](../examples/receipt.json)。不接受部分成功、错误批次或计数。

`http2xx` 接受 2xx 成功状态与空正文，包括 204，但排除 202。它只证明接口接受，不能证明数据库提交。

| 结果 | 当前处理 |
| --- | --- |
| 断网、超时、408、429、5xx | 保留原批次；指数退避，初始 30 秒，常规退避最多 1 小时；支持 Retry-After 秒值 |
| 401/403、409、413、422、重定向 | 保留原批次，停止自动重试，等待人工检查 |
| 无效 receipt | 保留批次，不推进 anchor，停止自动重试 |
| 取消或系统中断 | 未确认批次保留，下一次继续 |

本地编码超出字节上限时减小读取页重试；**服务端返回 413 尚不自动拆批**。单条记录超限会报错，不截断。需要调整配置时，可明确取消待上传批次；取消不推进已提交 anchor，后续从原位置重新读取。服务端可能已经收到了之前的请求，因此仍必须去重。

服务端推荐：同事务写批次去重、样本与确认；相同 ID/相同正文返回原回执，不同正文返回 409。网络响应丢失、手动回填、重装或变更范围都可能重发，客户端无法独自实现恰好一次入库。

## 本地状态与日志

当前运行状态为 `running / succeeded / noData / queued / failed`。每任务 JSON 文件包含查询检查点、一个待上传批次、下次重试时间、独立 lastConfirmedAt 及最近 30 条运行日志；iOS 原子写入并使用完整文件保护。

先保存固定正文、batch ID 与建议新 anchor，再发 HTTP；有效确认后，同次原子写入提交 anchor 并清除批次。网络失败不会先推进进度，也不重新扫这一页历史。没有新事件只保存读取检查点，不发送空批次。

默认日志展示结果、条数、批次数、HTTP 状态和时间，不打印认证值或完整健康请求体。空结果不能判断为“用户拒绝了健康读取权限”；已有过确认的任务显示正常无新记录状态，不提示重新检查权限。
