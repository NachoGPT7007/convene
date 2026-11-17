// Which ledger entries owe a seat a wake-up. A pure function: no IO, no clock, so a table host can
// decide before it pushes and the same rules can be tested without a daemon.
import type { Entry } from './protocol.js';

export type WakeKind = 'floor' | 'task' | 'dm' | 'mention';

/** Addresses are stored as `@name`; accept either form so callers do not have to normalize twice. */
function addresses(e: Entry): Set<string> {
  return new Set((e.to ?? []).map(a => a.replace(/^@/, '')));
}

/**
 * Why `seat` is being told about `e`. Empty means the entry is visible to it (the projection still
 * carries it) but does not need the seat to act — a wake-up that costs nothing is a wake-up that
 * trains agents to ignore wake-ups.
 */
export function wakeFor(e: Entry, seat: string): WakeKind[] {
  const to = addresses(e);
  const wakes = new Set<WakeKind>();

  // The floor moved to this seat. Table Core names the holder in `data.holder` and also addresses
  // the entry at it, but only one of the two is guaranteed by a replay of an older ledger.
  if (e.event === 'floor_granted' && ((e.data?.holder as string | undefined) === seat || to.has(seat))) {
    wakes.add('floor');
  }

  // A task was opened for this seat, or its state advanced in a way that names it (executor,
  // verifier). `task_opened` addresses the executor; `task_state` addresses the next actor.
  if ((e.event === 'task_opened' || e.event === 'task_state') && to.has(seat)) {
    wakes.add('task');
  }

  // A direct message is a wake-up for its recipients only. The sender already knows it wrote it,
  // and a `read_dm_all` seat is not being asked to act just because it may read the log.
  if (e.kind === 'dm' && e.seat !== seat && to.has(seat)) wakes.add('dm');

  // Any other entry that names this seat. `dm` was counted above, and a `system` entry has its
  // own meaning (`floor` / `task`); adding "mention" to those would report one delivery twice
  // for one reason and teach agents that a mention means nothing specific.
  if (e.kind !== 'dm' && e.kind !== 'system' && e.seat !== seat && to.has(seat)) wakes.add('mention');

  return [...wakes];
}

/** True when any of `wakes` is one the subscription asked for. An empty `events` means every kind. */
export function wantsWake(subscribed: WakeKind[] | undefined, wakes: WakeKind[]): boolean {
  if (!subscribed || subscribed.length === 0) return wakes.length > 0;
  return wakes.some(w => subscribed.includes(w));
}
