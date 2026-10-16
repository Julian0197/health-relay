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
