# 公开依据与调研边界

核对日期：2026-10-12。

实机梳理了任务配置、来源包含/排除、单位、明细/汇总、日期范围、多个目的地、MCP 设置与手动导出。实际文件验证说明单指标 CSV 入口可保留带秒级时间的明细，不能推广为所有入口相同。

本机 iOS 27 SDK 中 RMSSD 是公开数量类型，最低 iOS/watchOS 27；它只是目录扩展例子，不是本产品范围。HEA 官方清单有指标、锻炼、症状、周期、用药、心情、心电图和心率通知，但没有证明等同于全部 HealthKit 公开类型。

尚未获取 iOS 二进制或源码，未验证 HEA 内部调度、来源重叠、原子提交和重试算法；MCP 实际连接、第三方授权/投递、HEA 配置导入兼容也未完成验收。因此是公开功能研究和独立实现，不能宣称所有内部实现已经逆向完成。

公开参考：

- [HEA 数据清单](https://help.healthyapps.dev/en/health-auto-export/getting-started/supported-data/)
- [HEA REST 自动化](https://help.healthyapps.dev/en/health-auto-export/automations/rest-api/)
- [HEA 手动导出](https://help.healthyapps.dev/en/health-auto-export/manual-export/)
- [HEA 官方 MCP 桥接](https://github.com/HealthyApps/health-auto-export-mcp-server)
- [HealthKit 类型](https://developer.apple.com/documentation/healthkit/data-types)
- [增量查询](https://developer.apple.com/documentation/healthkit/hkanchoredobjectquery)
- [Observer 与真机测试](https://developer.apple.com/documentation/healthkit/hkobserverquery)
- [后台执行时间](https://developer.apple.com/documentation/backgroundtasks/bgtaskrequest/earliestbegindate)
- [权限与锁屏读取](https://developer.apple.com/documentation/healthkit/protecting-user-privacy)

个人导出、设备截图、私有报告、生产端点、凭据和日志不纳入开源仓库。
