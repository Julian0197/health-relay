# Cloudflare 服务与飞书接入

迁入目录为 [`integrations/hae-webhook/`](../integrations/hae-webhook/)。它是单用户服务，兼容已有 HAE 五流，同时接收本仓库五份 HealthRelay HAE 配置的输出。默认配置使用新 Worker 名称，不携带任何原账号、namespace、群机器人或 Base ID。

## 1. 先在本地验证

Node.js 22.13+（使用无需额外开关的 [node:sqlite](https://nodejs.org/api/sqlite.html)）。跨语言契约测试另外需要 Swift 6 / Xcode 27。

```sh
cd integrations/hae-webhook
npm ci --ignore-scripts
npm test
npm run test:contract
npm run test:runtime
npm run test:refresh
npm run check:deploy
```

`test:runtime` 在本机 workerd / SQLite 中跑五流、Alarm、签名、群卡、展示副本、重启及重复抑制，所有外部 HTTP 被截获。它不会向真实飞书发送消息。`check:deploy` 仅打包，不部署。

本地手动调试可复制 `.dev.vars.example` 为 `.dev.vars`，填写自己的测试环境参数后 `npm run dev`。`.dev.vars` 默认忽略。**手动 dev 的外部请求不被测试拦截器接管**；绑定真实 webhook 后，上传可能触发真实群卡，调试应使用专门的测试群和测试 Base。

## 2. 创建自己的 Cloudflare 服务

先确认 `wrangler.jsonc` 的 `name` 是目标新服务名，`HEALTH_STORE → HealthStore` 使用 SQLite DO，迁移 tag 为 `v1`。配置没有 `account_id`；通过自己的 Wrangler 登录选择账号。

以下命令会修改自己的云端环境，仅在准备部署时执行：

```sh
npx --no-install wrangler login
npx --no-install wrangler deploy
npx --no-install wrangler secret put HAE_API_KEY
npx --no-install wrangler secret put ANALYSIS_API_KEY
npx --no-install wrangler secret put FEISHU_WEBHOOK_URL
npx --no-install wrangler secret put FEISHU_SIGN_SECRET
```

用交互输入提交值，不把密钥放进命令行或 `vars`。上传 key 与只读 key 各自随机生成且不同。`secret put` 会产生部署版本。相关机制见 [Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。

当前接收器要求上传 key、合法的飞书 webhook、机器人签名 secret 和 DO binding 齐备；缺项返回 503。`/healthz` 只证明进程可响应，不证明配置可用。

可选 gateway 见 `wrangler.gateway.jsonc`：把 `services[].service` 改成后端名字，再 `npx --no-install wrangler deploy --config wrangler.gateway.jsonc`。gateway 和后端访问同一份存储，不是测试/生产隔离。需要隔离时部署另一套后端和 DO namespace。

迁移到已有生产服务时，不要随意更名 Worker、DO 类、namespace 或 `personal` 对象；本仓库不搬运旧云端健康数据。参考 [DO 迁移规则](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)。

## 3. 绑定飞书群 webhook

在目标群中添加自定义机器人，在机器人安全设置中启用签名校验。将该机器人的 webhook 与签名 secret 分别存入上面的两个 Secret。**创建机器人的那个群就是消息接收群**，不需要在任务里填写 chat ID，也不能用 webhook 来接收 HealthKit 请求。步骤及校验算法见[飞书自定义机器人文档](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)。

`delivery.mjs` 发送 `interactive` 卡片，附 Unix 秒级 `timestamp` 和 Base64 HMAC-SHA256 `sign`；必须同时检查 HTTP 状态与飞书业务 code。错误只保留阶段/状态码，不记录 webhook、secret 或完整健康消息。

群卡按可见内容指纹去重、合并并重试。首次验证先上传合成数据，查看 `/status` 投递结果，然后在目标测试群确认卡片内容和数量。仅调用 `GET /card` 不会发送消息。

## 4. 启用个人动态签名

算法与文案始终可在本地测试；外发签名默认关闭（`SIGNATURE_ENABLED=false`）。启用发布需要自己的飞书应用、具备相应权限且可编辑的 Base、已存在的记录，以及妙笔读取该记录的展示配置。

为这些名称配置 Cloudflare Secrets：

| 名称 | 用途 |
| --- | --- |
| `FEISHU_APP_ID`、`FEISHU_APP_SECRET` | 获取 tenant token，服务端调用飞书 API |
| `SIGNATURE_BASE_TOKEN`、`SIGNATURE_TABLE_ID`、`SIGNATURE_RECORD_ID` | 唯一目标记录，需有文本字段 `title` |

将 `SIGNATURE_ENABLED` 改为 `true` 后重新部署；保留 `SIGNATURE_MODE=health-indices-v1`。Worker 只更新 `{fields:{title}}`，不修改图标、链接、分享权限或其他记录。妙笔模板读取 `title`，展示链接由使用者在飞书个人签名中绑定；不能把 Base 写入成功等同于个人签名已经刷新。

更换设备时可设置 `HEALTH_DEVICE_PROFILE`、`HEALTH_DEVICE_EPOCH_START`、`HEALTH_REPORTED_SOURCE`，三项必须齐备。先按[配置迁移](automation-profile.md)核对真实来源，不复制他人的设备标识或基线日期。

## 5. 生成 HTML 看板

创建**独立展示 Base**，记录字段为文本 `payload_24h`、`payload_7d`、`generated_at`。Worker 应用需要编辑该记录的权限，HTML 的妙笔/Magic 授权只允许读取展示副本。

配置 Secrets `DASHBOARD_CACHE_BASE_TOKEN`、`DASHBOARD_CACHE_TABLE_ID`、`DASHBOARD_CACHE_RECORD_ID`，并复用服务端 `FEISHU_APP_ID/SECRET`。代码为兼容旧部署可回退签名 Base；新部署请显式填写独立展示 Base token，避免扩大私有数据访问。

```sh
# 从仓库根目录
npm --prefix integrations/hae-webhook/dashboard-app ci --ignore-scripts
npm --prefix integrations/hae-webhook/dashboard-app run build
npm --prefix integrations/hae-webhook/dashboard-app run preview
```

`dist/dashboard.html` 是不含私有绑定的单文件。通过 `bake-release.mjs` 在 Git 外或忽略目录注入展示 Base ID、Magic init code 和可选重新打开链接，详细参数见[看板说明](../integrations/hae-webhook/dashboard-app/README.md)。将生成的私有 HTML 导入支持 Magic SDK 的妙笔 HTMLBox；普通静态网页不自带该 SDK。

生成文件带可提取授权能力，不能公开提交。发布后分别验证自己的页面、另一位允许读者及无权限账号，核对 24h/7d、睡眠、运动、过期会话和权限撤销。当前迁移只验证本地合成渲染，不宣称发布后的读者权限已通过。

## 接口与排障

| 路径 | 权限与结果 |
| --- | --- |
| `POST /ingest/{hrv,heart,health,sleep-segments,workouts}` | 上传 key；事务提交的接收统计，发布异步完成 |
| `GET /status`、`/card`、`/analysis`、`/snapshot` | 上传 key 或独立只读 key；私有诊断，不向公开网页提供 |
| `GET /dashboard?range=24h` 或 `7d` | 同上；也支持另行配置的短期 viewer token |
| `POST /signature/refresh` | 上传 key；重算并排队，不制造测量数据 |
| `POST /dashboard-cache/refresh` | 上传 key或只读 key；重新生成展示副本 |

上传请求最大 1 MiB；详细流最多 10,000 条，保留 35 天。`backfill` 模式在接收时不主动安排发布，但既有 live 队列或后续评估可能使用补入事实，不是隔离影子库。

依次检查手机是否有样本、请求是否到达、`dataRange` 是否包含期望时段、`stats` 是否新增/修订、算法是否缺基线，以及各投递状态。接收时间不是测量时间；收到重复数据不代表手表产生了新记录。

`/status` 中的 `dashboardCache.publishedSignature` 是展示副本最近写入时的签名标题，可与 `signature.sentTitle` 对照。数据和签名都未变化的重复上传只更新接收统计。静默补入或保留期清理改变数据之后，下一次 live 上传会完整评估一次，之后的重复上传会复用这次结果。`GET /dashboard` 复用签名所依据的有效判定，判定过期时只做只读重算，不写入压力历史或状态。

本地验证与对照（均使用合成数据、拦截全部外部请求）：

```sh
npm run test:replay      # 压力回放：历史锚点与展示依据
npm run test:read-budget # SQL 读取预算
npm run bench            # 五流接收、Alarm、重复上传、看板读取的耗时 / SQL 行数 / 调用次数
# 与旧版本对照：workerd 只加载启动目录内的模块，因此在旧提交的 worktree 内运行同一脚本
MF="$PWD/node_modules/miniflare/dist/src/index.js"
cp bench-runtime.mjs /tmp/baseline/integrations/hae-webhook/
(cd /tmp/baseline/integrations/hae-webhook && node bench-runtime.mjs "$MF" .)
```

`bench` 会输出每个场景的中位耗时、按类别统计的 SQL 读取行数和各方法调用次数，并统计有多少轮结束时展示副本显示的是当前已生效的签名。其中一轮会故意让一次签名写入失败。

`DASHBOARD_VIEWER_SECRET/OPENIDS/ORIGINS` 属于可选直接读取 Worker 的 viewer-token 接入，本迁移的 Base HTML 路径不需要它们。未配置 CORS 来源时拒绝跨域预检，不使用通配符开放健康接口。

## 群内健康速览卡片

`SIGNATURE_MODE=health-indices-v1` 时，原群 webhook 自动发送原生 Card JSON 2.0「健康速览」。四个指标是最近压力、当日睡眠评分、最新心率和恢复 HRV（RMSSD）；下面是最近锻炼、7 天锻炼消耗图和完整看板入口。旧的同步状态和 physiology 模式仍保留原卡片。

- **评分同源**：复用签名已评估的决策和看板的 `indicesView`，不另算一套压力分。保留结果继续显示原测量时间；当天没有睡眠评分显示 `-`，不拿昨天的睡眠冒充今天。
- **锻炼口径**：最近 7 个北京时间自然日，包含今天；支持所有运动类型，过滤实际时长小于 20 分钟的记录。复用看板的热量单位换算、心率和一分钟恢复计算。最近锻炼选择结束时间最晚的一条，有热量突出 kcal，缺热量突出时长。
- **图表缺测**：每日消耗仅在该日已收到的合格锻炼均有热量、且没有重叠记录时合计；缺失或重叠保留空白并注明原因。没有上传记录不等于零运动；不把日常活动能量当成锻炼消耗。
- **发送节奏**：保留首次变更后 1 分钟合并、后续至少 5 分钟间隔、按可见内容去重、持久化失败重试。仅上传时间变化不新增群消息。原签名与 Base 展示副本的发布间隔不变。
- **可选配置**：`HEALTH_DASHBOARD_URL` 为 HTTPS 看板文档地址；未设置或无效时省略按钮。`HEALTH_DEVICE_LABEL` 为来源标签，如 `S12`；未设置时显示 Apple 健康。个人文档地址放在私有部署配置或 Secret，不提交到公开仓库。
- **权限边界**：卡片把已渲染数据发送至原 webhook 绑定的群，不携带 API key、webhook、Magic 会话或 Base 读写凭证。按钮沿用文档的既有权限，不自动放宽权限；群卡正文展示无需访问妙笔会话。上传的运动名称与来源标签先转义，不能注入 Markdown 链接或群提醒。

验证包括卡片跨日、缺测、重叠、筛选、单位换算、文本转义、详情入口及重复抑制测试；`npm run test:runtime` 验证真实 workerd / SQLite / Alarm 发出的原生卡片。发布时使用既有 Worker 的私有配置，保留 worker 名称、DO 绑定和 Secrets，先验证 `GET /card`，再核对 `/status` 的投递结果与群内实际消息。不要把测试健康数据上传到生产库以触发验收。


## Mac 同 Wi-Fi 的原生 HealthRelay 服务

`integrations/hae-webhook/local-service.mjs` 是独立的 Node HTTPS 接收器，接收原生 `healthrelay.v1`，无需群机器人。它复用上述健康算法，通过已登录的 `lark-cli` 用户身份，只更新指定 Base 记录的 `title` 并读回验证。未配置 `signature` 时只接收数据。

本地服务固定使用恢复 HRV（RMSSD）和独立个人基线，不回退到 SDNN。iPhone / Watch 签名预设要求 iOS / watchOS 27；已有任务需在待传批次确认后更新指标选择，原始 SDNN 历史不删除。

本地服务使用 `renderStatusSignature` 生成个人签名，展示四档文字状态、当天睡眠等级、最新心率、今日步数、今日已记录锻炼累计时长、同步时间与详情入口。睡眠复用现有算法，分为“优秀”（≥80）、“良好”（60–79）、“一般”（40–59）、“待改善”（<40），各档都附上实际分数，例如“睡眠优秀(90分)”，有效零分也保留。仅展示北京时间当天的有效结果，缺测、未完成评分或非当天数据显示“睡眠暂无”；不沿用昨天的结果。四档状态均附参与对应评分的 HRV，例如“压力过载(恢复HRV 28.6)”；HRV 单位为毫秒，最多一位小数，内部压力分不进入标题，Base 不负责计分。夜间和历史结果使用各自评分依据的 HRV；历史值缺失时显示“恢复HRV 暂无”，不套用新采样。缺测和基线积累中的状态不生成虚构数值。本地文案版本为 `health-status-signature-text-v5`。夜间结果注明“夜间”，已发布的同来源、同规则历史结果最多保留 7 天并注明“上次”；缺测显示“状态暂无”，基线不足显示“状态数据积累中”。末尾“同步时间”取服务最近一次新批次成功提交的接收时间，按北京时间显示；不会用状态测量、心率采样、签名生成或发布时间代替。旧批次重放不推进同步时间。状态测量依据仍保留在状态接口中。

`native-activity.mjs` 按北京时间当天汇总活动。步数只取一个来源：优先有当日记录的手表，其次手机，其次其他来源；同类选择最近测量的来源，签名统一显示“今日XX步”，来源仍保留在状态接口中，不把手机与手表原始计数直接相加。这是已收到的单来源步数，不等同于 Apple 健康跨设备融合总量。锻炼使用原生记录的 `durationSeconds` 累计实际时长，排除完全重复的导入；锻炼累计不足 10 分钟或没有可靠累计值时，签名隐藏该片段；满 10 分钟后显示“💪 今日锻炼XX分”。没有当日记录不造出零分钟；重叠、跨午夜或无效时长的待核对原因仍保留在状态接口。心率超过 90 分钟注明“上次”，各指标更新时间互相独立。

状态、睡眠各档均附对应表情；心率不附“次/分”，按 <60 / 60–99 / 100–139 / ≥140 显示 💙 / ❤️ / 💓 / 🔥。今日步数按 <3000 / 3000–7999 / 8000–11999 / ≥12000 显示 🪑 / 🚶 / 🏃 / 🏅。区间按已四舍五入的展示值匹配，仅影响图标；详细映射见 [签名算法说明](signature-algorithm.md)。

在 Git 忽略目录准备配置（下列路径和标识均需替换为自己的真实值）：

```json
{
  "bind": "0.0.0.0",
  "port": 18443,
  "database": "/absolute/private-data/health.sqlite",
  "cert": "/absolute/private-data/server.crt",
  "key": "/absolute/private-data/server.key",
  "authFile": "/absolute/private-data/auth.key",
  "signature": {
    "cli": "/absolute/path/to/lark-cli",
    "baseToken": "YOUR_BASE_TOKEN",
    "tableId": "YOUR_TABLE_ID",
    "recordId": "YOUR_RECORD_ID"
  }
}
```

```sh
node integrations/hae-webhook/local-service.mjs /absolute/private-data/service-config.json
```

手机使用受信任且覆盖 Mac 局域网地址的 HTTPS 证书。在 App 的“配置健康签名同步”中填写 `/ingest` 完整地址及认证值；创建后分别运行指标、锻炼任务并授权，再启用自动化。首次读取 30 天，之后增量同步，最小期望间隔 5 分钟。系统控制后台时机；Mac 服务须可达，换 Wi-Fi/IP 后需更新证书或地址。

5 分钟是任务再次具备执行资格的最短间隔，不是后台定时保证。退到桌面后可由 HealthKit 通知和 BGAppRefresh 唤醒；锁屏时 HealthKit 可能不可读，本项目的配置与同步日志也有文件保护，解锁后会尝试继续。用户从多任务界面强制划掉 App 通常会阻止后台重新启动，需手动打开；关机期间不能同步。依据：[Apple 后台执行限制](https://developer.apple.com/forums/thread/685525)、[HealthKit 数据保护](https://developer.apple.com/documentation/healthkit/protecting-user-privacy)。

- `POST /ingest` 使用 `X-Acceptance-Key` 和 `Idempotency-Key`，最大 10 MiB、5000 条。原始数值、删除标记、批次哈希与回执在同一个 SQLite 事务中落盘，提交后才回执；相同批次重放返回原回执，正文变化返回 409。
- SQLite 使用 WAL 与 FULL 同步，数据库文件权限为 0600。原始记录、删除标记及回执持久保留；评分只使用最近 35 天。请按本地健康数据管理数据库及备份。
- `GET /status` 使用同一认证，返回接收统计、评分、生成标题及最后成功发布记录；`GET /healthz` 仅返回就绪标记。日志不输出认证值、原始样本或完整标题。
- 发布每 30 秒合并检查，内容相同不重复写；失败指数退避，成功状态保存在 SQLite。Base 只存动态标题，`url`、`image_key` 由使用者单独配置；须另外验证妙笔实际预览和点击落点。
- 可用用户 LaunchAgent 托管以上命令，在登录后运行并自动重启。LaunchAgent、私有配置、证书/密钥、数据库和绑定 ID 均不提交 Git。

原生接收器配套的 `magic-preview.cjs` 提供动态预览工厂。发布前在 Git 忽略目录生成副本，将末尾 `module.exports = createHealthPreview;` 改为传入真实 `baseToken/tableId/viewId/recordId/targetUrl` 的 `createHealthPreview({...})` 调用，然后用 `magic-builder faas publish` 发布 CommonJS 文件。只注入资源 ID 和目标地址，不注入访问凭据。

妙笔运行应用需要该签名 Base 的阅读权限（通过运行时确认应用 ID，再为此表添加 `view` 协作者；不要开放公开分享）。`91403` 表示当前身份无文档权限。SDK 的 `base_records_search` 返回 `data.items`，文本字段可能是富文本数组；预览会提取文字，只展示绑定记录的标题。

最终个人签名使用短链接 `https://magic.solutionsuite.cn/r?fid=YOUR_FUNCTION_ID&u=ENCODED_TARGET_URL`。`u` 明确控制浏览器跳转；只配置 Base 的 `url` 不能作为已验证的浏览器跳转依据。先确认函数 HTTP 200 的 `inline.i18n_title.zh_cn` 与 Base 一致，再验证 `/r` 重定向目标，最后在个人名片验证签名渲染与刷新。不要把聊天中的链接展开等同于已保存的个人签名。


## Apple Watch 日常与运动同步

Watch App 可直接创建两个健康签名任务；用户开始真实运动后，每 60 秒尝试上传实际心率和累计运动时长。临时摘要、最终 HealthKit 记录与后台回执均持久化，结束时原子替换避免重复累计。日常后台执行仍由 watchOS 安排。安装、认证、局域网 CA 信任、数据目录和真机验收见 [Watch 运行说明](watch-health-signature.md)。
