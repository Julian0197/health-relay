# 使用 iPhone Use 调试 HealthRelay

调试顺序是：先用合成数据验证编码与服务，再在 iPhone 上验证配置、权限和真实上传，最后观察后台执行。iPhone Use（PUA，Phone Use Agent）通过 MCP、本机服务和 WebDriverAgent / XCTest 操作真实 iPhone；它不是 App 自动化运行的依赖。

## 构建与本地检查

要求匹配设备系统的 Xcode、Swift 6、USB 连接、开发者模式及自己的签名 Team。不要提交 Team ID、设备 UDID、证书或 provisioning profile。

```sh
swift test --package-path packages/HealthRelayCore
node --test tests/cloudflare/worker.test.mjs
xcodebuild -project ios/HealthRelay.xcodeproj -scheme HealthRelay \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project ios/HealthRelay.xcodeproj -scheme HealthRelayWatch \
  -destination 'generic/platform=watchOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

组合构建通过 `-destination` 选择平台，不用全局 `-sdk iphonesimulator` 覆盖 Watch 依赖。真机安装用 Xcode，原生测试选具体模拟器。HTTPS UI 夹具见[执行验收](implementation-execution.md)，Cloudflare 服务验收见[服务迁移](service-migration.md)。

## PUA setup → READY

以下工具名称以已安装的 iPhone Use 插件为准，宿主可能显示命名空间前缀。

1. 在支持 MCP 的 AI 宿主安装并启用 iPhone Use 插件。连接手机并完成信任和开发者准备。
2. 本会话首次使用先调用 `pua_setup(action="status")`。已有健康服务和成功构建优先复用；缺服务才启动。首次配置按实际缺项执行 `pua_doctor`、`discover → fetch → configure → build → start`。
3. `fetch/build/start` 可返回后台 job。用 `pua_setup(action="status", job_id=...)` 查询同一个工作；`start` 是长期服务，出现 `service.ready=true` 后即可进入下一步，不等它结束，也不重复 start。
4. 调用 `pua_ready(recover=true, screenshot=false)`，取得当前会话 `ready=true` 后才操作。Runner 图标、端口可达或构建成功都不能代替 READY。
5. 用 `pua_launch_app` 打开 `org.healthrelay.app`，根据控件树或截图使用 `pua_tap`、`pua_type_text`、`pua_swipe`。已知短路径可合并，未知页面先观察；最终关键结果明确回读。

同一会话通道正常时不必每步重新 setup。出现通道故障先恢复 READY，不靠猜坐标或重复提交解决。密码、验证码、Face ID、手机解锁由使用者接管；按插件认证流程暂停预览与操作，接管完成后重新观察页面。

## 一个可复核的 iPhone 验收流程

使用自己的隔离测试端点，先导入[心率或 HRV 示例](../examples/watch-monitor/)，配置本机认证和允许的来源。

| 操作 | 需要核对的证据 |
| --- | --- |
| 保存、关闭、重开 App | 任务配置、执行设备、启用状态正确恢复；导出文件无认证值 |
| 授权、检查读取 | 目标类型、来源、日期和单位；“无数据”不自动等于授权失败 |
| 手动运行 | App 运行来源和时间、服务端流/粒度、数据时间及新增/修订统计 |
| 相同请求重试 | 同一待上传批次或相同正文；服务端 unchanged 增加，事实不重复 |
| 可控失败后恢复 | pending 保留、退避、重试结果和确认；测试故障仅注入隔离接收器 |
| 独立历史补传 | 日期边界、完成/继续/取消；不覆盖日常任务的游标 |
| 启用后离开前台 | 自然触发证据与前台运行分开记录 |

App 原生 receipt 测试核对 batch ID、提交标志及计数；迁入 HAE 服务使用 HTTP 成功模式，核对 `stored:true`、`stats` 和 `/status`。飞书群、签名、看板再分别核对发布结果。200、Base 写入或本机测试通过不能代替手机与下游最终展示验收。

## 后台与 Watch

后台观察先让 App 离开前台，依赖测试端元数据和系统日志判断来源。反复打开 App 会触发前台补跑，不能据此声称自然 HealthKit / BGTask 唤醒成功。DEBUG 参数 `--diagnose-background` 配合 `scripts/check_background_startup.py` 仅验证 Observer 启动注册顺序。

iPhone Use 不直接控制 Watch。Watch 分别使用 Xcode、watchOS 模拟器和配对真机验证：配置接收、本机认证/授权、直接上传、断网恢复、锁定/解锁、延迟回执及设备切换。Watch 模拟器的后台 URLSession 成功不证明真实佩戴状态下的自然唤醒或耗电。

调试截图、HealthKit 导出、日志和测试密钥放入忽略目录 `private-artifacts/` 或 `private-data/`。公开截图只用合成数据；不要将真实健康界面打码后就默认视为安全，应逐项检查可识别信息。
