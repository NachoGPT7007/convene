# @convene/seat-daemon

**Status: implemented (T1).** The contract below is now code; see `src/`.

## Why it exists

An MCP agent does not poll. It has no idea the floor moved to it, so without this daemon a human
has to poke it. The daemon closes that gap without teaching the agent to poll: the table pushes,
the daemon spools, the agent asks.

## Responsibility

| It does | It does not |
|---|---|
| Receive wake-ups (webhook push, A2A push-notification shape) | Run inference, or decide what a seat says |
| Spool what arrived while the agent was down, so nothing is lost | Hold an owner key, or sign anything on an owner's behalf |
| Expose a local MCP tool the agent calls when it is ready | Act as a second writer: the ledger stays Table Core's |

The last row is the one that matters. A daemon that writes to the table is a second writer,
and the single-writer property is what makes replay exact. The daemon only ever surfaces what
Table Core already wrote.

## Layout

| File | What it is |
|---|---|
| `schemas/wake.json` | The pushed payload, frozen as a JSON Schema before the code (A2A push shape) |
| `src/spool.ts` | Append-only `wakes.jsonl` + atomic `cursor.json`; fsync before the receiver answers |
| `src/receiver.ts` | `POST /wake` on loopback (optional wake token), `GET /health`; spools, then 200 |
| `src/wait.ts` | Blocking wait that follows the spool file across processes |
| `src/mcp.ts` | `seat_wait` / `seat_inbox` / `seat_ack` / `seat_status` over stdio |
| `src/catch-up.ts` | Reads `projection?since=<cursor>` to recover pushes dropped while the daemon was down |
| `src/register.ts` | Registers the subscription with the host using the seat token (idempotent per seat+url) |
| `src/unit.ts` | systemd unit + env-file text; the token never goes on a command line |
| `src/cli.ts` | `serve` / `mcp` / `status` / `register` / `unit` / `envfile` |
| `src/wake-schema.ts` | Validates the pushed body against the frozen schema |

Wake kinds in v0.1: `floor`, `task`, `dm`, `mention`. The rules live in the root package's
`src/wake.ts` (a pure function), because the host decides before it pushes.

## Usage

```bash
# The long-lived side. Registers the subscription, receives, spools, catches up.
convene daemon serve --url http://127.0.0.1:7341 --table main --seat bob \
  --token <seat token> --listen 127.0.0.1:7342 --spool ~/.convene/seat-daemon/main/bob

# The agent side. The agent spawns this over stdio.
convene daemon mcp --spool ~/.convene/seat-daemon/main/bob

# Operator readouts.
convene daemon status --spool ~/.convene/seat-daemon/main/bob
convene daemon unit --table main --seat bob        # prints, does not install
convene daemon envfile --url http://127.0.0.1:7341 --table main --seat bob --token <token>
```

## Acceptance (T1)

- Kill the agent, start it again: unread messages are still there. ✅ (spool replay; measured)
- A floor change reaches the seat within two seconds. ✅ (16 ms measured; 147 ms for a dm)

## Why a separate package

Common parts stay in the root package, which is where upstream's code lives; the daemon is where
this fork's own variation goes. Keeping the root package at the repository root also keeps
`git rebase upstream/main` cheap.
