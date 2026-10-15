# 用 AI 生成自动化配置

iPhone 是配置入口；AI 生成可审查的 JSON，App 校验并预览后再保存。配置任务指定 `device: "iPhone"` 或 `device: "watch"`，Watch 复用同一份字段契约，通过现有 WatchConnectivity 同步。这里没有内置模型服务，也不会把配置或健康数据自动发送给 AI。

## 获取契约与示例

在仓库根目录运行：

```sh
swift run --package-path packages/HealthRelayCore healthrelay-config reference > ai-reference.json
swift run --package-path packages/HealthRelayCore healthrelay-config schema > automation.schema.json
swift run --package-path packages/HealthRelayCore healthrelay-config catalog --device watch > watch-catalog.json
swift run --package-path packages/HealthRelayCore healthrelay-config template --device watch > watch-task.json
```

`reference` 将同一份 JSON Schema、指标目录、示例和约束打包，适合交给 AI。指标 ID、单位及系统版本来自 App 使用的目录，不要让模型猜测名称。示例只包含合成地址，不包含用户配置或认证。

可以给 AI 这样的要求：

> 按附件的 schema 和 catalog 生成 HealthRelay 配置。选择 Watch 执行，读取心率，按自然分钟汇总平均、最小和最大值，使用 HEA v2 JSON，上报到我指定的 HTTPS 接口；期望最小间隔 30 分钟。认证只声明 Header 名称，不填写 Token。只输出 JSON；不要启用任务，不要创造目录外的指标、字段或枚举。

## 本地校验与导入

```sh
swift run --package-path packages/HealthRelayCore healthrelay-config validate watch-task.json
swift run --package-path packages/HealthRelayCore healthrelay-config validate watch-task.json --os-major 27
```

输出是 JSON 报告：`valid`、脱敏后的 `tasks` 和 `issues`。问题包含 `severity`、`code`、`path`、`message`；结构错误的 `path` 是 JSON Pointer，可用于让 AI 精确修正字段。语义检查复用 App 的校验器，错误位置可能指向整个任务。`--os-major` 默认 27，用于校验所选执行设备的系统版本；`catalog` 也支持这个参数。命令不读取 HealthKit 或 Keychain，也不执行上传。

退出码 0 表示配置检查通过，2 表示配置或命令参数错误。通过检查仅说明配置结构与已实现能力相容，不代表设备权限、认证、网络、实际数据或上报已验收。

支持原有单任务 JSON，也支持多任务配置包：

```json
{
  "schemaVersion": 1,
  "kind": "healthrelay.automations",
  "tasks": []
}
```

上面的空数组只说明外层形状，实际导入必须含 1–100 个完整任务，整个文件最多 1 MiB。导出全部配置也遵守这两个上限，超限会提示错误；任务较多时可改为单独导出。未知字段会报错，不会静默忽略。聊天复制的单个完整 JSON 代码块也可检查。

在 iPhone 使用「粘贴 JSON」或「从 JSON 导入」，先查看任务、执行设备、指标、间隔、接口和问题，再选择导入。批量导入一次性创建新任务：新 ID、revision 1、默认关闭，不覆盖现有任务。认证值和设备本地引用不会通过配置导入；按预览说明在执行设备重新填写。单个可解析任务也可以进入编辑器修正；相同 ID 的现有任务须明确选择检查更新，仍受待上传批次与 Watch 归属检查约束。

## 复用到 Watch

手机列表的任务操作可创建 Watch 副本，保留数据、导出和上报规则，分配新任务 ID，并保持关闭。也可使用命令：

```sh
swift run --package-path packages/HealthRelayCore healthrelay-config watch phone-task.json > watch-tasks.json
swift run --package-path packages/HealthRelayCore healthrelay-config validate watch-tasks.json
```

转换会检查 Watch 的指标可用性及配置快照限制。`watch --os-major N` 中的版本表示目标 watchOS，而非源任务的 iOS 版本。副本独立于原任务；切换执行设备时检查两端的启用状态，避免重复上报。副本保存到 iPhone 后，点击「同步 Watch 配置（不含认证）」；等待 Watch 收到并保存，在 Watch 填写本机认证、授权并启用，再先验证一次手动上报。

Watch 仅能读取其本地可用的健康数据。最小间隔不是精确定时，后台执行仍由 watchOS 调度；配置检查和模拟器测试不能证明配对真机的自然后台连续性。

## 凭据与版本

导出配置与批量备份都保留认证 Header 要求并移除认证值和本地引用。显式声明的认证 Header 按大小写不敏感匹配，即使名称是 `X-Custom` 也会移除对应值；重复的认证要求会归一化。原始接口 URL 和普通 Header 仍属于配置内容，分享给 AI 前应检查其中是否放入了业务敏感信息。凭据应使用认证字段，不要塞进 URL 或普通 Header。

配置包版本与任务 `schemaVersion` 均为 1；`revision` 表示单个任务的本地编辑版本。当前流程是手动导入导出，不包含 iCloud 自动备份、自动上传配置到 AI、远程控制手机或自动启用任务。

## 验证边界

2026-10-15 从主分支提取本次 PR 独立变更后的验证记录：

- Core：136 项 XCTest（其中 2 项可选网络测试跳过）和 37 项 Swift Testing 无失败；另外 31 个实际 CLI 场景通过。现有活动、心率、HRV、睡眠、锻炼五份示例均能转换为校验通过且关闭的 Watch 副本。
- iOS 原生：47 项测试通过，其中 6 项导入专项测试覆盖新 ID、停用状态、保留原任务、整批失败、写入失败及文件保护。
- iOS 界面：4 条定向测试通过，覆盖粘贴检查、导入后重启恢复、独立 Watch 副本、未知字段路径与禁止保存、修改 JSON 后重新检查、语义错误进入编辑器。使用独立模拟器、隔离测试存储和合成接口；实现阶段的同一界面截图已人工检查。
- iPhone 与 Watch 模拟器构建均通过。

这些结果不代表健康数据权限、真实认证、服务器入库或后台连续性已验收。本轮没有安装手机或手表真机，也没有替换设备上的原有配置；Watch 真机配对、安装与自然后台上报由独立验收记录跟踪。
