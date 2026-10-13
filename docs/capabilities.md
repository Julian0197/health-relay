# 能力覆盖与验收

2026-10-13。配置目录、执行实现与真机验收分别记录。SDK 标识符盘点不是完整 HealthKit 能力证明；一个家族的通用读取器也不代表其中每个类型都有真机样本。

完整的配置与执行差距、协议差异和实施顺序见 [HEA 自动化对照盘点](hea-automation-gap-audit-2026-10-12.md)。盘点保留实现前基线，最新补齐说明见[核心实现](implementation-automation-core.md)和[定时与提醒验收](implementation-scheduling.md)。

| 能力 | 当前实现 | 验收边界 |
| --- | --- | --- |
| 通用任务配置 | 数量/分类/关联混选；锻炼单独家族，来源/单位/范围/目的地可配置 | 配置 Core 测试、模拟器创建/保存/重启通过 |
| Quantity 明细 | 通用 anchored 分页、单位映射、新增/删除 | SDNN、RMSSD、步数原生上传真机验收；不代表全部数量类型 |
| Category 明细 | 原始枚举、起止时间、新增/删除 | 睡眠原生上传真机验收；不代表全部分类类型 |
| Correlation 明细 | 父子记录、子单位、来源、metadata | 已实现；复杂关联实际样本待逐项验收 |
| Workout 完整读取 | 活动、暂停后的时长、事件/统计/metadata、全部路线分段、关联数量与内部 series、按来源分组 | 15 项 iPhone 与 Watch 合成读取测试通过；真实运动/路线样本待验收 |
| healthrelay.v1 / CSV / Markdown | 标准记录编码，原生 JSON 支持 upsert/delete | 原生 JSON 真机 Cloudflare receipt 通过；CSV/Markdown 为合成编码验收 |
| HEA v1 / v2 JSON | 106 项数量清单及 RMSSD 扩展；血压/睡眠/正念/性行为、运动、症状/周期、ECG/通知/情绪；运动按版本编码 | 合成契约与 SDK 桥接测试通过，已取得真实心率汇总文件；其余实际文件及数值待对照 |
| HEA CSV | 按 HEA 10.0.4 中文样本输出数量/睡眠宽表；其他家族和不兼容统计明确拒绝 | 已有实际手动 CSV 表头/结构证据和合成回归；仍按指标分页，REST multipart 参数与其他语言/单位偏好未验证 |
| 汇总与分组 | 每指标统计、完整窗口查询、迟到/删除修正、睡眠跨午夜合并 | Core 窗口/DST/缓存回归及模拟器流程通过；真实健康汇总值待核对 |
| 历史补传 | 独立固定范围 job、持久进度、继续/取消；不重置父任务 | Core 隔离、模拟器流程与真机补传回执通过 |
| 增量与持久化 | 固定首次下界；每任务一个待上传批次，确认后提交 anchor | 失败重启、同 ID/正文重试、不重复发送已验收 |
| 手动、前台、Observer、BGTask | 全局串行与公平队列，共享预算、跨午夜续跑；前台定时与后台期望调度 | 真机持续前台定时与 healthChange 自动上传记录通过；自然后台延迟/锁屏/低电量待验收 |
| AppIntent | 不打开 App，启用检查、自动重试语义，返回文本 | 最终包已安装；真机 Shortcuts 系统时间触发上传通过；退避/关闭拒绝由 Core 测试覆盖 |
| 独立提醒 | 每小时/每天/指定星期，本地通知与打开并同步 | Core 日期/DST、模拟器保存恢复及真机自然送达通过；通知动作与清理待完整真机验收 |
| Watch companion | 配置同步、设备归属、本机认证/授权、后台文件上传、回执与持久游标 | Core 和模拟器系统传输已验收；真实 Watch 双端链路、自然唤醒与耗电待验收，见 [Watch 记录](implementation-watch.md) |
| Activity Summary / Characteristics | 快照设计 | 未接入 |
| ECG / 数量内部 series | 全部电压点、毫秒时间偏移；运动/通知关联数量的内部 series | 专用读取合成测试及两端编译通过；真实 ECG 待验收，Audiogram/独立 heartbeat series 未接入 |
| State of Mind / Medication | 情绪原始枚举；iOS/watchOS 26+ 剂量事件与可用药物注释，按对象授权 | 16 项专用读取合成测试在两端通过；真实记录与 HEA 用药语义待验收 |
| Clinical / restricted | 需独立权限与接入条件 | 未接入，不保证普通签名即可读取 |

