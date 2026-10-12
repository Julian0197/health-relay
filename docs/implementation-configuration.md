# 第一阶段：iOS 自动化配置

> 这是第一阶段历史记录。明细读取、持久化上传与手动真机验收的最新状态见 [第二阶段执行说明](implementation-execution.md)；下文“尚未实现”及后续 SQLite 设想仅对应第一阶段。

2026-10-12。本阶段实现可运行的配置 App；不包含健康明细读取、实际导出/上传、后台调度、通知投递或服务端。

## 已实现

SwiftUI 任务列表与编辑器，创建、编辑、复制、删除、JSON 预览和系统文件导入/导出。Core 包包含 Codable 模型、校验器、版本化文件交换和本地保存。

指标目录含 121 个数量、72 个分类、2 个关联配置描述和一个锻炼配置描述。健康指标任务可以混选数量、分类和关联明细，或限制到单独家族；混合项没有共同统计能力时不能错误汇总。页面支持搜索、分类和多选；每指标单位与包含来源独立配置。来源查询由用户在对应页面主动触发，只请求所选类型的读取权限；空结果不推断读取被拒绝。关联来源查询暂不开放。

范围包括自上次同步、今天、昨天、过去 N 天和自定义，携带时区与初始读取范围。汇总根据目录中共同的统计能力校验，不把累计与离散类型错误地配置成同一种统计。

格式偏好可保存 HealthRelay JSON、HEA JSON v1/v2、CSV、Markdown；分组可保存秒、分钟、小时、天、周、月、年。它们只描述后续执行器的目标，不表示已有编码器或 HEA 格式兼容证明。

锻炼可配置是否包含路线/相关指标及曲线秒/分钟分组。目的地首版为 HTTP POST，支持 HTTPS、普通 Header、Keychain 认证、超时和两种成功确认模式；执行偏好包括触发条件、间隔、批次和通知。

## 保存和凭据

仅配置阶段不需要 SQLite。任务以 `Application Support/HealthRelay/tasks.json` 原子写入；iOS 使用完整文件保护。后续健康数据队列再使用 SQLite。

认证值保存在 `org.healthrelay.automation-credentials` Keychain service，配置只存 UUID 引用。导出与导入移除认证值和设备引用，保留需要重新填写的 Header 名称。导入默认关闭并预览，相同任务 ID 由用户选择创建新任务或检查后更新。

本地文件损坏/版本不支持时显示读取错误并停止保存，不把错误文件当成空列表自动覆盖。保存失败不会替换内存里的原任务；新增凭据引用在配置保存失败时回收。

任务当前均保存为关闭状态，页面明确提示未开始读取或上传；没有伪造运行成功或活动日志。

## 工程

```text
packages/HealthRelayCore/         模型、目录资源、校验、文件交换和保存
ios/HealthRelay/                 SwiftUI、Keychain、来源查询、系统文件入口
ios/HealthRelayUITests/          创建/选择/保存/重启恢复的真实 UI 测试
ios/HealthRelay.xcodeproj/       已提交的原生 Xcode 工程与共享 scheme
scripts/generate_catalog.py     从本机 SDK 生成配置元数据
scripts/generate_xcode_project.py  无第三方依赖的工程再生成工具
```

生成文件已提交，正常克隆构建不需要运行生成脚本。目录生成器固定核对 SDK 27 数量/分类数量，SDK 升级后需审查新增类型与单位/统计元数据。

## 验证

Core 的 Swift Testing 覆盖示例往返、未知版本、导入关闭、认证脱敏与重新绑定、重复 ID、损坏文件、单位/类型/版本、日期和汇总、Header CRLF。界面测试在独立 `HealthRelay-UITests` 配置目录运行，不修改正常用户配置。

本次验证：19 项 Core 测试通过；iOS 27 iPhone 18 Pro 模拟器构建与一项创建/保存/重启恢复 UI 测试通过。文件编解码经过 Core 测试；系统文件选择器导入/导出、真实来源查询和真实设备签名安装未做端到端验收。界面截图保存在 `docs/images/`，测试结果与构建产物不提交。

```sh
swift test --package-path packages/HealthRelayCore
xcodebuild -project ios/HealthRelay.xcodeproj -scheme HealthRelay -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

原生 UI 测试使用安装的 iPhone 模拟器，替换下面的设备 ID：

```sh
xcodebuild -project ios/HealthRelay.xcodeproj -scheme HealthRelay -destination 'platform=iOS Simulator,id=YOUR_SIMULATOR_ID' -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO test
```

UI 过程：创建任务 → 搜索并选择体重 → 填写合成测试地址 → 保存 → 关闭并重开 → 检查任务和名称仍在。体重只是验收案例，任务模型不固定指标。iOS 27 搜索态会隐藏导航栏按钮，确认选择已放在固定底部区域。

## 下一阶段

接入按家族读取明细、HealthKit anchor、受保护的本机待上传队列、具体编码器和 HTTP 上传。启用任务前同时检查权限、格式执行能力和认证绑定，不能因为本阶段允许保存格式偏好，就假定可以运行所有格式。

HEA 配置文件导入、其他目的地、快捷指令运行、自动上传和复杂对象完整导出仍需各自实现与验收；尚未宣称配置或执行全部对等。
