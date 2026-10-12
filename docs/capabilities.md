# 能力覆盖与验收

2026-10-12。配置目录、执行实现与真机验收分别记录。SDK 标识符盘点不是完整 HealthKit 能力证明；一个家族的通用读取器也不代表其中每个类型都有真机样本。

| 能力 | 当前实现 | 验收边界 |
| --- | --- | --- |
| 通用任务配置 | 数量/分类/关联混选；锻炼单独家族，来源/单位/范围/目的地可配置 | 配置 Core 测试、模拟器创建/保存/重启通过 |
| Quantity 明细 | 通用 anchored 分页、单位映射、新增/删除 | SDNN、RMSSD、步数原生上传真机验收；不代表全部数量类型 |
| Category 明细 | 原始枚举、起止时间、新增/删除 | 睡眠原生上传真机验收；不代表全部分类类型 |
| Correlation 明细 | 父子记录、子单位、来源、metadata | 已实现；复杂关联实际样本待逐项验收 |
| Workout 摘要 | 活动类型、时长、事件、已有统计 | 已实现；路线/关联时序未开放 |
| healthrelay.v1 / CSV / Markdown | 标准记录编码，原生 JSON 支持 upsert/delete | 原生 JSON 真机 Cloudflare receipt 通过；CSV/Markdown 为合成编码验收 |
| HEA v2 明细 | 16 个显式映射，包括 HRV、RMSSD、常用数量和睡眠分段 | 合成形状/时区/删除拒绝测试；不代表 HEA 全协议对等 |
| HEA v1 | 配置可保存 | 未开放执行 |
| 汇总与分组 | 配置与合法统计校验 | 未开放执行；统计、时区窗口、迟到/删除重算待实现 |
| 增量与持久化 | 固定首次下界；每任务一个待上传批次，确认后提交 anchor | 失败重启、同 ID/正文重试、不重复发送已验收 |
| 手动、前台、Observer、BGTask | 接入共同引擎；最小间隔、数据变化与待上传重试 | 真机手动链路通过；后台延迟/锁屏/低电量待验收 |
| AppIntent | 选择已有任务，打开 App 并运行同一引擎 | 已构建；快捷指令 App 实际调用待验收 |
| Activity Summary / Characteristics | 快照设计 | 未接入 |
| ECG / Audiogram / Series | 专用查询设计 | 未接入 |
| State of Mind / Medication | 结构化读取设计 | 未接入 |
| Clinical / restricted | 需独立权限与接入条件 | 未接入，不保证普通签名即可读取 |

当前仅以下四个类型标记 `deviceVerified`（原生明细读取→隔离测试接口提交回执，不包含汇总）：

- HKQuantityTypeIdentifierHeartRateVariabilitySDNN
- HKQuantityTypeIdentifierHeartRateVariabilityRMSSD
- HKQuantityTypeIdentifierStepCount
- HKCategoryTypeIdentifierSleepAnalysis

HEA v2 映射以 [HEAEncoder.swift](../packages/HealthRelayCore/Sources/HealthRelayCore/HEAEncoder.swift) 为准。新类型可能有额外授权或专用 API，运行时不支持会明确报错，不用空结果冒充成功。

## 已验收的引擎边界

本阶段 34 项 Core 测试通过，iOS 27 模拟器构建通过，2 项原生 UI 测试通过；Cloudflare 接收器有 2 项 Node 边界测试。

| 场景 | 结果 |
| --- | --- |
| 通用指标选择、保存与重启恢复 | 通过；体重仅为合成验收案例 |
| HTTPS 首次返回 503，App 退出后重试 | 通过；同 batch ID 和相同正文 SHA-256 |
| 正确整批 receipt | 通过；确认后提交 anchor 并清除 pending |
| 错误 ID、错误计数、202 | 拒绝确认，测试通过 |
| 无新记录 | 不发送 HTTP，固定增量下界测试通过 |
| 未确认时修改接口 | 阻止发送到新目标，测试通过 |
| 损坏同步状态 | 停止并保护原文件，测试通过 |
| 原生删除与 HEA 删除 | 原生编码保留身份；HEA 明确拒绝，测试通过 |
| 时间编码 | 原生 UTC Z、HEA 时区转换回归通过 |

本地 HTTP 接收器、模拟器任务和数据均为合成验收内容。隔离 Cloudflare 接收器的合成幂等测试通过。10 月 12 日真机混合任务确认 691 条/16 批，随后无新数据运行未增加服务端计数。锁屏补传、Observer 唤醒、系统取消和首次大历史仍需独立证据，不从模拟器结果推定。

## 后续完成条件

1. 每类型单位、枚举、availability、metadata 语义核对。
2. 特殊家族专用查询、完整子数据与删除机制验收。
3. 汇总遵循 HealthKit aggregationStyle，不把时间取整当作平均。
4. 真机记录与接收端结果核对；无实际样本只标 implemented。
5. 后台与快捷指令记录真实触发、延迟和失败恢复。
6. 服务端幂等与回执持久化验收；HTTP 200 本身不等于去重或数据库提交。
