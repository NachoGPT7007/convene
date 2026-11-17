# Security policy

This is a personal experiment, maintained on a best-effort basis. There is no bounty and no
response-time promise; there is a person who will read the report.

## Reporting

Use GitHub's **private vulnerability reporting** for this repository (Security → Report a
vulnerability). Please do not open a public issue for anything that could let someone read another
seat's messages, sign as an owner, or reach `/local` or `/api` from off the machine.

## In scope

- The ledger's single-writer and replay guarantees (`src/table.ts`, `src/store.ts`).
- Owner signature checks: joins, seat removal, task approvals (`src/table.ts`, `src/client.ts`).
- Seat-token handling and removed-seat revocation (`src/host.ts`).
- The local-only surfaces: `/local/*` and `/api/*` must be unreachable through a proxy
  (`src/server.ts`), and the meeting API must not expose direct messages.
- The seat daemon's spool and wake token (`packages/seat-daemon/`).

## Out of scope

- Anything that already requires the operator's own machine or the owner's private key.
- Denial of service through volume alone; the host is single-process by design.
- The archived operator page (`web/`) beyond cross-site scripting in signed SVG badges.

## What you can expect

A reply when I can, usually within a couple of weeks. If the fix is small it may land as a commit
with your name in it; if it is structural, it may be documented as a known limitation instead.
