# HealthRelay 通用自动化能力实施计划

> **For agentic workers:** 使用 executing-plans 分阶段实施与验收。用户当前只要求方案，不自动发布未验收 App。

**Goal:** 用户可自行配置健康指标、处理方式、执行条件与上传接口的 iOS App。

**Architecture:** 单一任务模型贯通 UI 与文件/自动化入口；家族读取器产生标准记录，SQLite 保存进度与待上传批次，HTTP 传输独立确认。增加指标只扩展目录/家族，不改变调度器。

**Tech Stack:** Swift 6、SwiftUI、HealthKit、SQLite、URLSession、BackgroundTasks、AppIntents，后续可选 Go。

---

本文是阶段交付计划，各阶段开始时再根据已存在代码拆成具体小步实现任务。当前不生成无法验收的 App 空壳。

10 月 12 日补充：按 `docs/self-hosting.md`，Go 基础接收器与 Docker 打包提前到阶段 3，用于端到端验收。阶段 6 再扩展处理器与生态。App 可直接上传任意配置目的地，自部署服务保持可选。

## 1. 配置和协议库

计划文件：`packages/HealthRelayCore/Package.swift`、`Sources/HealthRelayCore/AutomationConfig.swift`、`Capability.swift`、`ExportBatch.swift`，以及 `Tests/HealthRelayCoreTests/ConfigurationTests.swift`、`BatchTests.swift`。

- [ ] 实现 contracts 文档对应 Codable 类型，所有合成示例往返编码。
- [ ] 校验版本、家族、单位、统计、availability、URL、批次和认证引用。
- [ ] 测试非法配置、202、错误 batch ID、计数不一致均不能推进确认。
- [ ] `swift test --package-path packages/HealthRelayCore` 通过；公开 JSON 示例纳入测试。

产物：不需要健康权限即可测试的协议库。

## 2. 通用数量/分类目录与增量读取

计划文件：`packages/HealthRelayKit/Sources/HealthRelayKit/MetricCatalog.swift`、`QuantityReader.swift`、`CategoryReader.swift`、`SourceFilter.swift`；`packages/HealthRelayStore/Sources/HealthRelayStore/Store.swift`、`Migrations.swift`、`Tests/HealthRelayStoreTests/CheckpointTests.swift`。

- [ ] 对照 SDK inventory 完整登记数量/分类类型，逐项补名称、单位、availability 和读取能力。
- [ ] 通用 anchored 分页读取新增/删除，来源过滤与固定初始下界。
- [ ] 记录、anchor、变化范围同事务；注入事务前后退出并验证恢复。
- [ ] 真机核对有数据的数量/分类案例；增加指标无需改调度器。
- [ ] 发布完整覆盖表；没有真机样本不能标 deviceVerified。

产物：任意已支持数量/分类指标共用读取能力，不是固定业务任务。

## 3. 持久化批次与 HTTP

计划文件：`packages/HealthRelayTransport/Sources/HealthRelayTransport/HTTPDestination.swift`、`UploadCoordinator.swift`、`ReceiptValidator.swift`；`packages/HealthRelayStore/Sources/HealthRelayStore/Outbox.swift`；传输包 `Tests/HealthRelayTransportTests/RetryTests.swift`、`ReceiptTests.swift`。

- [ ] 固定 batch ID、文件和摘要，Keychain 注入凭据，拒绝重定向。
- [ ] 401/422/413/429/5xx 与断网处理，不跳过未确认数据。
- [ ] 服务端提交后断连，重发同 ID；两种确认模式分别验收。
- [ ] 恢复 URLSession 回调和 outbox，容量硬上限停止新读取。
- [ ] 增加 `server/cmd/receiver/main.go`、`server/internal/ingest/handler.go`、接收事务测试、`Dockerfile` 和 `compose.yaml`；批次/去重持久化后确认，重启不丢队列。
- [ ] 验收手机向 Docker 接收器上传、重复批次、容器重启、下游不可达与恢复。下游转发状态和接收确认分开。

产物：可接自有服务的可靠上传，不为网络故障重复扫历史。

## 4. iOS UI、后台和快捷指令

计划文件：`ios/HealthRelay/HealthRelayApp.swift`、`HealthRelay.entitlements`、`Features/Automations/AutomationList.swift`、`AutomationEditor.swift`、`Features/Catalog/MetricPicker.swift`、`Features/Logs/RunLogView.swift`、`Automation/TaskExecutor.swift`、`BackgroundCoordinator.swift`、`RunAutomationIntent.swift`、`Security/CredentialStore.swift`。

- [ ] 建立 iOS 18+ target，权限用途说明与 HealthKit/background delivery capability。
- [ ] 创建、编辑、复制、启停通用任务；UI 与文件导入共用校验器。
- [ ] 先验收手动预览→读取→上传→回执，再接 Observer、后台补跑、前台恢复。
- [ ] 真机验收锁屏、低电量、取消、退出、断网与恢复；记录实际延迟。
- [ ] JSON 导入差异预览、默认禁用；导出不携带 secrets 或运行进度。
- [ ] AppIntent 运行已有任务与查询状态，共用执行器和游标。

产物：首个可安装版本；只开放已实现能力。

## 5. 汇总与复杂对象

计划文件：`packages/HealthRelayKit/Sources/HealthRelayKit/StatisticsReader.swift`、`CategorySummary.swift`、`CorrelationReader.swift`、`WorkoutReader.swift`；`packages/HealthRelayStore/Sources/HealthRelayStore/DirtyWindowStore.swift`；核心包 `Tests/HealthRelayCoreTests/WindowTests.swift`。

- [ ] 累计、离散算术、时间加权分别验收；非法统计两处拒绝。
- [ ] 迟到/删除只重算相交窗口，snapshot revision 与批次事务化。
- [ ] 测试时区、夏令时、跨天分类、空窗口和多来源语义。
- [ ] 接入关联与锻炼核心，再逐类做路线、ECG、心情、用药等专用读取。
- [ ] 更新能力表，不把一个家族完成写成全功能完成。

产物：统一配置下的通用汇总和复杂数据扩展。

## 6. 兼容与生态

计划文件：核心包 `Sources/HealthRelayCore/HEAV2Encoder.swift`；`server/go.mod`、`server/cmd/receiver/main.go`、`server/internal/ingest/handler.go`、`handler_test.go`；`skills/configure-automation/SKILL.md`。

- [ ] 公开协议与合成样例验收 HEA v2 编码器，列出兼容范围。
- [ ] Go 参考服务事务去重并返回提交回执。
- [ ] Skill 生成/检查 JSON 与导入指引，不自动取得健康权限。
- [ ] 下游签名/看板独立接入，数据没变化时复用结果。
- [ ] Dropbox、Google、MQTT、MCP 按需求独立增加 adapter。

产物：用户可自接服务，已有服务迁移有明确兼容边界。

## 每阶段检查

- [ ] 文档的已支持状态与代码、测试、真机证据一致。
- [ ] 只提交自主代码、文档和合成例子，无个人导出/凭据/第三方二进制。
- [ ] 本阶段通过才进入下一阶段；提交说明实际测试与真机边界。
