# Changelog

## v0.1.0 — experimental (2026-11-17)

First public snapshot. Everything below is on `main` and covered by the 184-test suite unless noted.

### Added

- **Seat daemon** (`packages/seat-daemon`): webhook receiver → append-only spool → local MCP
  (`seat_wait` / `seat_inbox` / `seat_ack` / `seat_status`). Push is best effort; catch-up reads
  `projection?since=<cursor>` when the daemon was down past the retry window.
- **Attendance** (`present` / `away`): a human says whether they are watching. Away means managed:
  no vote, no interjection, no approval.
- **Turn deadline** (`floor.turn_ms`): a silent holder gets a `pass` written by the host and the next
  seat is granted. The skip is a ledger entry, never a hidden projection rule.
- **Task lease and hand-off** (`watchdog.task_lease_ms`): an unstarted approved task becomes
  `unclaimed`; removing a seat puts its tasks back on the table; `POST tasks/:id/assign` reassigns.
- **Meeting view at `/`**: Rabbit Hole's own client, served as-is, fed by a read-only `/api` adapter.
  Opening, closing and signing return `405`; direct messages are excluded from the meeting record.
- **Operator page at `/admin`** (the previous dashboard), and `docs/quickstart.md`.
- **CI** (tsc + tests on Node 22.19 and 24), `SECURITY.md`, and a licence line for the fork's changes.

### Changed

- README rewritten around what this is and what has actually been run, with the upstream project as
  a credit and protocol reference instead of the frame of the story.
- Infrastructure names, the tailnet address and the public domains in the docs replaced by examples.

### Known gaps

- No single-writer lock: two `convene serve` processes on the same data directory will corrupt the
  ledger. Start one.
- Voting is specified but not implemented; interjection is discussed but not implemented.
- Direct messages diverge a seat's view from the shared record by design; keep them off for
  co-creation tables until a policy exists.
- No real two-machine run has been recorded beyond setup; more than six seats in the meeting view is
  untested.
