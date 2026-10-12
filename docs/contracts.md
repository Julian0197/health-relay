# 配置与上传契约（提案 v1）

这是 HealthRelay 自己的协议。例子均为合成数据，当前尚无运行时解析器；不宣称兼容 HEA 配置导入。

## AutomationConfig

完整例子见 `examples/task.raw.json`、`examples/task.daily.json`。

| 字段 | 含义 |
| --- | --- |
| schemaVersion | 配置协议版本，当前 1 |
| id / revision | 任务 UUID / 正整数版本 |
| name / enabled | 名称 / 启停，导入默认禁用 |
| data.family | quantity、category、correlation、workout 等，按能力开放 |
| data.selections | HealthKit 标识符数组；没有固定业务流 |
| selections[].unit | 数量输出单位，校验量纲 |
| selections[].sources | 每项来源包含集合，空集合为全部未排除来源 |
| data.excludedSources | 任务全局排除集合 |
| range | 增量或日历日期策略 |
| export | 格式、明细/汇总、粒度、统计、时区 |
| destination | URL、普通 headers、认证引用、超时、确认模式 |
| execution | 触发、最小间隔、批次上限 |

来源使用稳定来源标识；可修改的设备显示名称不是唯一过滤条件。HKSource/HKDevice 组合标识在目录实现阶段固定并测试，不能只看名称猜来源。

日期模式：incremental 有 bootstrapDays，固定首次下界后走 anchor；today/yesterday/pastDays 按 IANA 时区日历取范围，pastDays 有正整数 days；custom 有带偏移 start/end，采用 `[start,end)`。

固定日历模式允许重新读取已知窗口并比较摘要；它不具有增量游标的“无需重读”保证。

raw 必须 grouping=none、statistics=[]。aggregate 使用 minutes/hours/days，合法统计由目录校验。首版格式 healthrelay.v1；CSV、HEA v2 是后续编码器，不能仅声明字段就作为支持。

credentialRef 指向本机 Keychain；导出脱敏。示例 bind-on-device 是待绑定引用，不能作为 Token 发送。导入普通 header 中的认证值需要转入 Keychain。App 同时校验版本、ID、家族、单位、统计、窗口、批次/超时范围、availability、URL 和保留 header 冲突。

## Native batch

见 `examples/batch.json`。包含 schemaVersion=1、batchId、taskId、configRevision、createdAt、records。HTTP POST，Content-Type 为 application/json，Idempotency-Key 等于 batchId。

| op | 身份与载荷 | 接收语义 |
| --- | --- | --- |
| upsert | typeIdentifier、样本 UUID recordId、起止时间、来源、payload | 按认证用户、类型和 UUID 去重 |
| delete | typeIdentifier、recordId | 删除或软删除，可重复执行 |
| snapshot | 稳定窗口 recordId、窗口边界、统计方法、来源范围、revision | 替换快照，旧版本不能覆盖新版本 |

不能只用日期+指标名作为明细主键覆盖多来源样本。接收端认证决定用户归属，不信任客户端声明的用户 ID。

快照键包含类型、来源范围、单位、统计、粒度、时区、边界和同步世代；revision 在世代内单调递增。重装/检查点重建建立新世代并显式接入基线，不能用从 1 重启的版本覆盖原世代。

复杂子数据在对应读取器阶段另定义父对象/子块/manifest 完整性协议；首个格式不隐式接受半条复杂记录。

## Confirmation

receipt 模式见 `examples/receipt.json`：200/201、正确 batchId、committed=true，accepted+duplicates 等于 records 数量，包含 delete/snapshot 事件。响应表示全批次事务提交，不能部分成功后完成本地批次。

相同 ID 与相同 body 摘要返回保存的确认；不同 body 返回 409。确认、去重表与记录同事务提交。

http2xx 模式接受成功状态与空响应，包括 204，但首版排除 202；仅表示接口接受，不能证明数据库提交。

## 状态与日志

idle、querying、persisting、encoding、queued、uploading、waitingForUnlock、waitingForNetwork、waitingForCredentials、failed、succeeded。

持久化 query fingerprint、每类型 anchor、dirty windows、pending batch 和 acknowledged batch。默认日志只含阶段、耗时、范围、计数、HTTP 状态和错误码，不打印样本、凭据和完整请求体。

“没有记录”“缓存成功”“收到 HTTP 成功”“确认提交”分别展示。
