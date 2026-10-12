# HealthRelay 通用自动化能力实施计划

2026-10-12 更新。用户已授权实现并用真机调试；当前先完成 App，不开发 Go/Docker 服务。本文记录阶段状态，后续能力必须有各自验收。

**Goal:** 用户自行配置健康指标、来源、范围、执行条件与上传接口，App 可可靠导出。

**Architecture:** 单一版本化任务模型贯通 UI、文件和 AppIntent；家族读取器生成标准记录，每任务原子 JSON 保存一个待上传批次与建议检查点，有效 HTTP 确认后提交 anchor。首版不增加 SQLite、多包层或服务依赖。

**Tech Stack:** Swift 6、SwiftUI、HealthKit、Keychain、URLSession、BackgroundTasks、AppIntents；后续可选 Go。

## 1. 配置与协议库

- [x] Codable 配置、目录、版本化 JSON 导入/导出与原子配置保存。
- [x] 校验版本、家族、单位、统计、availability、URL、Header、批次和认证引用。
- [x] 标准 upsert/delete 记录、原生 JSON/CSV/Markdown 编码。
- [x] receipt 与 http2xx 两种确认，拒绝 202、错误 ID 与错误计数。
- [x] 合成协议与本地持久化测试通过。

产物已在 `packages/HealthRelayCore/`。

## 2. 通用数量/分类/关联与锻炼读取

- [x] SDK 27 数量/分类目录、系统版本限制、单位映射。
- [x] 通用 anchored 分页读取新增/删除，来源过滤，固定增量首次下界。
- [x] 关联父子结构、锻炼摘要和可表示 metadata。
- [x] 真机 SDNN、RMSSD、步数、睡眠四类型原生明细读取与隔离 Cloudflare 提交回执核对；只将这四项标 deviceVerified。
- [ ] 数量/分类/关联/锻炼逐类型真实样本核对；不能将家族实现标成全目录 deviceVerified。

产物在 `ios/HealthRelay/HealthKitReader.swift`；覆盖状态见 `docs/capabilities.md`。

## 3. 持久化批次与 HTTP

- [x] 每任务一个固定 batch ID 与固定正文，原子保存 pending 和建议 anchor。
- [x] 有效确认后提交 anchor；失败/重启保留原批次，不跳过未确认数据。
- [x] HTTPS、Keychain 注入、拒绝重定向，两种确认。
- [x] 网络/408/429/5xx 退避；认证/协议/413 错误暂停自动重试。
- [x] 本地编码字节超限缩小查询页；单条超限明确报错。
- [x] 明确取消 pending 后修复配置，不推进已提交 anchor。
- [x] 合成 HTTPS 验收：503 → App 重启 → 同 ID/正文 → 200 receipt → 无新数据不再请求。
- [x] 可选隔离 Cloudflare 原生 receipt 接收器，独立 DO SQLite 存储、测试认证、固定批次 SHA-256 去重与索引计数；2 项 Node 边界测试和合成重放验收。
- [x] 真机混合任务向隔离接口确认 691 条/16 批，再次无新数据运行不增加计数；不向已有生产存储写入。
- [ ] 服务端 413 自动拆批、后台 URLSession 及多批次存储；有需求后实施。

产物：`SyncJournal.swift`、`SyncEngine.swift`、`HTTPUploader.swift`。本阶段保持单文件事务边界，SQLite 原计划暂缓。

## 4. iOS UI、后台与快捷指令

- [x] iOS 18+ target、HealthKit/后台 capability、读取用途说明。
- [x] 创建/编辑/复制/删除/启停，JSON 预览与认证重新绑定。
- [x] 手动读取检查、运行、pending 修复与最近日志。
- [x] Observer 先保存 dirty 再 completion；前台/BGTask 共用执行器。
- [x] 运行中新的 dirty 不被结束操作清除；失败/未完成保留补跑机会。
- [x] AppIntent 选择已有任务、打开 App 并调用同一执行器。
- [x] 按配置申请结果通知，成功默认不通知。
- [ ] 真机锁屏、低电量、断网、取消、Observer 与后台延迟验收。
- [ ] 快捷指令 App 实际调用验收。
- [ ] 系统文件选择器导入/导出端到端验收。

原生模拟器构建与 2 项 UI 测试已通过。系统唤醒不是精确定时。

## 5. 汇总与复杂对象

- [ ] HealthKit 合法累计/离散/时间加权统计，不把时间取整当作平均。
- [ ] 分类时长、迟到/删除只重算相关窗口，版本化 snapshot。
- [ ] 时区/夏令时、跨日、多来源与空窗口验收。
- [ ] 运动路线/关联时序、ECG、心情、用药等专用读取与完整子数据。
- [ ] 更新能力表，只按实际证据扩大执行范围。

当前仅可配置，不能执行汇总或这些专用对象。

## 6. 兼容与生态

- [x] HEA v2 显式数量/睡眠明细映射、时区转换、删除拒绝测试。
- [ ] 逐指标 HEA 接收器矩阵与迁移验收；HEA v1 未开放。
- [ ] 配置生成/检查 Skill，与 App 同一模型，不自动取得健康权限。
- [ ] 可选 Go 接收器的事务去重与提交回执；不是 App 运行前提。
- [ ] 按实际需求接下游签名/看板，数据不变复用结果。
- [ ] Dropbox、Google、MQTT、MCP 等独立目的地。

## 当前验收与发布检查

- [x] 34 项 Core 测试（19 Swift Testing + 15 XCTest）。
- [x] iOS 27 模拟器构建，2 项原生 UI 测试，合成 HTTPS 重启恢复。
- [x] 合成测试读取器不编入真机与 Release。
- [x] 真机隔离测试接口的四类型原生手动链路完整确认，不从模拟器推定；后台与 AppIntent 实际自动调用仍待验收。
- [ ] 发布前核对文档与实现、测试、设备证据一致。
- [ ] 发布前检查不含真实健康样本、认证、设备身份、日志或第三方二进制。

细节见 `docs/implementation-execution.md`。第一阶段历史记录保留于 `docs/implementation-configuration.md`。
