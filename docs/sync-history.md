# 本机同步历史

iOS 和 Watch 首页均有「同步历史」，任务执行页的同名入口只查看当前任务。每台设备独立保存，可离线查看。列表按最近活动日期分组，每页 50 条，可筛选全部、成功、待处理与异常。

## 记录与时间

每个上传批次一条记录，同批重试合并，详情保留排队、各次尝试、失败原因与确认时间。未形成批次的读取异常单独记录；无新数据的检查不进入历史。日常同步、历史补传、Watch 运动摘要均接入。任务删除后，已有历史仍按保留期限清理。

- **同步时间**：客户端收到有效回执的时间。Watch 后台回执先保存实际完成时间，重启处理不会改成重启时间。
- **测量时间**：上传数据本身的开始和结束时间，与同步时间分开。
- **待上传、传输中、失败、取消**：分别显示排队、发送、失败或取消时间，不作为同步成功。
- **旧版执行摘要**：幂等导入仍保留的近 20 天旧日志。已经被旧版清除的日志不补造；没有记录的健康数值显示暂无。旧版后台回执未记录完成时间时不补造同步时间。

## 数据摘要

从实际上传的 `HealthRecord` 在生成批次时提取指标条数、删除条数、测量范围、最新记录值与单位，不保存完整原始数据和认证值。睡眠显示阶段摘要；锻炼显示运动类型及该次累计时长，连续分钟摘要不相加。步数显示的是本批数据的最新值，不能当作今日步数总量。本次不回传 Mac 计算的压力、睡眠评分。

## 保存与恢复

系统 SQLite，应用沙盒内：

| 设备 | 路径（相对应用数据容器） |
| --- | --- |
| iPhone | `Library/Application Support/HealthRelay/history/history.sqlite` |
| Watch | `Library/Application Support/HealthRelayWatch/history/history.sqlite` |

历史目录排除云备份，数据库及辅助文件使用完整文件保护；锁定时可能暂不可读，解锁后重试。每次数据库操作结束关闭连接，避免跨锁定周期保留已打开的受保护文件。

保留最近 **20 × 24 小时内有活动**的批次，按最近活动倒序。启动、新增事件时清理；浏览记录不会延长保留期限。近期有重试的批次保留整条尝试时间线，批次过期后连同事件删除。原有诊断日志仍最多 30 条，并清除 20 天前的日志。未确认上传数据不受历史清理影响，继续由原有 outbox 管理。

同步状态和历史事件先在同一个 journal 文件中原子保存，再按事件 ID 幂等投影到 SQLite。数据库不可写时保留事件、稍后恢复，不重复推进游标，也不因历史展示失败丢弃待传数据。SQLite 损坏时报告读取错误，保留原文件。

## 实现与验证

- Core：`SyncHistory.swift`（模型、摘要）、`SyncHistoryStore.swift`（索引、事务、分页）、`SyncHistoryBrowser.swift`（异步列表状态）。
- 接入：`SyncJournal`、`SyncEngine`、`DeferredDelivery`、`WorkoutRelayOutbox`；两端 Store 和 Watch 后台上传器。
- 界面：`shared/SyncHistoryView.swift`。
- Core 测试覆盖重试合并、重复回执、部分成功、取消、运动累计、旧文件、崩溃恢复、20 天边界及 2 万条记录的稳定分页；两端原生测试验证迁移和后台回执兼容。
- iOS 界面测试覆盖入口、筛选、详情、空记录、读取错误及重启后查看。模拟器夹具仅在 DEBUG + simulator + 显式 `--ui-testing` 参数下运行，只写本机历史，绝不上传。

模拟器测试请使用有效的模拟器签名，以免已有 Keychain 测试因缺少 entitlement 报错：

```sh
swift test --package-path packages/HealthRelayCore
xcodebuild -project ios/HealthRelay.xcodeproj -scheme HealthRelay \
  -destination 'platform=iOS Simulator,id=<simulator-id>' \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES \
  -only-testing:HealthRelayTests -only-testing:HealthRelayUITests/SyncHistoryUITests test
xcodebuild -project ios/HealthRelay.xcodeproj -scheme HealthRelayWatch \
  -destination 'platform=watchOS Simulator,id=<simulator-id>' \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES test
```

构建或模拟器通过不等于真机完成验收。真机需确认升级不改任务、认证和待传批次，完成真实上报，再重启 App 验证原确认时间保持不变。真实健康快照和截图只放本机忽略目录，不提交仓库。
