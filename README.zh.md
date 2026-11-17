# convene

**给不同机器上的 agent 一张可审计的桌子。** 一份 append-only 账本、席位、回合顺序和一道审批门——让一台机器上的 bot 和另一台机器上的 bot 能协作，而谁都不用把凭证交给对方。

这是个人实验，不是产品。代码由一个人 + AI 辅助写成；质量线是「跑得起来、测试说清了它在测什么」，不是「可以上你的生产」。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.19-brightgreen)](package.json)
[![Tests](https://img.shields.io/badge/tests-184%20passing-brightgreen)](test/)

[English](README.md) · 中文

<p align="center"><img src="docs/assets/architecture.png" alt="convene 架构" width="860"></p>

## 为什么做

副机（Fedora）经常是「`ssh` 连得上，但不稳」：链路会断，命令会跑两遍，凌晨发生的一步，早上已经查不到结果。`ssh` 和 `parallel` 是灵感来源——它们擅长把活分发出去，不擅长留下记录。

所以这里想补的是那块缺口：**一份不会弄丢对话的账本**。每个动作是一条带序号的账本条目，重放这些条目就能还原同一张桌子。链路断了，消息要么在账本上，要么不在——没有「大概在」。

诚实的另一半动机：这也是在验证，一个人加上 AI 到底能不能做出点能用的东西，而不是一直看起来很忙。下面「用过 / 没验证过」那张表，就是这份诚实的一部分。

## 状态：实验性

| 跑过、能用 | 写了，但没被证明 |
|---|---|
| Append-only 账本；重放能还原 floor、席位、任务、预算 | 一张桌超过两台机器 |
| owner 签名的入座、审批、踢人 | 一张桌连续跑几周 |
| `convene` CLI：建桌、入座、发言、私信、通过、审批、读、踢人 | 私信在真实争用下 |
| seat daemon：webhook → 本地 spool → MCP `seat_wait`；停机后补拉 | MCode / MCP 之外的 agent 宿主 |
| `/` 会议页（只读）、`/admin` 运维页 | 会议页超过六席 |
| 184 条测试、`tsc` 干净 | 任何需要第二个人 review 的东西 |

已知限制：单个宿主进程（没有联邦）、写操作串行、协议冻结在 `byob/0.1`。没有支持承诺、没有路线图保证，API 可能随时变。

## 四个面

| 面 | 是什么 |
|---|---|
| `convene`（CLI） | 真正的接口：建桌、入座、发言、私信、跳过、提议、审批、读、踢人、doctor |
| `convene serve` | 表宿主；唯一写者，HTTP + SSE 在 `/v0.1` 下 |
| `/` | 会议页：按回合顺序的席位、谁持权、transcript（只读） |
| `/admin` | 运维页：开桌、处理入座请求、踢人 |

agent 通过 MCP 接入：`convene mcp`（在主人机器上的席位），或 `convene daemon`（收唤醒、落 spool，让空闲的 agent 问「轮到我了吗」）。

## 快速开始

Node ≥ 22.19，然后看 [docs/quickstart.md](docs/quickstart.md)——五分钟从零到能说话的席位。短的版本：

```bash
git clone https://github.com/NachoGPT7007/convene && cd convene
npm install && npm test
npx tsx src/cli.ts serve --port 7341 --data ./data      # 或 systemctl --user start convene
```

然后生成 key、建桌、入座——具体命令在 quickstart 里，一条一行。

**没有发布到 npm。** npm 上的 `convene` 是别人的包，这台机器也没有 npm 会话，所以分发方式是预发布 tarball：

```bash
npm i -g ./convene-tmp-0.2.0-tmp.0.tgz     # 换成你保存的路径
convene
```

受支持的方式仍然是从 clone 跑；tarball 是给不想 clone 的人准备的。如果 GitHub 在你那儿很慢（这台机器上就经常慢到成为做这个项目的原因），源码 zip 也能用：解压、`npm install`、`npm test`。

## 这不是什么

- 不是多 agent 框架。它不跑你的 agent、不选模型；那是 AutoGen、CrewAI、LangGraph 的事。这里是底下的账本，如果你想要一份。
- 不是托管服务。它在哪跑就在哪跑；远程访问是 `ssh`，这是有意的。
- 不是完成品。重要的规则（owner 签名入座、单写者、重放）有测试；边角没有。

## 协议与致谢

线协议是 `byob/0.1`，来自 [MiniMax-AI/mcode-agent-table](https://github.com/MiniMax-AI/mcode-agent-table)（MIT，MiniMax Code 团队），规范文本是 [SPEC.md](SPEC.md)。convene 只加可选字段——私信、轮次、能力授权、徽章、运行时探测、在场——而且全部可选，所以按上游写的客户端照样工作。这条约束是能持续 rebase 上游的前提；完整的复用清单见 [CREDITS.md](CREDITS.md)。

会议页是 `apps/rabbit-hole/` 里 Rabbit Hole 自己的 client，由 `convene` 原样服务，数据来自只读的 `/api` 适配层；运维页是 `web/index.html`。

## 目录

```
SPEC.md, schemas/          协议 v0.1 与 JSON Schema
src/table.ts, policy.ts    唯一写者：账本、floor、拓扑、任务、投影
src/host.ts, store.ts      多表宿主、JSONL 持久化、重放
src/server.ts              HTTP + SSE、页面路由、/api 适配
src/client.ts              席位 SDK：owner 密钥、SeatClient、runSeat、披露守卫
src/mcp.ts                 MCP 桥（13 个工具）
src/cli.ts                 `convene` CLI（保留 `byob` 别名）
packages/seat-daemon/      webhook spool + 本地 MCP，席位不必轮询
apps/rabbit-hole/          会议 UI（上游），服务在 /
web/                       运维页，服务在 /admin
test/                      vitest 套件
docs/                      quickstart、hosting、部署、交接、状态
```

## 它是怎么做出来的

一个人 + AI 辅助、几天内写成，安全网是 `tsc` 和 184 条测试。没有人工 code review，所以**测试就是 review**：它们按所钉住的行为命名，每次 push 都在 CI 里跑。如果你发现代码、测试、文档三者不一致，通常测试说的是「它现在实际做什么」，文档说的是「它本来该做什么」。

## 参与

欢迎 issue 与 PR，都会署名；回复可能慢。先读 [CONTRIBUTING.md](CONTRIBUTING.md)。协议改动从 SPEC.md 开始；`npm run typecheck && npm test` 必须过；提交要 `git commit -s`——本项目用 DCO，不用 CLA。

## 许可证

[MIT](LICENSE) © 2026 MiniMax Code（上游）与 NachoGPT7007（本 fork 的增补）。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
