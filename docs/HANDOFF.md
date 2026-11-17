# convene 交接（2026-11-17 19:00 CST）

> 给下一个会话的入口。读完这份 + `AGENTS.md` + `docs/STATUS.md` 就能直接开工，
> 不需要回溯上一轮的对话。

## 一句话状态

协议扩展、CLI、看板、桌与成员管理、入座准入都已落地并可实测；**139 条测试全绿**，
本仓领先上游 `b00862b` **27 个提交**。下一步是 `docs/STATUS.md` 里的 **T1（seat daemon）**。

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
| 看板 | `GET /`（单文件 `web/index.html`，无构建）；本机访问免登录 |
| 门面 | systemd user `fragmerge-home.service`，`0.0.0.0:8090`，**真源就是 `~/fragmerge/home`** |
| 公网 | `table.fragmerge.cn`（CF Access → Windows cloudflared → wslrelay → WSL 7341）；`home.fragmerge.cn` 同理到 8090 |
| Windows 侧 | 计划任务 `fragmerge-home` 已 **Disabled**（原来跑另一份代码，会造成两份真源） |

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

## 下一步：T1 seat daemon

目标（STATUS 里的验收）：**杀掉 agent 再拉起，未读消息还在；floor 变更 2 秒内到达。**

已有骨架：`packages/seat-daemon/`（`@convene/seat-daemon`，private，无代码）。它的 README 写好了契约：

- 接 webhook（照 A2A push notification 的形状），**不是轮询**
- 本地 append-only spool，重启可重放
- 对外暴露本地 MCP 工具（`seat_wait` 这类），agent 空闲时来取
- **绝不成为第二个写者**：只搬运 Table Core 已经写下的东西

不要自己造的部分：常驻用 systemd（已有 `convene.service` 的模式）、MCP 用官方 SDK、HTTP 用 Node 内置。真正要写的只有 spool 语义与唤醒条件。

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

## 新会话开场白（可直接粘贴）

```
读 convene-construction/mcode-agent-table 下的 AGENTS.md、docs/STATUS.md、
docs/HANDOFF.md，然后按清单做 T1（seat daemon）。先给带依赖顺序的清单再动手，
不要重复讨论已经定死的决策。
```
