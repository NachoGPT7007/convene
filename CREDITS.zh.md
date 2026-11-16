# 致谢

[English](CREDITS.md) · 中文

convene 是个 fork。这个文件说清楚哪一行来自哪里，分三块：复用的协议与实现、只抄设计不抄代码的来源、以及贡献者。

如果你贡献过而这里没有你，开个 issue —— 那是这个文件的 bug。

## 1. 协议与实现

| 来源 | 许可 | convene 用了什么 | 核实 |
|---|---|---|---|
| [MiniMax-AI/mcode-agent-table](https://github.com/MiniMax-AI/mcode-agent-table) | MIT | **主干。** 账本、席位、投影、发言权、任务网关、HTTP + SSE、MCP 桥、席位 SDK、Rabbit Hole。fork 时的上游 HEAD：`b00862bf5b2e9b3d7ff3f758516e3c1dfd75442a`。 | 是 —— 主分支活跃，7 个 commit |
| [a2aproject/A2A](https://github.com/a2aproject/A2A) | Apache-2.0 | 席位 daemon 的 webhook 照它的 push notification 写；任务生命周期沿用它的词汇。 | 是 —— Linux Foundation 项目 |
| [Model Context Protocol](https://modelcontextprotocol.io) | 官方规范 | 异构 agent 唯一能共同说的一句话；`convene mcp` 就是入口。 | 是 |
| [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk) | — | 计划中的 daemon A2A 客户端，尚未使用。 | 已列在 A2A README |

上游的 LICENSE 原文完整保留在 [LICENSE](LICENSE)。MIT 给的是版权许可，不是商标许可：convene 不用 MiniMax 的 logo，也不带 `mcode-` 前缀，这里没有任何东西表示这个 fork 是官方的或由 MiniMax 支持。

## 2. 格式与思想（抄设计，不抄代码）

| 来源 | 许可 | 抄了什么 | 备注 |
|---|---|---|---|
| [ymxlx/agent-vault](https://github.com/ymxlx/agent-vault) | MIT | 事件行语法 `- YYYY-MM-DD HH:MM \| agent \| verb \| [[link]] \| note`；私有命名空间；handoff 仪式；`AGENTS.md` / `CLAUDE.md` / `GEMINI.md` 三入口指向同一份东西。 | 单人小项目：只抄格式 |
| [yumingtao/agent-handoff](https://github.com/yumingtao/agent-handoff) | MIT | 隐藏基线的独立评审（防锚定的 A/B）；supersede 链；进程状态流。 | 单人小项目：只抄协议 |
| [leepokai/codync-network](https://github.com/leepokai/codync-network) | Apache-2.0 | 限流数值：链式 8 跳、每对席位突发 5 条、之后每 2 分钟 1 条、10 分钟内相同内容拒收。还有「唤醒异构 agent」这个定位。 | 其 P2P 网络未采用 |
| [leepokai/codync-mem](https://github.com/leepokai/codync-mem) | Apache-2.0 | 写入前的确定性检查：隐藏字符、载着 prompt 的链接、植入指令、密钥；tombstone。 | 仅备查，未接入 |

`src/table.ts` 里 `dm` 的限流就是 codync-network 的数值。改数值的话，这张表一起改。

## 3. 文献里的思想

这一节全是思想，没有代码。讲的是那些形状从哪来；引用请引原文，别引这个仓库。书目信息在有人跑过引文核对之前一律**未核实**。

| 文献 | 它塑造了什么 | 核实 |
|---|---|---|
| Smith (1980)，*The Contract Net Protocol*，IEEE Transactions on Computers | 派单流程：manager 通告、agent 投标、manager 授予、agent 报告。convene 现在保留授予与报告，砍掉投标。 | 文献存在；卷期页码未逐字核 |
| Nii (1986)，*Blackboard Systems*，AI Magazine | 黑板真正的难点是控制——谁在什么时候可以写。也就是 `floor`。 | 存在；卷期未核 |
| Gelernter (1985)，*Generative communication in Linda*，ACM TOPLAS | tuple space 的 `out` / `rd` / `in`：共享黑板不需要中心服务器。 | 存在；卷期未核 |
| Erman et al. (1980)，*Hearsay-II*，ACM Computing Surveys | 黑板模型的开山之作。 | 存在；卷期未核 |
| *Robert's Rules of Order* | `proposal → approve → execute → verify` 的形状，以及独立评审背后的「回避」原则。 | 不是论文 |
| FIPA ACL | 一条消息就是一个言语行为（`inform`、`request`、`propose`、`accept`、`refuse`），`say` / `pass` / `proposal` / `decision` 由此而来。 | 标准；版本未核 |

## 4. npm 包

| 包 | 用途 | 状态 |
|---|---|---|
| `@modelcontextprotocol/sdk` | MCP server 侧 | 版本锁在 `package.json` |
| `ajv` | 每条账本条目与请求的 JSON Schema 校验 | 已锁版本 |
| `zod` | MCP 工具的入参 schema | 已锁版本 |
| `@minimax-ai/code-sdk` | MCode 席位适配器（上游） | 已锁版本 |
| `@noble/ed25519` | 计划：不依赖 Node 专有实现的 Ed25519 主人密钥 | **尚未成为依赖** —— 现在用的是 `node:crypto` |
| `@dicebear/core` | 计划：按席位名生成徽章 | **尚未成为依赖** |

## 5. 贡献者

### Issue

- （暂无）

### Pull request

- （暂无）

### 上游

来自 `mcode-agent-table` 的每一行都是 MiniMax Code 团队和它的贡献者写的。这个 fork 如果有价值，价值在上面那层运维。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
