# Apple Watch 健康签名同步

Watch App 复用现有 Mac 原生接收服务、SQLite、健康状态算法、Base 与妙笔签名。无需新建表或更换个人签名链接。

## 日常同步与运动同步

- 日常：读取手表已授权且本机可用的健康记录。指标预设读取恢复 HRV（RMSSD）、心率、睡眠与活动数据；两个预设任务首次读取近 30 天，之后增量，最小期望间隔 5 分钟。HealthKit 通知、打开 App 与系统后台刷新提供执行机会；watchOS 不保证每 5 分钟唤醒。
- 原生心率：复合样本上传真实测量明细，按实际分钟计覆盖；不会把长区间均值展开成虚构采样。升级后先确认待传原批次，再自动补读心率明细，其他指标沿用原检查点。
- 运动：用户在「运动与每分钟同步」明确开始一次真实运动。使用 HKWorkoutSession 和 HKLiveWorkoutBuilder，运动中每 60 秒尝试交付一份实际心率及累计运动时长摘要。支持力量训练、室内步行、室内跑步、室内骑行；暂停不计入实际运动时长。
- 正常佩戴、已解锁时，放下手腕不等于结束运动会话。持续传感器采样及后台执行由系统控制，网络上传和签名刷新仍可能延后。离腕锁定、重启、关机或强制退出均可能中断；不能承诺全天每分钟同步。
- 结束会保存一次真实运动到 Apple 健康。App 的“已到达服务”表示 Mac 已返回提交回执；签名还要经过服务合并发布和客户端缓存。

参考：[Apple 运动会话](https://developer.apple.com/documentation/healthkit/running-workout-sessions)、[HealthKit 后台交付](https://developer.apple.com/documentation/healthkit/hkhealthstore/enablebackgrounddelivery(for:frequency:withcompletion:))。

## 配置与安装

1. 在 Xcode 选择 HealthRelayWatch scheme，确认签名 Team、唯一 Watch bundle ID 及配对 iPhone 的 companion bundle ID。Apple Watch App 需要 watchOS 11 或更新版本；当前健康签名预设的恢复 HRV（RMSSD）要求 watchOS 27 或以上，并且实际存在已授权样本。
2. 在 Xcode 的 Device Hub 开始设备配对；iPhone 与 Watch 都启用开发者模式，并确认信任。入口可能要开始配对才出现。说明见 [Apple Device Hub](https://developer.apple.com/documentation/xcode/managing-your-simulated-and-physical-devices-in-device-hub)。
3. 安装包含 Watch 内容的 iPhone App；需要时在 iPhone 的 Watch App → 可用 App 中安装 HealthRelay。也可在 Xcode 直接部署到已配对手表。
4. 使用公共受信任 HTTPS 可直接配置服务。自签本地 HTTPS 要在 Watch App 数据容器的 `Library/Application Support/HealthRelayWatch/trusted-server.cer` 显式提供 CA 的 DER 公钥证书；不得提供 CA 私钥或服务私钥。证书校验仍检查证书链、有效期与所请求主机名/IP。缺少此文件时使用系统默认信任。新系统对 IP 地址另有 ATS 检查；本地自签 CA 还需在私密开发构建的 Info.plist 中为准确的 Mac IP 配置 `NSExceptionDomains`，最低 TLS 1.2、保持前向保密，并允许该主机的自定义根验证。个人 IP 不写入仓库；不设置全局 `NSAllowsArbitraryLoads`。公开受信任 HTTPS 无需此例外。
5. 在手表「配置健康签名同步」输入最终 `/ingest` HTTPS 地址和服务认证值，创建两个独立任务；分别授权并启用。认证保存在 Watch Keychain，任务 JSON 仅存引用。
6. 日常同步可以单独执行“运行一次”。要每分钟尝试同步，请准备真实运动后进入运动页面点击“开始运动”，结束后点击“结束并保存”。

Watch 必须能访问 Mac 的实际地址。Mac 睡眠、服务停止、局域网隔离、VPN 路由差异、证书过期都可能阻断连接。同一 Wi-Fi 名称本身不证明网络可达。

## 上传、存储与重复处理

`WatchWorkoutController.swift` 收集真实观测并交给 `WorkoutRelayOutbox`。持久目录为 Watch App 数据容器内 `Library/Application Support/HealthRelayWorkout`：

- `binding.json`：本次会话使用的端点、任务与 Keychain 引用；没有认证明文。
- `latest.json`：合并后的最新摘要，或结束时的最终替换记录。
- `journal/`：不可变待确认批次、回执、失败和重试时间。
- `uploads/`：后台 URLSession 请求正文与持久化完成结果。请求正文使用首次解锁后可读的文件保护级别，供系统传输进程读取；确认后删除。原始 journal 与完成结果仍使用完整文件保护。

同时最多保留一个待确认批次和一份更新的最新状态。新摘要不会改写未确认正文。旧批次确认后，较新的结束记录仍在；断网与 App 重启后可继续。不可自动重试的错误保留原批次，用户可点“重试待传记录”。有运动或未完成上传时阻止替换认证和接收新配置，以免删除正在使用的 Keychain 引用。

Mac 将临时运动 ID 作为 upsert 更新，最后在同一批次删除临时记录、写入 HealthKit 保存的真实 workout UUID。iPhone 或 Watch 日常增量再次上传同一真实 UUID 时不会新增一份锻炼。运动累计取实际 `durationSeconds`；直播摘要只补充真实心率观测，不生成 HRV、不改写压力阈值。原始心率样本抵达后，同一采样时刻优先采用原始样本。

服务接收器事务、回执、Base 的 title 发布、妙笔 60 秒缓存与固定文档跳转沿用 [本地服务说明](services.md)。签名里的压力文字仍是基于个人历史的趋势估算，运动摘要不会令压力分每分钟产生新判定。

## 验证边界

自动测试验证会话摘要、不可变重试、结束替换、真实心率时间、SQLite 事务与去重、TLS 主机名与 CA 链、预设和钥匙串保存。模拟器不能证明真表传感器采样、实际佩戴熄屏运行或后台网络时机。

真机验收需要：实际 Watch 安装并启动、授权、普通健康记录到达 Mac；用户开始真实运动后，观察至少两次不同观测时间的摘要回执，放下手腕后继续采样，结束保存且无重复时长，并核对 Base 与签名。
