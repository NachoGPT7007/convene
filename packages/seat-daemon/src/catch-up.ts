// Catching up on what a push could not deliver.
//
// A wake-up is best-effort: the host retries three times and then drops it, because a dead receiver
// must not stall the writer. When the daemon was down for longer than that, the ledger still has
// the entries — so once the seat asks, the daemon reads them back and applies the same wake rules.
// This is a read. It never writes to the table.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { wakeFor } from '../../../src/wake.js';
import type { Entry } from '../../../src/protocol.js';
import type { Spool } from './spool.js';

export interface SeatLink {
  url: string;
  table: string;
  seat: string;
  /** The seat's bearer token. `serve` writes it here (0600) so the MCP side can read the projection. */
  token: string;
}

export function readSeatLink(dir: string): SeatLink | null {
  const file = join(dir, 'seat.json');
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')) as SeatLink; } catch { return null; }
}

/**
 * Pull entries past this seat's cursor and spool the ones that would have woken it. Returns how
 * many were added; a host that cannot be reached is not an error — the next call tries again.
 */
export async function catchUp(spool: Spool, link: SeatLink, timeoutMs = 2000): Promise<number> {
  const cursor = spool.cursor[link.table] ?? 0;
  let res: Response;
  try {
    res = await fetch(`${link.url.replace(/\/+$/, '')}/v0.1/tables/${encodeURIComponent(link.table)}/projection?since=${cursor}`, {
      headers: { authorization: `Bearer ${link.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return 0;
  }
  if (!res.ok) return 0;
  const body = (await res.json()) as { tail?: Entry[] };
  let added = 0;
  for (const e of body.tail ?? []) {
    if (e.seq <= cursor) continue;
    const wakes = wakeFor(e, link.seat);
    if (!wakes.length) continue;
    if (spool.append({
      table: link.table,
      seat: link.seat,
      seq: e.seq,
      wakes,
      entry: { seq: e.seq, kind: e.kind, event: e.event, seat: e.seat, to: e.to, task: e.task, state: e.state },
      received_at: new Date().toISOString(),
    })) added++;
  }
  return added;
}
