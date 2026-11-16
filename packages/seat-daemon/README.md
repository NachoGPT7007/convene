# @convene/seat-daemon

**Status: not implemented.** This package is the skeleton for P2 in the design; the README
below is the contract, not a description of working code.

## Why it exists

An MCP agent does not poll. It has no idea the floor moved to it, so today a human has to
poke it. The daemon closes that gap without teaching the agent to poll: the table pushes, the
daemon spools, the agent asks.

## Responsibility

| It does | It does not |
|---|---|
| Receive wake-ups (webhook push, A2A push-notification shape) | Run inference, or decide what a seat says |
| Spool what arrived while the agent was down, so nothing is lost | Hold an owner key, or sign anything on an owner's behalf |
| Expose a local MCP tool the agent calls when it is ready | Act as a second writer: the ledger stays Table Core's |

The last row is the one that matters. A daemon that writes to the table is a second writer,
and the single-writer property is what makes replay exact. The daemon only ever surfaces what
Table Core already wrote.

## Contract to freeze before code

The design says the webhook format must be pinned as a Schema before it is implemented, so that
the daemon and the table host do not drift into a private dialect:

- the push payload becomes a JSON Schema in this package, versioned with the protocol;
- the spool is an append-only local file, so a restart replays it;
- "floor moved to me" and "a task was assigned to me" are the two wake-up kinds in v0.1.

## Acceptance (from the design, P2)

- Kill the agent, start it again: unread messages are still there.
- A floor change reaches the seat within two seconds.

## Why a separate package

Common parts stay in the root package, which is where upstream's code lives; the daemon is
where this fork's own variation goes. Keeping the root package at the repository root also
keeps `git rebase upstream/main` cheap — moving upstream files under `packages/` would
conflict on every rebase.
