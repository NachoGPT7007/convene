# convene 交接（2026-11-17 19:20 CST）

> 给下一个会话的入口。读完这份 + `AGENTS.md` + `docs/STATUS.md` 就能直接开工，
> 不需要回溯上一轮的对话。

## 一句话状态

协议扩展、CLI、会议页（`/`）、运维页（`/admin`）、入座准入、**T1 seat daemon**、托管与超时都已落地并可实测；**184 条测试全绿**。
**v0.1.0 已打 tag 并公开**（2026-11-17），仓库 `NachoGPT7007/convene`；CI 跑 tsc + tests。下一步不是加功能，而是按 HANDOFF 末尾的时间盒真实使用两周（见 `docs/quickstart.md`）。

## 必读

| 文件 | 为什么 |
|---|---|
| [`AGENTS.md`](../AGENTS.md) | 工作区边界、代码标准、观测纪律、验收命令 |
| [`docs/STATUS.md`](STATUS.md) | 已完成 / 未完成 T1–T12 / 本会话修掉的问题 |
| [`docs/hosting.md`](hosting.md) | 别人怎么建桌、地址从哪来、准入流程 |

## 运行现状（本机，已验证）

| 项 | 值 |
|---|---|
| 仓库 | `~/convene-construction/mcode-agent-table`，命令 `convene`（`~/.local/bin/convene`，直跑 TS 源码） |
| 宿主 | systemd user `convene.service`，`0.0.0.0:7341`，数据在 `~/convene-data` |
| 现有桌子 | `main`：6 席（alice/bob/carol/dave/erin/stranger.pc），18 条账本 |
| 会议页 | `GET /` = Rabbit Hole 自己的 client（只读），数据来自 `/api` 适配层；开桌/签字在 CLI |
| 运维页 | `GET /admin` = `web/index.html`（归档运维面）；本机访问免登录 |
| 门面 | systemd user `other-app.service`，`0.0.0.0:8090`，**真源就是 `~/other-app`** |
| 公网 | `table.example.com`（CF Access → Windows cloudflared → wslrelay → WSL 7341）；`home.example.com` 同理到 8090 |
| Windows 侧 | 计划任务 `other-app` 已 **Disabled**（原来跑另一份代码，会造成两份真源） |
| 唤醒 | `convene daemon serve`（收 webhook→spool）/ `convene daemon mcp`（agent 侧 stdio MCP）。**本机未装成常驻服务**：`convene daemon unit` 只打印 unit，装不装由人决定 |

验收（一次跑完）：

```bash
cd ~/convene-construction/mcode-agent-table
npx tsc -p . --noEmit && npm test          # 期望 139 passed
convene doctor --url http://127.0.0.1:7341
```

## 已经定死、不要重新讨论的决策

1. **协议只加不删**：`schemas/` 里只新增可选字段，不删不改名。老客户端不传新字段必须照常工作——这是能继续 rebase 上游的唯一前提。
2. **扩展字段**：`dm` / `round` / `grants` / `badge` / `runtime` / `join_*` / `seat_removed`。都已是既成事实，不要推翻。
3. **不引入 Matrix**（AS 是 passive，真 floor 做不了）、**不用 Codync 的 P2P**（TUN 下退回 relay）、**不按模式分 git 分支**（用 `mode` 字段）。
4. **前端单文件、无构建**（`web/index.html`），改完重启服务即生效，不引入打包器。
5. **审批必须 owner 私钥签名**，页面只握 seat token，所以审批永远只给命令、不做按钮。
6. **准入走账本**（`join_request` → `join_admitted`），不改 `table-config.owners`；答案是「在门口开」：只有本机操作者能批准。
7. **`round` = decision 计数**（不是 policy 回合）。这个语义差异是已知的、待决的，见 STATUS 末尾。

## 下一步：T2 入座公开表单页

目标（STATUS 里的验收）：**陌生人打开一个页面填公钥即发起请求。**

现有的准入链路已经通了（`join_request` → 看板弹窗「允许」→ `join_admitted` 落账本，重放生效），
缺的只是「陌生人从哪找到这个入口」。别重做协议：一个新的公开 GET 页 + 复用
`POST /v0.1/tables/<id>/join-requests`，T1 的推送不参与。

