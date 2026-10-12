# HEA 自动化能力对照与补齐顺序

核对日期：2026-10-12。代码基线：`6c925f4`。下文保留实现前盘点快照。随后已完成数量/睡眠汇总、HEA v2 与 CSV profile、历史补传和后台续跑；当前状态与测试证据见[自动化核心实现](implementation-automation-core.md)，不要将下表当作最新执行能力。

结论：HealthRelay 已跑通可配置的原生明细上传，但还不能替代 HEA 的整套自动化。主要缺口在汇总语义、协议兼容和持续执行，不是再增加几个指标名称。

## 核对方法

- 阅读当前配置模型、SwiftUI 编辑器、HealthKitReader、SyncEngine、HTTPUploader 和 HEAEncoder，区分可保存、可执行、已验收。
- 对照 10 月 11–12 日 HEA iPhone 10.0.4 的既有界面记录；本轮没有重新操作手机。界面记录仅证明当时存在这些选项，不证明内部实现。
- 重新查阅 HEA 官方自动化、REST、Deep Link、Shortcuts、数据格式及官方 MCP 仓库。
- 真机验收沿用仓库的[执行阶段记录](implementation-execution.md)，本轮未重新上传健康数据。后续验收继续使用独立 Cloudflare 测试接口。

## 已有基础

任务新建、编辑、复制、删除、本地保存、自有 JSON 导入导出；指标多选、单位、来源包含/排除；HTTPS POST、自定义 Header、Keychain 认证；原生数量/分类/关联明细和锻炼摘要；分页、持久化待上传批次、失败重试、确认后推进 anchor、无新增时不发送请求。

目录共 196 项，不等于所有 HealthKit 对象已支持。当前仅 SDNN、RMSSD、步数和睡眠完成了原生明细的真机端到端验收。症状、经期、高低心率通知等已有部分 Category 标识符及通用读取通路，不能归为完全没有；它们的语义化展示和 HEA 专用输出还没有完成。

## 对照清单

P0：先补才能作为日常自动化工具使用；P1：随后补齐常用能力；P2：扩展生态。

