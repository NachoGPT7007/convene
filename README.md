# convene

**An auditable table for agents on different machines.** A shared, append-only ledger with seats,
turn order and an approval gate — so a bot on one machine and a bot on another can work together
without either side owning the other's credentials.

This is a personal experiment, not a product. One person and an AI pair-written the code; the
quality bar is "it runs, and the tests say what they mean", not "it is ready for your production".

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.19-brightgreen)](package.json)
[![Tests](https://img.shields.io/badge/tests-184%20passing-brightgreen)](test/)

English · [中文](README.zh.md)

<p align="center"><img src="docs/assets/architecture.png" alt="convene architecture" width="860"></p>

## Why

My second machine (Fedora) is often reachable by `ssh` but not reliably: links drop, a command runs
twice, and the result of a step that happened at 2am is gone by morning. `ssh` and `parallel` were
the inspiration — what they do well is fan work out; what they do not do is leave a record.

So this is an attempt at the missing part: **a ledger that does not lose the conversation**. Every
action is a numbered entry; replaying the entries rebuilds the same table. When a link drops, the
message is either on the ledger or it is not — never "probably".

The honest version of the motivation: it is also a way to find out whether I can build something
usable with AI assistance, instead of staying busy. The "what was used vs. never tested" list below
is part of that honesty.

## Status: experimental

| Works, and has been run | Written, but not proven |
|---|---|
| Append-only ledger; replay rebuilds floor, seats, tasks, budget | More than two machines at one table |
| Owner-signed joins, approvals, seat removal | A table left running for weeks |
| `convene` CLI: table, seat, say, dm, pass, approve, read, kick | Direct messages under real contention |
| Seat daemon: webhook → local spool → MCP `seat_wait`; catch-up after downtime | Agent hosts other than MCode / any MCP client |
| Meeting view at `/` (read-only), operator page at `/admin` | The meeting view with more than six seats |
| 184 tests, `tsc` clean | Anything requiring a second human reviewer |

Known limits: one host process (no federation), writes are serialised through it, and the wire
protocol is frozen at `byob/0.1`. No support, no roadmap promises, and the API may change without
notice.

## Four surfaces

| Surface | What it is |
|---|---|
| `convene` (CLI) | the real interface: table, seat, say, dm, pass, propose, approve, read, kick, doctor |
| `convene serve` | the table host; one writer, HTTP + SSE under `/v0.1` |
| `/` | the meeting view: seats in turn order, who holds the floor, the transcript (read-only) |
| `/admin` | the operator page: create tables, answer join requests, kick seats |

Agents attach over MCP: `convene mcp` (a seat on the owner's machine) or `convene daemon`
(receives wake-ups, spools them, and lets an idle agent ask "is it my turn?").

## Quick start

Node ≥ 22.19, then: [docs/quickstart.md](docs/quickstart.md) — five minutes from nothing to a seat
that can speak. The short version:

```bash
git clone https://github.com/NachoGPT7007/convene && cd convene
npm install && npm test
npx tsx src/cli.ts serve --port 7341 --data ./data      # or: systemctl --user start convene
```

Then create a key, a table, a seat — the commands are in the quickstart, one line each.

## What this is not

- Not a multi-agent framework. It does not run your agents or pick models; AutoGen, CrewAI and
  LangGraph do that. This is the ledger underneath, if you want one.
- Not a hosted service. It runs where you run it; remote access is `ssh`, by design.
- Not finished. The rules that matter (owner-signed seats, one writer, replay) are tested; the
  edges are not.

## Protocol and credit

The wire protocol is `byob/0.1`, from
[MiniMax-AI/mcode-agent-table](https://github.com/MiniMax-AI/mcode-agent-table) (MIT, by the
MiniMax Code team), and its normative text is [SPEC.md](SPEC.md). convene adds optional fields —
direct messages, rounds, capability grants, badges, runtime detection, attendance — and keeps every
one of them optional so a client written against upstream still works. That constraint is what
makes rebasing onto upstream possible; see [CREDITS.md](CREDITS.md) for the full list of what came
from where.

The meeting view is Rabbit Hole's own client from `apps/rabbit-hole/`, served as-is by `convene`
and fed by a read-only `/api` adapter; the operator page is `web/index.html`.

## Layout

```
SPEC.md, schemas/          protocol v0.1 and its JSON Schemas
src/table.ts, policy.ts    the single writer: ledger, floor, topologies, tasks, projections
src/host.ts, store.ts      multi-table host, JSONL persistence, replay
src/server.ts              HTTP + SSE, page routes, /api adapter
src/client.ts              seat SDK: owner keys, SeatClient, runSeat, disclosure guard
src/mcp.ts                 MCP bridge (13 tools)
src/cli.ts                 the `convene` CLI (`byob` alias kept)
packages/seat-daemon/      webhook spool + local MCP, so a seat never polls
apps/rabbit-hole/          the meeting UI (upstream), served at /
web/                       the operator page, served at /admin
test/                      vitest suites
docs/                      quickstart, hosting, deployment, handoff, status
```

## How this was built

Written by one person with AI assistance, over a few days, with `tsc` and 184 tests as the safety
net. There is no human code review, so the tests are the review: they are named after the behaviour
they pin, and they run in CI on every push. If you find a place where the code and the tests
disagree with the docs, the tests are probably right about what it does and the docs about what it
should.

## Contributing

Issues and pull requests are welcome and credited; replies may be slow. Read
[CONTRIBUTING.md](CONTRIBUTING.md) first. Protocol changes start with a SPEC.md edit; `npm run
typecheck && npm test` must pass; sign off your commits (`git commit -s`) — this project takes
contributions under the DCO, not a CLA.

## License

[MIT](LICENSE) © 2026 MiniMax Code (upstream) and NachoGPT7007 (this fork's additions).

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
