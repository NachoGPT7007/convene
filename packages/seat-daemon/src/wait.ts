// Waiting for a wake-up without teaching the agent to poll the table.
//
// The receiver and this MCP side are separate processes: the daemon must outlive the agent, or
// "kill the agent and start it again" would lose whatever arrived in between. So the MCP process
// follows the spool file, and this wait is local: it costs a stat and a read, not a network round.
import { watch } from 'node:fs';
import { catchUp, type SeatLink } from './catch-up.js';
import type { Spool, SpooledWake } from './spool.js';

export async function waitForUnread(spool: Spool, timeoutMs: number, link: SeatLink | null = null, pollMs = 250): Promise<SpooledWake[]> {
  spool.refresh();
  if (!spool.unread().length && link) await catchUp(spool, link);
  const first = spool.unread();
  if (first.length) return first;

  return new Promise<SpooledWake[]>((resolve) => {
    let settled = false;
    let watcher: ReturnType<typeof watch> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (wakes: SpooledWake[]) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      if (deadline) clearTimeout(deadline);
      try { watcher?.close(); } catch { /* already closed */ }
      resolve(wakes);
    };
    const check = () => {
      spool.refresh();
      const unread = spool.unread();
      if (unread.length) finish(unread);
    };
    // While waiting, keep asking the host for what a failed push may have left behind: a wake-up
    // that never arrives is worse than one that arrives twice (the spool deduplicates by seq).
    const catchUpTimer = link ? setInterval(() => { void catchUp(spool, link).then(check); }, 5000) : undefined;
    // inotify is the fast path; the interval is the floor. On a container or a network filesystem
    // `watch` can miss events, and a missed wake-up is worse than a 250 ms local delay.
    try { watcher = watch(spool.wakesFile, { persistent: false }, check); } catch { /* polling only */ }
    timer = setInterval(check, pollMs);
    deadline = setTimeout(() => { if (catchUpTimer) clearInterval(catchUpTimer); finish([]); }, timeoutMs);
  });
}