| 能力 | HealthRelay 当前实际状态 | 缺项与建议 | 优先级 |
| --- | --- | --- | --- |
| 单任务混合指标 | 明细支持；汇总统计取所有指标允许值的交集 | 改为每指标默认统计与可选覆盖，让累计型和测量型指标同任务输出 | P0 |
| 汇总与时间分组 | 有配置，执行器一律拒绝 aggregate | 实现数量统计、日历时区窗口、迟到记录和删除后的窗口重算 | P0 |
| 睡眠分段/汇总 | 原生分段可读，简单 HEA 分段可编码；分类没有合法数量统计选项 | 增加独立睡眠模式、跨午夜归属和阶段时长，不能对分类枚举求平均 | P0 |
| 日期范围 | 增量、今天、昨天、过去 N 天、自定义已有 | 明确“完整前 N 天”与“含今天”的区别；增加 HEA 默认范围等迁移映射 | P0 |
| 历史补传 | 改持久任务日期或复制任务可以重读 | 增加一次性指定范围补传，使用独立进度，不改变正常任务的 anchor | P0 |
| HEA JSON | v1 不可运行；v2 仅 16 项明细映射 | 按通用数量、分类、关联、睡眠、运动逐类补协议样例，先保证 v2 常用场景 | P0 |
| CSV / Markdown | 已输出自有通用记录表；payload 列为 JSON | 命名区分原生与 HEA 格式；HEA CSV 上传封装和语义化列仍缺，Markdown 也未证实兼容 | P0/P1 |
| 请求上下文 | 当前自动设置 Content-Type、Idempotency-Key | HEA 兼容模式补任务、周期、分组和请求身份 Header；不要求用户逐个手填 | P0 |
| 上传分批 | 按指标逐页上传，有记录数/字节限制 | 不等于 HEA 的整包/分批开关；需要显式传输模式，并处理接收器要求多指标同包的情形 | P0 |
| 删除事件 | 原生支持；HEA 编码遇到 delete 抛错 | 定义兼容策略与提示；目前同一个删除事件可能反复阻塞该页之后的数据 | P0 |
| 后台执行 | Observer、前台检查、BGTask 已接入 | 全局调度、整个唤醒周期的预算、暂停续跑和真实后台验收尚缺 | P0 |
| 大批次失败恢复 | 网络/408/429/5xx 重试；同 ID/正文保留 | 413 不自动拆批；Retry-After 只读秒数；还没有系统后台文件上传 | P0/P1 |
| 运行诊断 | 最近 30 条结果日志；当前总条数/批数/HTTP 状态 | 增加触发来源、指标级耗时、范围、读取/发送/确认数量、阶段与脱敏诊断导出 | P0 |
| 来源控制 | 每指标包含列表、全任务排除；过滤发生在取页后 | 关联记录的来源 UI 仍被挡住；多源重叠、同来源不同设备的语义需明确 | P1 |
| 单位偏好 | 每指标单位已实现 | 缺全局公制/英制默认值及覆盖层级；关联子项的单位目前不能单独配置 | P1 |
| 运动完整导出 | 只有摘要；路线和关联指标开关导致任务不可执行 | 增加运动类型筛选、路线、关联指标、秒/分钟分组以及大运动分页 | P1 |
| 特殊数据类型 | ECG、心情、用药等专用读取器未接入 | 按 HealthKit 查询家族补读取器；已有 Category 类型补业务标签和导出语义 | P1 |
| 任务批量操作 | 单任务 CRUD 已有 | 缺运行全部、批量启停、任务状态汇总 | P1 |
| 快捷指令 | 已有运行指定任务的 AppIntent，会打开 App | 真正从快捷指令调用尚未验收；缺创建/更新配置、查询结果等入口 | P1 |
| 配置迁移与 Skill | 只支持 HealthRelay 自有单任务 JSON | 缺 HEA 配置转换、批量导入、稳定 JSON Schema、Deep Link 和面向 Agent 的能力说明 | P1 |
| 备份与通知 | 手动配置导出、成功/失败通知 | 缺自动 iCloud 配置备份/恢复、提醒、缓存通知和桌面小组件 | P1/P2 |
| 其他目的地 | 只有 HTTPS POST | 本地文件/iCloud 可先扩展；MQTT、Home Assistant、Dropbox、Google、日历、邮件后续按需要做 | P2 |
| Mac 同步、查询服务器、MCP | 未实现 | 属于独立访问通路，不是配置任务或上传接口的前置依赖 | P2 |