当前仅以下四个类型标记 `deviceVerified`（原生明细读取→隔离测试接口提交回执，不包含汇总）：

- HKQuantityTypeIdentifierHeartRateVariabilitySDNN
- HKQuantityTypeIdentifierHeartRateVariabilityRMSSD
- HKQuantityTypeIdentifierStepCount
- HKCategoryTypeIdentifierSleepAnalysis

HEA 映射以 [HEAMetricCatalog.swift](../packages/HealthRelayCore/Sources/HealthRelayCore/HEAMetricCatalog.swift) 和各数据族编码器为准；用药、站立小时、洗手/刷牙的 HEA 语义未确认，执行时提示使用原生 JSON。详见[完整运动与 HEA 对照](implementation-hea.md)。新类型可能有额外授权或专用 API，运行时不支持会明确报错，不用空结果冒充成功。

## 已验收的引擎边界

合并后的最新回归结果以 [README](../README.md) 为准。以下保留各阶段验收背景。

此前 74 项 Core 测试通过（55 XCTest 含 Cloudflare 集成 + 19 Swift Testing）；本轮本地复核 73 项通过、1 项可选外网用例跳过。5 项原生 UI 用例已有通过记录，本轮复核配置保存/重启与前台间隔，最终 iPhone 签名构建通过。本轮新增 8 项原生生命周期测试及 8 项 Node 测试通过；[后台恢复记录](implementation-background.md)区分受控回归与自然真机结果。未配置私有 Cloudflare 验收文件时，外网测试跳过。

| 场景 | 结果 |
| --- | --- |
| 通用指标选择、保存与重启恢复 | 通过；体重仅为合成验收案例 |
| HTTPS 首次返回 503，App 退出后重试 | 通过；同 batch ID 和相同正文 SHA-256 |
| 正确整批 receipt | 通过；确认后提交 anchor 并清除 pending |
| 错误 ID、错误计数、202 | 拒绝确认，测试通过 |
| 无新记录 | 不发送 HTTP，固定增量下界测试通过 |
| 未确认时修改接口 | 阻止发送到新目标，测试通过 |
| 损坏同步状态 | 停止并保护原文件，测试通过 |
| 原生删除与 HEA 删除 | 原生保留身份；HEA 显式拒绝或跳过并推进、记录计数，测试通过 |
| 时间编码 | 原生 UTC Z、HEA 时区转换回归通过 |

本地 HTTP 接收器、模拟器任务和数据均为合成验收内容。隔离 Cloudflare 接收器的合成幂等测试通过。10 月 12 日真机混合任务确认 691 条/16 批，随后无新数据运行未增加服务端计数。锁屏补传、Observer 唤醒、系统取消和首次大历史仍需独立证据，不从模拟器结果推定。

## 后续完成条件

1. 每类型单位、枚举、availability、metadata 语义核对。
2. 特殊家族专用查询、完整子数据与删除机制验收。
3. 真机核对 HealthKit 统计与多来源睡眠冲突语义，不将合成窗口测试视为真实值证明。
4. 真机记录与接收端结果核对；无实际样本只标 implemented。
5. 自然后台、锁屏时间触发、通知动作/清理和失败恢复；亮屏系统时间触发已通过。
6. 服务端幂等与回执持久化验收；HTTP 200 本身不等于去重或数据库提交。
