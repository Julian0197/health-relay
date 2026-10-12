# HealthRelay

An open-source iOS app for configurable Apple Health exports and reliable automation. Swift-first; bring your own endpoint.

用配置建立 Apple Health 自动化任务：选择数据、来源、单位、日期范围、明细或汇总、执行条件和上传接口。

**当前状态：方案阶段。仓库尚无可安装的 iOS App；以下功能是实现目标。**

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
- [App 导出与可选 Docker 自部署](docs/self-hosting.md)
- [配置与上传协议](docs/contracts.md)
- [分阶段实施计划](docs/superpowers/plans/2026-10-12-health-relay.md)
- [能力覆盖与验收](docs/capabilities.md)
- [公开依据与调研边界](docs/research.md)
- [SDK 27 标识符清单](catalog/sdk-27-inventory.json)：覆盖盘点，**不表示已实现支持**。

本次 SDK 清单盘点到 121 个数量标识符、72 个分类标识符、6 个特征标识符和 2 个关联标识符。锻炼、心电图、用药等特殊对象另行列入能力表；不能将这 201 项等同于整个 HealthKit 的全部对象。

配置示例：[多指标明细](examples/task.raw.json)、[多指标日汇总](examples/task.daily.json)。传输示例：[上传批次](examples/batch.json)、[服务端确认](examples/receipt.json)。

示例都是合成数据；地址使用 `example.com`，认证只保留 Keychain 引用。它们不是 HEA 自身配置文件，不宣称可导入 HEA。

## 技术栈

Swift 6、SwiftUI、HealthKit、SQLite、URLSession、BackgroundTasks、AppIntents。计划最低 iOS 18；新系统类型独立使用 availability 检查。Go + Docker 是可选接收、存储和转发服务，也用于首条端到端链路验收；App 始终可以直接上传用户自己的接口。

iOS 决定后台执行时机。“每 30 分钟”是期望的最小间隔，不能保证准点读取和上传；锁屏时 HealthKit 可能无法读取，恢复访问后继续处理。

## 开源原则

独立实现公开功能与交互语义，不包含第三方二进制、反编译源码或素材。只在有验收样例时标记 HEA 格式兼容。贡献请使用合成数据，不提交真实健康导出、凭据、设备身份或私人日志。

MIT License。本项目与 Health Auto Export / HealthyApps 无隶属关系。
