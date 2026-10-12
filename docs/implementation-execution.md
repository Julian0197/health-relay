# 第二阶段：明细读取、持久化与 HTTP 执行

2026-10-12。第一版导出链路已实现；配置仍以通用任务为中心，不增加专用服务或固定业务指标。

## 如何运行

1. 新建任务，选择数据和合法单位/来源，先使用原始明细。
2. 选择原生 HealthRelay JSON、CSV 或 Markdown；已有 HEA 接收器只选已映射的 HEA v2 指标。
3. 填写 HTTPS URL、Header/Keychain 认证、日期范围和确认方式。
4. 保存后进入运行与日志，先检查健康读取，再立即运行。检查读取不上传，也不推进游标。
5. 核对接收端结果后启用自动化。导入配置和复制任务默认关闭，需要重新绑定认证。

没有新事件不会上传空批次。已经有过确认上传的任务显示“没有可读取的新记录，无需重复上传”；lastConfirmedAt 单独保存最近确认，不用空结果覆盖它。初次空结果不能证明拒绝权限；也可能是尚未有样本或尚未同步。

## 实现

| 文件 | 职责 |
| --- | --- |
| ios/HealthRelay/HealthKitReader.swift | 可用性/权限、anchored 分页、来源过滤、单位、数量/分类/关联/锻炼摘要 |
| packages/HealthRelayCore/HealthRecord.swift | 标准记录、UTC 时间、原生 JSON/CSV/Markdown、执行能力校验 |
| packages/HealthRelayCore/HEAEncoder.swift | 显式 HEA v2 数量与睡眠映射，拒绝未支持的指标/删除 |
| packages/HealthRelayCore/SyncJournal.swift | 原子同步文件、查询身份、提交检查点与待上传批次 |
| packages/HealthRelayCore/SyncEngine.swift | 同任务串行、固定批次、确认后推进、分页/预算/失败恢复 |
| packages/HealthRelayCore/HTTPUploader.swift | Keychain 值注入、HTTPS/POST、重定向拒绝、两种确认与重试判定 |
| ios/HealthRelay/AutomationStore.swift | 启停、权限、Observer dirty、前台/BGTask、通知与修复入口 |
| ios/HealthRelay/RunAutomationIntent.swift | 选择已有任务并打开 App，使用同一执行器 |
| ios/HealthRelay/TaskExecutionView.swift | 运行、读取检查、待上传状态、取消待上传确认、最近日志 |

Core 源文件实际位于 `packages/HealthRelayCore/Sources/HealthRelayCore/`。

每任务最多一个待上传批次，与建议新 anchor 一起原子写入受保护 JSON；有效确认后提交 anchor 并清除 pending。HTTP 失败不先推进进度，重启重发相同 ID/正文；不需要 SQLite 也能先保持这个边界明确。日志最近 30 条，不累计全部健康样本。

首次增量下界固定；后续查询使用 anchor，能读到覆盖范围内迟到写入和删除。不同类型独立检查点；改名称不引起历史重读。日历窗口/数据规则改变、重装或重新回填仍可能重复上传，所以服务端必须幂等。

## 失败如何修复

网络、408/429/5xx 保留批次并退避；手动运行可提前重试。401/403、422、413、重定向或无效回执保留批次并暂停自动重试，避免重复打错误接口。

有 pending 时禁止改配置。需要修复目标或规则，可明确取消待上传；它只删除未确认正文，不推进提交 anchor，然后重新配置和读取。旧请求可能已到达接收端；这个操作不撤销服务器数据，也不能代替去重。

本地字节超限会减小读取页；单条过大报错，服务端 413 自动拆批仍待实现。同步文件损坏则停止，不静默重建以免重读或丢进度。

## 本阶段验收

已通过：34 项 Core 测试（19 项 Swift Testing、15 项 XCTest）、iOS 27 模拟器构建、2 项原生 UI 测试。

- 创建通用任务、选择指标、保存、退出后恢复。
- 真实本地 HTTPS 首次返回 503，保留待上传批次。
- 退出/重开 App，再运行使用相同 batch ID 与相同正文 SHA-256。
- 接收有效 200 整批回执后提交 anchor，下一次无新数据不增加 HTTP 请求。
- 错误批次/计数、202、不可重试状态、损坏状态、原生删除、HEA 删除拒绝和 UTC/时区转换回归。

合成读取器只存在于显式开启测试参数的 Debug 模拟器编译中；真机与 Release 不编入这个读取器。本地 HTTPS 模拟器测试接口、配置和样本都是合成内容，真实健康导出、认证、设备身份和私人日志不提交。

真机端到端验收已通过：2026-10-12 16:53（Asia/Shanghai），混合任务读取普通 HRV（SDNN）、恢复 HRV（RMSSD）、步数和睡眠，向独立 Cloudflare 测试接口上传原生 JSON，收到 200 提交回执，共 691 条、16 批。16:55 再次运行返回无新数据，服务端计数不变，确认没有额外 HTTP 上传。

