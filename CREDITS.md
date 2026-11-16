# Credits

English · [中文](CREDITS.zh.md)

convene is a fork. This file says what came from where, in three blocks: the protocol and
implementations it reuses, the designs it copied without copying code, and the people who
contributed.

If you contributed and are not listed, open an issue — that is a bug in this file.

## 1. Protocol and implementations

| Source | Licence | What convene uses | Verified |
|---|---|---|---|
| [MiniMax-AI/mcode-agent-table](https://github.com/MiniMax-AI/mcode-agent-table) | MIT | **The trunk.** Ledger, seats, projections, floor, task gateway, HTTP + SSE, MCP bridge, seat SDK, Rabbit Hole. Upstream HEAD at fork time: `b00862bf5b2e9b3d7ff3f758516e3c1dfd75442a`. | Yes — main branch active, 7 commits |
| [a2aproject/A2A](https://github.com/a2aproject/A2A) | Apache-2.0 | The push-notification shape for the seat daemon's webhook, and the Task lifecycle vocabulary. | Yes — Linux Foundation project |
| [Model Context Protocol](https://modelcontextprotocol.io) | Official spec | The one interface every heterogeneous agent can speak; the `convene mcp` bridge is the entry point. | Yes |
| [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk) | — | Planned A2A client for the daemon. Not used yet. | Listed in the A2A README |

Upstream's LICENSE is kept intact in [LICENSE](LICENSE). MIT grants copyright, not trademark:
convene does not use MiniMax's logo or the `mcode-` prefix, and nothing here implies the fork
is official or supported by MiniMax.

## 2. Formats and ideas (design copied, code not)

| Source | Licence | What was copied | Caveat |
|---|---|---|---|
| [ymxlx/agent-vault](https://github.com/ymxlx/agent-vault) | MIT | Event-line syntax `- YYYY-MM-DD HH:MM \| agent \| verb \| [[link]] \| note`; private namespaces; the handoff ritual; one pointer file for `AGENTS.md` / `CLAUDE.md` / `GEMINI.md`. | Single author, small project: format only |
| [yumingtao/agent-handoff](https://github.com/yumingtao/agent-handoff) | MIT | The hidden-baseline independent review (an A/B that resists anchoring); the supersede chain; the process-state flow. | Single author, small project: protocol only |
| [leepokai/codync-network](https://github.com/leepokai/codync-network) | Apache-2.0 | The rate limits: 8 hops in a chain, 5-message burst per pair, then 1 per 2 minutes, and no repeat within 10 minutes. Also the framing of "wake up heterogeneous agents". | Its P2P network is not used |
| [leepokai/codync-mem](https://github.com/leepokai/codync-mem) | Apache-2.0 | Written-before checks: hidden characters, prompt-carrying links, planted instructions, keys. Tombstones. | Reference only, not wired in |

The `dm` limits in `src/table.ts` are the codync-network values. If you change them, change
this table too.

## 3. Ideas from the literature

None of this is code. It is where the shapes came from; cite the papers, not this repo.
Bibliographic details are **unverified** until someone runs a reference check.

| Work | What it shaped | Verified |
|---|---|---|
| Smith (1980), *The Contract Net Protocol*, IEEE Transactions on Computers | The assign-a-task flow: manager announces, agents bid, manager awards, agent reports. convene keeps award and report and drops the bid for now. | The paper exists; volume and pages not checked |
| Nii (1986), *Blackboard Systems*, AI Magazine | The real problem on a blackboard is control — who may write, and when. That is `floor`. | Exists; volume not checked |
| Gelernter (1985), *Generative communication in Linda*, ACM TOPLAS | The tuple space's `out` / `rd` / `in`: a shared blackboard does not need a central server. | Exists; volume not checked |
| Erman et al. (1980), *Hearsay-II*, ACM Computing Surveys | The blackboard model's founding paper. | Exists; volume not checked |
| *Robert's Rules of Order* | The `proposal → approve → execute → verify` shape, and the recusal idea behind independent review. | Not a paper |
| FIPA ACL | A message is a speech act (`inform`, `request`, `propose`, `accept`, `refuse`), which is where `say` / `pass` / `proposal` / `decision` come from. | Standard; version not checked |

## 4. npm packages

| Package | Used for | Status |
|---|---|---|
| `@modelcontextprotocol/sdk` | MCP server side | Version pinned in `package.json` |
| `ajv` | JSON Schema validation of every ledger entry and request | Pinned |
| `zod` | MCP tool input schemas | Pinned |
| `@minimax-ai/code-sdk` | The MCode seat adapter (upstream) | Pinned |
| `@noble/ed25519` | Planned: Ed25519 owner keys without a Node-only dependency | **Not yet a dependency** — keys come from `node:crypto` today |
| `@dicebear/core` | Planned: generate a badge from a seat name | **Not yet a dependency** |

## 5. Contributors

### Issues

- (none yet)

### Pull requests

- (none yet)

### Upstream

Every line that came from `mcode-agent-table` was written by the MiniMax Code team and its
contributors. The fork's value, if any, is the operations layer on top.

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
