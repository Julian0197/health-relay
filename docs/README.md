# 文档目录

## 使用与开发入口

| 文档 | 内容 |
| --- | --- |
| [架构与边界](architecture.md) | iPhone / Watch、同步确认、Cloudflare、飞书和 HTML 数据流 |
| [自动化配置迁移](automation-profile.md) | 原五流规则、五份可导入配置、HAE 对照与切换条件 |
| [服务部署与飞书接入](services.md) | Cloudflare Secrets、群机器人、Base 签名和展示副本 |
| [算法与发布规则](signature-algorithm.md) | 压力、睡眠、文案选择与 webhook HMAC |
| [iPhone Use 调试](debugging-iphone-use.md) | PUA setup / READY、UI 测试和后台证据 |
| [迁移来源与验收](service-migration.md) | 本次代码迁移范围、验证和未迁移部分 |
| [HTML 看板](../integrations/hae-webhook/dashboard-app/README.md) | 本地合成预览、构建、授权 HTML 发布 |
| [能力表](capabilities.md) | 类型、格式和验证边界 |
| [配置与上传协议](contracts.md) | AutomationConfig、批次与回执 |
| [设计](design.md) | 原始设计及分阶段实现 |
| [可选 Docker 自部署](self-hosting.md) | 通用接收端方案，不是迁入 Worker 的部署方式 |

## 实现与验收记录

- [配置界面](implementation-configuration.md)
- [导出执行](implementation-execution.md)
- [锻炼与 HAE 扩展](implementation-hea.md)
- [自动化核心](implementation-automation-core.md)
- [定时、快捷指令与提醒](implementation-scheduling.md)
- [后台生命周期与恢复](implementation-background.md)
- [Watch companion](implementation-watch.md)
- [HAE 实现前差距盘点](hea-automation-gap-audit-2026-10-12.md)：历史基线，当前能力以能力表及代码为准。
- [公开研究依据](research.md)
- [SDK 标识符清单](../catalog/sdk-27-inventory.json)：目录覆盖不等于全部类型已实现或已验收。

## 样例与验证

- [五流配置说明](../examples/watch-monitor/profile.json)及[五份 HealthRelay 配置](../examples/watch-monitor/)
- [原生明细](../examples/task.raw.json)、[日汇总](../examples/task.daily.json)、[混合汇总](../examples/task.mixed-aggregate.json)
- [原生上传批次](../examples/batch.json)与[提交回执](../examples/receipt.json)
- [Cloudflare 合成验收接收器](../tests/cloudflare/)
- [Swift → Worker 契约测试](../integrations/hae-webhook/healthrelay-contract.mjs)

历史实现记录保留当时的验收范围，不把构建、模拟器、合成网络测试等同于真实设备的连续后台运行。