HEA 的范围、汇总、REST 上传、运动选项与自动 Header 参照[REST 指南](https://help.healthyapps.dev/en/health-auto-export/automations/rest-api/)；额外参数见 [Deep Link 指南](https://help.healthyapps.dev/en/health-auto-export/automations/deep-link/)。任务备份、运行日志、提醒、小组件和目的地参照[自动化总览](https://help.healthyapps.dev/en/health-auto-export/automations/)。上述“当前状态”和优先级来自本项目代码审查，不代表 HEA 内部机制。

## 需要先改的几个设计

### 1. 汇总策略应属于指标，时间分组可以属于任务

当前 `AutomationConfig.allowedStatistics` 求交集：步数只有 `sum`，心率是 `average/minimum/maximum`，交集为空。因此二者放在同一个任务后，编辑器直接禁用汇总。

建议保留一个任务级时间分组，每指标采用目录声明的默认统计，允许高级覆盖。例如按小时输出时，累计型输出总量，测量型输出均值/极值，睡眠进入专用汇总流程。不要让用户为了不同统计方式被迫拆任务，也不要在调度器写死具体健康指标。

汇总必须输出稳定的窗口身份。收到迟到样本或删除事件时，重算受影响窗口并覆盖旧结果；仅汇总本次新样本会把“整小时平均值”变成“最近一批平均值”。删除事件只有 UUID，定位旧窗口需要受控的 UUID→时间窗口索引或明确的回查策略，这部分必须随汇总一起设计。

### 2. 原生格式与 HEA 兼容格式应明确区分

当前 HEAEncoder 对数量类型统一输出 `qty`；官方心率示例使用 `Min/Avg/Max`，睡眠、血压等也有专门结构。因此 16 个名称映射不等于 16 个类型的所有导出方式都兼容。[官方指标格式](https://help.healthyapps.dev/en/health-auto-export/export-format/health-metrics/)

建议把格式选择清楚拆成“HealthRelay 原生”和“HEA 兼容”。原生保留 UUID、删除事件和结构化字段；兼容模式按照验证过的契约转换。HEA CSV 需要单独验证 multipart 的字段、文件名和表格内容，不能把现有 `text/csv` 改个名字就算完成。

当前 HEA 模式遇到删除时，在批次保存前编码失败，anchor 不前移，后续运行会再次遇到它。应让用户明确选择“不传播删除”或改用能传播删除的原生协议；若允许跳过，必须记录次数和同步语义，不能静默声称远端与健康库完全一致。

### 3. 自动增量、周期快照、临时补传分开

现在所有日期模式都使用 anchor。相同日期窗口再次运行只输出变化；`pastDays` 实际包含当前日；今天的上界设为下一天零点。它们不能直接标成与 HEA 同名范围完全等价。

建议为任务明确输出语义：明细增量、窗口完整快照或汇总窗口更新。继续保留增量任务的“确认后推进游标、无新记录不上传”。一次性补传单独保存范围与进度，完成后回到原自动任务。

跨午夜的睡眠需专门验收：当前通用读取器使用 `strictStartDate`，开始于窗口之前的睡眠段不会被选入；按起始时间筛选明细和按睡眠日汇总是两种语义。

### 4. 后台需要统一队列，而不是更多触发入口

当前每任务防重入有效；但 `runDue` 可以被多个 Observer/前台/BGTask 并发调用，不同任务仍可能同时占用 HealthKit 和网络。`SyncEngine` 的 25 秒检查只发生在同一指标还有下一页时，多个单页指标及多个任务不能共享一个总预算。

先加全局待执行队列、合并重复触发、共享截止时间、保存剩余工作，并给长回填任务公平的续跑机会。前台检查开关与 BGTask 的使用也需拆清：目前 BGTask 调用相同 `runDue(false)`，会把 `onForeground` 当作周期后台检查资格。

后台上传可作为后续实现候选：先保存可上传文件，再交给系统传输，但这不能解决锁屏读取权限。HEA 官方同样不承诺按设定间隔准点后台执行；应展示最近触发和确认时间，而不是承诺定时器精度。[调度限制](https://help.healthyapps.dev/en/health-auto-export/automations/)

### 5. 配置入口共享同一份能力定义

目前目录、编辑器校验与执行器已有分工，但部分信息不一致：关联读取器已存在，来源选择仍提示等待读取器；未实现的运动选项和 HEA v1 仍可保存。

建议用简单的能力表统一“支持读取、支持汇总、支持该格式、支持后台”的状态，在具体控件旁说明限制。JSON 导入、编辑器和后续 Skill 复用同一校验，不另写三套规则。保留现有无第三方运行时依赖的结构，不为此引入复杂插件框架。

## 补齐顺序和验收

| 阶段 | 交付 | 必须看到的结果 |
| --- | --- | --- |
| A：配置可理解、可诊断 | 能力提示统一；逐指标统计配置；范围语义；运行/批次日志；一次性补传入口 | 未支持项保存/导入后仍明确；步数与心率能配置同任务不同统计；补传不改变正常任务进度 |
| B：汇总与兼容真正能用 | 数量汇总、睡眠汇总、窗口更新；常用 HEA v2；Header；HEA CSV；明确删除策略 | 同一窗口完整查询与增量重算相符；跨午夜/时区/删除正确；隔离接收器验收真实格式 |
| C：持续自动运行 | 全局队列、预算和公平续跑；大包恢复；快捷指令真机调用 | 多任务数据变化不并发失控；锁屏/解锁、断网、系统取消后可续跑；已确认数据不因重试重复新增 |
| D：扩展覆盖 | 完整运动、特殊家族、配置迁移/Skill、备份及其他目的地 | 每一类分别通过样例和真实触发验收，不用目录数量代替支持证明 |

先完成 A–C，再考虑增加必需服务端。当前自定义 HTTPS 接口已足够承载导出，Go/Docker、飞书签名、AI 和可视化继续作为可选下游。

## 仍须实测的 HEA 行为

- 官方 REST 文档描述 CSV 和多指标的聚合约束；此前实际单指标 CSV 文件保留明细。它们来自不同入口，迁移时需要按“入口＋格式＋指标数量＋汇总开关”比对，不能泛化为所有 CSV 都一样。
- “首选来源”界面已证实选择包含/排除；官方使用优先来源的描述，但未证明它等于可排序的来源优先级，更未证明重叠样本如何合并。HealthRelay 目前只承诺过滤语义。
- HEA 的内部缓存、重试、批次事务与恢复策略仍未验证，不能作为本项目已经对等的依据。
- [HEA Shortcuts](https://help.healthyapps.dev/en/health-auto-export/automations/schedule-automations-using-shortcuts/) 运行已有自动化，与 [Deep Link](https://help.healthyapps.dev/en/health-auto-export/automations/deep-link/) 创建配置是两种能力；HealthRelay 当前只实现前者的 AppIntent 入口，尚未完成快捷指令 App 内验收。
- [官方 MCP 项目](https://github.com/HealthyApps/health-auto-export-mcp-server) 通过同网络的 iPhone 查询服务器提供健康数据访问。它不是定时调度器，也不是 Skill 配置任务必须依赖的组件。

## 源码定位

- [AutomationConfig.swift](../packages/HealthRelayCore/Sources/HealthRelayCore/AutomationConfig.swift)：任务模型、统计交集、日期/HTTP 校验。
- [HealthRecord.swift](../packages/HealthRelayCore/Sources/HealthRelayCore/HealthRecord.swift)：执行能力阻断、自有 JSON/CSV/Markdown。
- [HEAEncoder.swift](../packages/HealthRelayCore/Sources/HealthRelayCore/HEAEncoder.swift)：16 项映射、数量/睡眠编码、删除拒绝。
- [HealthKitReader.swift](../ios/HealthRelay/HealthKitReader.swift)：通用查询、严格起始日期、来源过滤、关联及锻炼摘要。
- [SyncJournal.swift](../packages/HealthRelayCore/Sources/HealthRelayCore/SyncJournal.swift)：日期窗口、查询身份、原子待上传批次。
- [SyncEngine.swift](../packages/HealthRelayCore/Sources/HealthRelayCore/SyncEngine.swift)：按类型分页、时间预算、重试和进度提交。
- [HTTPUploader.swift](../packages/HealthRelayCore/Sources/HealthRelayCore/HTTPUploader.swift)：HTTP Header、确认契约、状态码分类。
- [AutomationStore.swift](../ios/HealthRelay/AutomationStore.swift)：多入口触发、最小间隔、通知与后台注册。
- [MetricPickerView.swift](../ios/HealthRelay/MetricPickerView.swift)：来源选择的当前限制。
- [RunAutomationIntent.swift](../ios/HealthRelay/RunAutomationIntent.swift)：运行现有任务的快捷指令入口。

本文件不包含个人健康样本、设备身份、生产接口或认证值；尚未验收的行为均保留缺项状态。