测试存储总计为 17 批/692 个事件，其中 1 批/1 条是先前合成 CLI 验收；其余为上述真机上传。公开记录只保留数量与类型，不含实际健康值、来源身份或接口凭据。没有向既有生产接收器 POST。

只有这四个类型的原生明细手动链路标记 deviceVerified；不据此标记全部数量/分类、HEA v2、复杂对象或后台已验收。

```sh
swift test --package-path packages/HealthRelayCore
xcodebuild -project ios/HealthRelay.xcodeproj -scheme HealthRelay -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

配置 UI 测试使用独立目录，不改正常用户任务：

```sh
xcodebuild -project ios/HealthRelay.xcodeproj -scheme HealthRelay -destination 'platform=iOS Simulator,id=YOUR_SIMULATOR_ID' -parallel-testing-enabled NO -only-testing:HealthRelayUITests/ConfigurationUITests/testCreateAndPersistGenericTask CODE_SIGNING_ALLOWED=NO test
```

HTTPS UI 测试还需启动合成测试接收器并让模拟器信任本地测试 CA；不能仅执行 xcodebuild 就声称网络验收。私有测试产物和本地证书不进版本库。

## 可选 Cloudflare 验收接收器

源码为 `tests/cloudflare/worker.mjs`，用于测试原生 `healthrelay.v1` 与 receipt 模式，不是 App 运行前提。独立 Worker、`HealthRelayAcceptance` Durable Object SQLite namespace 和 `TEST_API_KEY`；不复用生产数据库绑定、飞书或看板逻辑。

- `POST /ingest`：要求 X-API-Key、匹配 Idempotency-Key，最多 500 条/1 MiB；按 task/type/UUID 更新或删除记录。
- 相同 batch ID、相同正文 SHA-256 返回原确认，不再次增加计数；不同正文返回 409。记录、批次和计数同事务提交。
- `GET /status`：认证后读取一条主键统计记录，避免重复扫描健康历史。events 是新批次的事件总量，不是唯一样本数量。
- `GET /healthz`：只返回测试环境健康状态，不含数据。

2 项 Node 测试验证原生批次/时间/ID 和认证前置；已部署测试环境的合成请求验证重复批次不增加计数。真实手机的四类型原生上传另外经过上述 200 回执与计数验收；Node 测试本身不证明真机结果。

```sh
node --test tests/cloudflare/worker.test.mjs
```

自行部署时，把下列配置保存到忽略提交的 `private-artifacts/cloudflare/wrangler.jsonc`；使用新 Worker 名称和新 namespace，不添加生产绑定。账号 ID 如需填写也只放本机配置，不放公共仓库。

```json
{
  "name": "healthrelay-acceptance-your-suffix",
  "main": "../../tests/cloudflare/worker.mjs",
  "compatibility_date": "2026-10-12",
  "durable_objects": {
    "bindings": [{"name": "TEST_STORE", "class_name": "HealthRelayAcceptance"}]
  },
  "migrations": [{"tag": "v1", "new_sqlite_classes": ["HealthRelayAcceptance"]}]
}
```

在自己的 Cloudflare 登录/Token 权限环境中运行：

```sh
npx wrangler deploy --config private-artifacts/cloudflare/wrangler.jsonc
npx wrangler secret put TEST_API_KEY --config private-artifacts/cloudflare/wrangler.jsonc
```

密钥通过交互式输入，不写进脚本或配置文件。App 使用部署后的 `/ingest`、X-API-Key 和 receipt 模式，先用合成样本核对，再用经授权的真机任务。测试存储没有生产多用户隔离、长期保留/删除策略或完整运维；验收后停止测试任务并清理测试部署与数据。

启用测试任务后，真机还观察到 Observer 注册产生的自动检查，未点立即运行也新增了运行日志。这个前台注册回调不证明锁屏后的后台准点唤醒；长期调度仍待观察。测试任务恢复为 30 分钟最小间隔，目标仅为隔离测试接口。

## 当前限制

- 汇总/分钟分组、HEA v1、路线/运动关联时序与特殊对象未开放执行，配置页会提示。
- HEA v2 只支持显式映射；没有原生 UUID/完整 metadata/删除语义，不是全部 HEA 兼容。
- 单批次模型暂停新读取直到确认；没有后台 URLSession，也没有多批次并行队列。
- BGTask/HealthKit 唤醒由 iOS 决定，最小间隔不是精准定时承诺。锁屏、低电量、系统取消、Observer 实际唤醒待真机验收。
- AppIntent 已构建并使用同一引擎，但快捷指令 App 实际运行待验收。
- HTTP 2xx 不证明数据库提交；仅匹配当前 receipt 协议才能获得整批确认语义，接收端仍负责可靠去重。

下一步优先验收真机后台/锁屏/取消和快捷指令，再扩展类型与汇总；隔离测试成功不替代生产兼容验收。