## 待决：前端要不要改成 Rabbit Hole

`web/index.html`（单文件，1193 行）是本项目当前前端。Rabbit Hole 在 `apps/rabbit-hole/`，MIT，
但它是 **MiniMax Code 的 mini app**：`miniapp.json` 声明 `runtime.kind=process` + `agentAccess: session.run`，
`node/server.mjs` 的 `start(context)` 需要宿主注入 `dataDir/pluginRoot/listen/signal/logger/agent`；
前端走 `/api/*` 到它自己的 `service.mjs`（与本仓 `src/` 平行的第二套应用层）。本机没装 MiniMax 宿主。

**更正**：曾写「它的 table-core 副本不含本项目新字段」——不成立。`apps/rabbit-hole/miniapp/node/vendor/table-core.mjs`
是本仓 HEAD 用 `scripts/build-miniapp.mjs` 打包的产物（文件头有 `bundled from mcode-agent-table@<sha>`），
含 `join_*`/`seat_removed`/`dm` 全部逻辑；缺新字段的是**它的 client 渲染**与 `service.mjs` 的行为。

三条路，等拍板，不要擅自推翻已上线前端：

| 路 | 做什么 | 代价 |
|---|---|---|
| A 保持现状 | `web/` 继续演进；视觉已换成 Rabbit Hole 的调色板/席位色/卡片语言（C1），结构未动 | 无迁移成本；仍是三栏看板，没有它的会议视图 |
| B 以 Rabbit Hole 为底重写 | fork `client/`，接 `/v0.1`，补 `dm`/`join_*`/`seat_removed` 渲染，去掉宿主桥，移植本机免登录/开桌/踢人 | 与 A 的功能并集 + 一套渲染改造；之后两套前端会分叉 |
| C 只借设计 | C1 换皮已完成；C2 房间视图（座位网格/聚焦/transcript）未做 | C2 约 350–450 行，仍不碰数据层 |

评估依据：Rabbit Hole client 1486 行（`app.js` 657 + `i18n.js` 440 + `style.css` 291 + `seats.js` 34 + `index.html` 64），
`window.mcode` 只在 3 处出现且都是可选链；它的三栏/会议视图与本项目「席位 / 账本 / 任务」不同构。

## 踩过的坑（别再踩）

| 坑 | 教训 |
|---|---|
| 改了两轮门面，线上毫无变化 | 同名服务可能有两份代码。**先确认进程命令行 + 监听地址 + 改完能看到变化**，再动手 |
| `git add -A` 把工作区的无关改动卷进提交（两次） | 按路径 `git add`，不用 `-A` |
| 测试红着就提交（一次） | `tsc` 与 `npm test` 都绿才提交 |
| 反代从本机转发时 `remoteAddress` 也是回环 | `/local/*` 必须同时看转发头，否则公网能读到 seat token |
| `npm run build` 把 `test/` 编进 `dist/`，测试跑两遍 | `vitest.config.ts` 只收 `test/` |
| systemd unit 指向 `dist/`，改源码不生效 | 改跑源码（tsx），`--from dist` 才用构建产物 |
| 席位只绑 `127.0.0.1`，tailnet 连不到 | 绑 `0.0.0.0`；`/local/*` 对外仍 404 |
| 以为 webhook 推送就是保证 | 推送是**尽力而为**：超时/重试后放弃，daemon 停机就丢。保证在 spool + 重启补拉（`projection?since=cursor`），推送只负责「2 秒内」。别把可靠性押在 POST 成功上 |
| seat token 写进 systemd `ExecStart` | `/proc` 里全机器可读。token 只进 `envfile`（0600），unit 用 `EnvironmentFile=` |
| 想给远程人加一条公网 admit 接口 | 不做：远程走 SSH，进来就是本机。多一条远程入口就多一套 TLS/认证/审计面，SSH 已经做完了 |

## 新会话开场白（可直接粘贴）

```
读 convene-construction/mcode-agent-table 下的 AGENTS.md、docs/STATUS.md、
docs/HANDOFF.md，然后按清单做 T2（入座公开表单页）。先给带依赖顺序的清单再动手，
不要重复讨论已经定死的决策。
```
