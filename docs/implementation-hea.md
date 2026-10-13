# HEA 格式与完整运动导出验收

本轮目标：iPhone 管理自动化配置；Watch 在可读取本机 HealthKit 且获系统执行机会时直接上传，减少等待手机解锁和数据同步。Watch 不是无限后台服务：锁定、权限、资源预算及网络仍影响执行。

## 规格与证据

优先依据 HEA 官方导出文档，而非将 HealthKit 标识符机械转为 snake_case。官方 JSON 根结构按数据族分别包含 `metrics`、`workouts`、`symptoms`、`cycleTracking`、`ecg`、`heartRateNotifications`、`stateOfMind`、`medications`。公开文档、合成契约测试、真实 HEA 文件对比、HealthKit 真机读取与自然上传是不同证据，逐项记录。

- [JSON 格式总览](https://help.healthyapps.dev/en/health-auto-export/export-format/)
- [健康指标](https://help.healthyapps.dev/en/health-auto-export/export-format/health-metrics/)
- [运动 v1/v2、路线与关联指标](https://help.healthyapps.dev/en/health-auto-export/export-format/workouts/)
- [症状](https://help.healthyapps.dev/en/health-auto-export/export-format/symptoms/)、[周期记录](https://help.healthyapps.dev/en/health-auto-export/export-format/cycle-tracking/)
- [ECG](https://help.healthyapps.dev/en/health-auto-export/export-format/ecg/)、[心率通知](https://help.healthyapps.dev/en/health-auto-export/export-format/heart-rate-notifications/)
- [情绪记录](https://help.healthyapps.dev/en/health-auto-export/export-format/state-of-mind/)、[用药](https://help.healthyapps.dev/en/health-auto-export/export-format/medications/)
- [手动导出](https://help.healthyapps.dev/en/health-auto-export/manual-export/)、[REST 自动化与大批次](https://help.healthyapps.dev/en/health-auto-export/automations/rest-api/)

## 必须保持的读取与确认边界

运动详情在返回读取页前补全；路线/关联查询失败或取消不能推进 anchor。关联指标按 HealthKit 的 workout association 查询，不能把时间重叠的无关记录误配为运动数据。原生格式保留样本 ID、来源、路线分段和元数据；HEA 格式按其公开字段转换，属于有意的有损兼容层。

读取授权只请求已选择的数据及其必要的关联类型。空结果可能表示无数据、未授权或未同步，不能宣称数据库为空。ECG、情绪、用药等依赖系统版本及公开 API 可用性；不能通过启动假的运动会话规避后台限制。

这里的“完整”指本次读取时 HealthKit 可返回的全部详情。路线或关联样本在父运动已确认后才到达时，当前增量路径依赖 HealthKit 是否重新返回父运动；应用没有独立订阅子数据并重导出父记录，该行为尚未真机验收。需要补齐迟到详情时，可新建覆盖该日期范围的补传任务；直接再次运行原任务仍沿用原 anchor，不能保证补回。后续需验证父 anchor 行为，必要时实现详情变更重查。

单条运动可能包含大量 GPS 与时间序列数据。每批大小是接收端与设备内存边界；超过配置上限必须明确报错并保留进度，不能截断路线或把尚未上传的样本标记成功。

## 真实文件对照方法

1. 记录 HEA 版本、数据类型、日期范围、单位、汇总开关、分组、导出版本与路线/关联指标选项。
2. 在 HEA 手动导出最小必要范围，经用户授权的传输路径保存到本机忽略目录；不提交真实文件。10 月 13 日用户指定发到自己的飞书，已核对四个 CSV 送达，再通过消息附件下载到本机。
3. 对照 JSON 路径、类型、可选字段、日期/单位和 CSV 文件结构、表头、转义及 multipart 文件字段。数值验收须使用同一设备、相同样本范围和来源。
4. 用合成值重建结构固定为回归用例，并记录哪些差异源于隐私/原生协议选择。
5. 同一批次失败重试必须保持正文一致，收到有效回执后才能提交读取游标。

2026-10-13 19:17 已恢复 iPhone 通道。用户提供一份 HEA 原始心率 JSON：仅有 data.metrics，284 个心率汇总点，units=count/min，每点恰含 Avg/Max/Min/date，没有 source。文件版本和生成配置未记录，不能据此推定其他指标或 JSON 版本。回归 fixture 只复刻字段形状，使用合成值，不提交真实健康记录。运动仍待独立文件对照。19:35 在 HEA 10.0.4（稍后从设置页核实）中以 CSV/v2、过去 7 天、指标按天汇总、锻炼按分钟分组且包含路线和指标生成本地文件。20:13–20:19 已在用户自己的飞书核对四个文件送达。下载的健康指标 CSV 为 5,289 字节、UTF-8 无 BOM、LF 换行，含 126 列和 8 个数据行；首列为日期/时间，多个指标按列排列，缺失值留空。心率顺序为最小值/最大值/平均值，单位 bpm，与已提供 JSON 的 count/min 标签不同。运动 CSV 为 384 字节、27 个表头（含末尾空列）、0 条记录；症状 CSV 为 67 字节、7 列、0 条记录；ECG 下载返回零字节 range 错误。它们不足以证明这些数据族的数据行格式。没有把手动文件组织推定为 REST multipart 组织或字段名。20:26 核对运动类型为全选；用户要求先完成本机修正，近 30 天运动捕获留待手机空闲后继续。

## 本轮实现及验证记录

### 原生读取

- 运动保留活动类型、暂停后的 duration、父级/分段统计、事件、metadata 和 legacy totals。路线读取全部分段；关联数量按 HealthKit workout association 查询，并展开内部 quantity series。
- 关联时序按来源与秒/分钟分桶，累积量求和、离散量算术平均/最小/最大。按点开始时间归桶；不声称与 HEA 的未公开权重、跨桶分配或来源合并规则等价。
- ECG 读取全部电压点与毫秒偏移；State of Mind 保留原始 SDK 枚举；iOS/watchOS 26+ 用药保留实际/计划剂量、状态、概念标识和可用注释。
- 心率通知读取与事件区间重叠的心率/SDNN 样本，并展开其内部 series。`associationPolicy=overlap-event-interval-v1` 明示此策略；整个父样本的内部点会保留，不擅自截断到事件边界，也不声称等于 HEA 的内部关联算法。
- 查询、计数完整性或取消失败均发生在返回读取页之前。完整运动/ECG 以一条记录读入；超过上传字节上限明确失败，保持未提交进度，不截断。

读取阶段已通过：Core 97 项、2 项外网测试跳过；iPhone 31 项、Watch 40 项原生测试，包括 15 个运动与 16 个专用读取合成用例。两阶段审查通过。ECG/用药对象部分无法通过公开构造器生成，测试覆盖值转换与注入的查询结果，未验证真机授权弹窗或真实数据库。

HEA JSON 已实现 106 项官方数量清单的显式映射、RMSSD 扩展、血压/睡眠/正念/性行为，以及运动、症状、周期、ECG、心率通知和情绪数据族。运动按 v1/v2 分别编码路线和心率字段；其余家族沿用公开文档形状，缺少独立 v1 原始文件证据。HEA 用药、站立小时、洗手与刷牙仍禁止执行，提示使用原生 JSON。CSV 仅开放可汇总健康指标，并拒绝非指标或混合数据族，避免静默丢失。

编码阶段已通过 Core 127 项、2 项外网测试跳过；iPhone 41 项原生测试及 1 项 HEA 版本/数据族保存重启 UI 测试通过；Watch 42 项原生测试通过。真实 SDK 对象经生产读取页进入编码器的测试发现并修复了运动位置枚举差异。规格与质量审查通过。这些是模拟器与合成测试，不能替代实际 HealthKit 数据库或自然后台上传验收。随后根据用户文件修正普通心率为 count/min，并仅移除汇总心率的 source；原始心率和运动心率行为独立保留。修正的完整 Core 回归为 132 项通过、2 项外网跳过，定向 40 项通过，规格与质量复核通过。原始文件版本未知，因此双版本复用该指标形状是当前实现约定，不能宣称两版均有原文件证明。接收器 11 项通过。

## 指标名称的来源冲突

[官方接收器枚举](https://github.com/HealthyApps/health-auto-export-server/blob/4163bb5e8aa8d2cdac2a9971c164c0fa46604866/server/src/models/MetricName.ts)最后一次文件修改为 2025-02-27；健康指标导出文档更新于 2026-08-23。TCP/MCP 查询中的过滤参数不等于导出名称，例如 `body_mass` / `walk_run_distance` / `water` 不能直接当作 JSON `name`。

| 指标 | 已发现证据 | 对照要求 |
| --- | --- | --- |
| 体重 | 新版导出文档 `weight_&_body_mass`；旧接收器 `weight_body_mass` | 优先新版明确示例，旧接收器需注意差异 |
| VO2 Max | 旧接收器 `vo2max`；查询参数与现有实现 `vo2_max` | 必须真实导出确认，不能用查询参数证明导出格式 |
| 单不饱和脂肪 | 旧接收器 `monosaturated_fat`，界面标签 Monounsaturated Fat | 不擅自修正旧名称拼写；真实导出确认 |
| 跌倒次数 | 旧接收器 `number_of_time_fallen`，界面标签 Number of Times Fallen | 不机械复数化；真实导出确认 |
| 磷 | 支持清单包含 Phosphorus，旧枚举未列出 | `phosphorus` 只能算按公开命名规则推导 |
| RMSSD | HealthKit 新类型已可读取，官方 HEA 清单没有明确名称 | 现有 `heart_rate_variability_rmssd` 是 HealthRelay 扩展，不算 HEA 已验证映射 |

用药还存在语义边界：公开 SDK 的剂量事件提供事件起止时间和药物单位数量；HEA 文档对起止时间的描述及药片剂量示例不足以证明它导出的是疗程时间或有效成分质量。实现不得把片数猜成 mg，也不得把没有公开字段的停药日期补成事实。


## 需要真实导出解决的差异

| 数据 | 公开资料能确定的部分 | 仍需对照的部分 |
| --- | --- | --- |
| 数量指标 | 106 项支持清单、绝大多数接收器名称、样本与汇总字段 | 上述名称冲突、各百分比的数值尺度、单位偏好与精度 |
| 分类指标 | 症状/周期的结构及 HealthKit 枚举 | 刷牙/洗手的 Complete 与 Incomplete 不能从唯一的 NotApplicable 枚举推出；站立小时计数规则 |
| 运动 | v1/v2 的不同键名、GPS 字段、心率曲线结构 | 活动名称本地化、偏好单位、速度/步频/恢复心率的派生规则 |
| ECG | 波形查询、电压 V、毫秒时间戳与多数分类 | 缺失平均心率/采样频率、NotSet 分类和 severity；不能编造 0 或默认采样频率 |
| 心率通知 | threshold、heartRate、heartRateVariation 结构 | 与通知关联样本的精确查询窗口或关联规则 |
| 情绪 | ISO8601 起止时间、kind、labels、associations、valence 与 SDK classification | 非字符串 metadata 转换及未知枚举行为 |
| 用药 | 名称、形式、状态、药物概念与剂量事件 | 疗程/事件起止时间、剂量单位、没有剂量事件的药物条目 |
| CSV | HEA 10.0.4 健康指标原文件确认中文 126 列、LF、空单元格、时间列及心率 Min/Max/Avg 顺序；运动/症状只有表头 | REST part name、跨指标整包、空日期补齐、其他语言/单位偏好、运动/关联指标/GPX 数据行仍待验证 |

本轮的离线 receiver 是测试接收器，只验证明确记录的导出约定；它接受数据不能反向证明原始 HEA 也产生同样的正文。修改测试接收器源码不会自动更新已部署服务。

最终集成审查通过，未发现新的已证实代码缺陷；运动迟到子数据的增量重查作为明确未验收边界保留。模拟器组合构建及双平台 Release 真机目标编译通过；Release 未签名、未安装。

## CSV 实机样本修正

本次修正采用明确的 HEA 10.0.4 中文手动导出 profile：106 项数量指标及睡眠阶段按已捕获的列名、顺序和单位编码，全部选择时共 116 列（日期 1、数量 108、睡眠 7）；原文件其余 10 列涉及未开放的站立小时、刷牙、洗手、正念、性行为、血压和恢复 HRV。每个批次一张宽表；为所选但本批无记录的指标保留空列。日期转换为导出时区的 `yyyy-MM-dd HH:mm:ss`，睡眠日期对应当地零点。真实样本只保存在忽略目录，回归 fixture 使用合成值。实机文件中血氧、步行不对称和双支撑百分比存在大于 1 的数值，支持这些 CSV 列使用显示百分比；不能据此推定所有 JSON 百分比。小数位数随指标变化，睡眠可能保留长小数，不增加未经验证的统一舍入。

心率输出已选择的最小/最大/平均统计；其他数量指标只有一个值列，必须选择一种统计。多来源或同一指标同一时间出现重复值时明确拒绝，不能未经权重规则合并或覆盖。RMSSD 与“恢复 HRV”的对应关系未证实，CSV 暂不开放。

此修正仅覆盖文件内容：上传暂沿用本项目的 multipart `file` 约定，文件名 `HealthAutoExport.csv`。当前 SyncEngine 仍按指标分页，每次请求可以有其他指标的空列，但不会把多个指标的查询合成一个完整日期表；缺少全部数据的日期不额外填空行。语言/单位固定为这次实机样本，其他偏好和真实 REST 接收端仍待验证，界面继续标记为实验性。

CSV 修正回归：Core 153 项通过、2 项可选外网测试跳过；接收器 15 项通过。106 项数量指标覆盖 251 种目录单位输入。旧版待上传 CSV 先核验配置、目的地和指纹，原样重试并确认游标，再对新读取执行新版能力限制，避免升级后旧批次无法重试。iPhone 与 Watch 的实际运行入口使用同一校验；有效待发送批次无需重新请求健康读取授权。停用的 Watch 任务只允许手动重试现有批次，收到回执后不继续读取新数据。测试接收器保留旧格式解析，并将宽表的心率/睡眠多列分别计作一条原生记录；空列不会清除已接收的其他指标。本轮只修改本机 fixture，未部署接收器。iPhone + Watch 组合模拟器构建、Release 真机目标编译均通过；未签名、未安装。

与服务迁移主分支整合后的回归为 Core 154 项通过、2 项可选外网测试跳过（包含新增的五流服务配置契约测试），接收器 15 项通过，229 个公开文件检查通过。保留主分支新版 README 与服务目录；CSV 修正没有部署服务或安装到真机。
