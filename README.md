# HealthRelay

An open-source iOS app for configurable Apple Health exports and reliable automation. Swift-first; bring your own endpoint.

用配置建立 Apple Health 自动化任务：选择数据、来源、单位、日期范围、明细或汇总、执行条件和上传接口。

**当前状态：通用明细、数量/睡眠汇总、HEA v2 兼容、独立历史补传和后台续跑已实现。模拟器与独立 Cloudflare 测试接口已通过；本轮新增能力的真机验收待继续，iOS 决定实际后台调度。**

## 当前可用

- 任务列表、新建、编辑、复制、删除与本地保存。
- 指标搜索和多选：121 个数量、72 个分类标识符，另有 2 个关联配置和锻炼配置；新系统指标按 iOS 版本限制选择。
- 每指标单位/来源、任务来源排除、增量/日历/自定义日期范围。
- 明细/汇总、秒至年的分组、合法数量统计；导出格式偏好与锻炼路线/曲线选项。
- HTTP URL、Header、认证、超时、确认模式、间隔与批次偏好。
- JSON 配置预览、文件导入/导出；认证保存到 Keychain，导出仅保留重新绑定所需的 Header 名称。
- 通用数量、分类、关联明细和锻炼摘要读取；按类型保存 HealthKit anchor，支持新增和删除事件。
- 原生 `healthrelay.v1` JSON、CSV、Markdown；20 项 HEA v2 映射、自动请求上下文和明确命名的 HEA multipart CSV profile。
- 每指标独立汇总，完整时间窗口与迟到/删除修正；睡眠按跨午夜窗口归属和时段去重。
- 固定日期历史补传，独立进度、继续/取消；普通任务与补传共享公平串行队列。
- 手动运行、读取检查、活动日志、失败后保留并重试；已确认后推进游标，没有新记录不发送 HTTP 请求。
- HealthKit 数据变化、前台补跑、系统后台刷新与运行已有任务的 AppIntent。

配置能力比执行能力更广。**HEA v1、运动路线/关联时序和特殊对象读取尚未开放执行**；不支持的组合会显示原因并阻止运行。HEA v2 只支持 [显式映射](packages/HealthRelayCore/Sources/HealthRelayCore/HEAEncoder.swift)，不能表达删除事件，可明确选择拒绝或跳过；HEA CSV 字段布局尚未对照真实 HEA 捕获，不宣称 HEA 全功能对等或全部 HealthKit 类型已验收。

## 运行与验证

要求 Xcode 27 / Swift 6，App 最低 iOS 18。打开 `ios/HealthRelay.xcodeproj`，选择 `HealthRelay` scheme 和 iPhone 模拟器运行。真机需选择自己的签名 Team，并启用 HealthKit 与后台读取能力。

```sh
swift test --package-path packages/HealthRelayCore
xcodebuild -project ios/HealthRelay.xcodeproj -scheme HealthRelay -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

[执行阶段说明](docs/implementation-execution.md)包含运行步骤、失败恢复、测试证据和实际限制；[配置阶段记录](docs/implementation-configuration.md)保留第一阶段的历史验收。

本轮通过 63 项 Core 测试（含显式开启的 Swift→Cloudflare 集成）、5 项接收器测试、3 项原生模拟器 UI 测试和 iOS 构建。覆盖窗口修正、无变化不重算、503 重启重试、跨午夜续跑、独立补传和 multipart 请求。详见[自动化核心实现与验收](docs/implementation-automation-core.md)。

此前真机已将 SDNN、RMSSD、步数和睡眠原生明细上传到独立测试接口，691 条/16 批确认，随后无新数据时计数不变。该结果不证明本轮新汇总、HEA 格式和自然后台唤醒已验收；用户使用手机期间暂缓真机操作。未向既有生产接口写入。

## 界面

以下为 iOS 27 模拟器真实运行截图，任务与接口均为合成验收配置。

<img src="docs/images/automations.png" width="280" alt="自动化任务列表"> <img src="docs/images/configuration-editor.png" width="280" alt="配置编辑"> <img src="docs/images/metric-picker.png" width="280" alt="指标搜索与多选">

<img src="docs/images/execution-success.png" width="280" alt="合成数据 HTTPS 确认成功"> <img src="docs/images/execution-no-data.png" width="280" alt="增量游标避免重复上传">

## 产品边界

核心是通用健康数据自动化配置引擎。用户选择任意已支持的 HealthKit 类型，通过同一任务模型执行；指标名称不进入调度或上传引擎的业务判断。

- 数量、分类、关联和复杂对象通过对应读取器接入；增加指标通常只扩展目录。
- 可配置 HTTP endpoint、headers、单位、来源、日期范围、明细/汇总和执行条件。
- 增量读取、持久化待上传批次、重试、确认和活动日志。
- App、快捷指令与后续 Skills 使用同一个版本化配置模型。
- 用户可接自己的服务；飞书签名、Bot 和 HTML 看板属于下游应用。

“全指标”是覆盖目标，不是当前交付状态。数量指标、分类记录、心电图、用药等有不同的查询方式和系统可用性；以逐项验收的能力表为准。

## 方案与示例

- [技术设计（中文）](docs/design.md)
- [自动化核心实现与验收](docs/implementation-automation-core.md)
- [导出执行实现与验收](docs/implementation-execution.md)
- [App 导出与可选 Docker 自部署](docs/self-hosting.md)
- [配置与上传协议](docs/contracts.md)
- [分阶段实施计划](docs/superpowers/plans/2026-10-12-health-relay.md)
- [能力覆盖与验收](docs/capabilities.md)
- [HEA 自动化差距与补齐顺序](docs/hea-automation-gap-audit-2026-10-12.md)
- [公开依据与调研边界](docs/research.md)
- [SDK 27 标识符清单](catalog/sdk-27-inventory.json)：覆盖盘点，**不表示已实现支持**。

本次 SDK 清单盘点到 121 个数量标识符、72 个分类标识符、6 个特征标识符和 2 个关联标识符。锻炼、心电图、用药等特殊对象另行列入能力表；不能将这 201 项等同于整个 HealthKit 的全部对象。

配置示例：[多指标明细](examples/task.raw.json)、[多指标日汇总](examples/task.daily.json)。传输示例：[上传批次](examples/batch.json)、[服务端确认](examples/receipt.json)。

示例都是合成数据；地址使用 `example.com`，认证只保留 Keychain 引用。它们不是 HEA 自身配置文件，不宣称可导入 HEA。

## 技术栈

当前使用 Swift 6、SwiftUI、HealthKit、Keychain、URLSession、BackgroundTasks 和 AppIntents，没有第三方运行时依赖。任务配置与每任务同步状态以受保护的 JSON 文件原子保存；首版每任务最多一个待上传批次，确认后才推进对应 anchor。暂不引入 SQLite 或后台 URLSession。

第一阶段只开发 App，不增加 Go 服务或 Docker；App 将直接上传到用户配置的接口。自部署文档保留为后续可选方案，不是运行前提。

iOS 决定后台执行时机。“每 30 分钟”是期望的最小间隔，不能保证准点读取和上传；锁屏时 HealthKit 可能无法读取，恢复访问后继续处理。

## 开源原则

独立实现公开功能与交互语义，不包含第三方二进制、反编译源码或素材。只在有验收样例时标记 HEA 格式兼容。贡献请使用合成数据，不提交真实健康导出、凭据、设备身份或私人日志。

MIT License。本项目与 Health Auto Export / HealthyApps 无隶属关系。
