// The seat's local MCP surface. The agent calls these when it is ready; nothing here writes to the
// table, and nothing here can sign for an owner. Reads only the local spool.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Spool, type SpooledWake } from './spool.js';
import { waitForUnread } from './wait.js';
import { catchUp, readSeatLink, type SeatLink } from './catch-up.js';

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

export function describeWake(w: SpooledWake): string {
  const what = w.entry.kind === 'system' ? `system/${w.entry.event ?? 'event'}` : (w.entry.kind ?? 'entry');
  const from = w.entry.seat ? `@${w.entry.seat}` : 'core';
  const task = w.entry.task ? ` task ${w.entry.task}` : '';
  const state = w.entry.state ? ` (${w.entry.state})` : '';
  return `#${w.seq} [${w.wakes.join('+')}] ${what} from ${from}${task}${state}`;
}

export function summarize(wakes: SpooledWake[], cursor: Record<string, number>): string {
  if (!wakes.length) return 'no unread wake-ups';
  const lines = wakes.slice(0, 50).map(describeWake);
  if (wakes.length > 50) lines.push(`... ${wakes.length - 50} more`);
  const unread = capturesPerTable(wakes);
  return [
    `${wakes.length} unread:`,
    ...lines,
    '',
    `ack with seat_ack (unread per table: ${JSON.stringify(unread)}; cursor: ${JSON.stringify(cursor)})`,
  ].join('\n');
}

function capturesPerTable(wakes: SpooledWake[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of wakes) out[w.table] = (out[w.table] ?? 0) + 1;
  return out;
}

export function createSeatServer(spool: Spool, link: SeatLink | null = null, defaultWaitMs = 25_000): McpServer {
  const server = new McpServer({ name: 'convene-seat', version: '0.1.0' });

  server.registerTool('seat_wait', {
    description: 'Block until this seat has an unread wake-up (the floor moved to you, a task was assigned, a direct message arrived), or until timeout_ms passes. Returns the unread list. Reading the projection for content is a separate tool; this only tells you that something needs you.',
    inputSchema: { timeout_ms: z.number().int().min(1000).max(300000).default(defaultWaitMs) },
  }, async (a) => {
    const wakes = await waitForUnread(spool, a.timeout_ms, link);
    return text(wakes.length ? summarize(wakes, spool.cursor) : `no unread wake-ups after ${a.timeout_ms} ms`);
  });

  server.registerTool('seat_inbox', {
    description: 'List unread wake-ups without waiting. Use this when you are already awake and want to clear the backlog.',
    inputSchema: {},
  }, async () => {
    spool.refresh();
    if (!spool.unread().length && link) await catchUp(spool, link);
    return text(summarize(spool.unread(), spool.cursor));
  });

  server.registerTool('seat_ack', {
    description: 'Mark wake-ups up to `seq` as read (all unread ones when omitted). Acking is local to this seat: the ledger is unchanged, and the table is not notified.',
    inputSchema: { seq: z.number().int().positive().optional() },
  }, async (a) => {
    const pending = spool.unread();
    if (!pending.length) return text('nothing to ack');
    const highest = new Map<string, number>();
    for (const w of pending) {
      if (a.seq === undefined || w.seq <= a.seq) highest.set(w.table, Math.max(highest.get(w.table) ?? 0, w.seq));
    }
    for (const [table, seq] of highest) spool.ack(table, seq);
    return text(`acked up to ${JSON.stringify(Object.fromEntries(highest))}; unread now ${spool.unread().length}; cursor ${JSON.stringify(spool.cursor)}`);
  });

  server.registerTool('seat_status', {
    description: 'Spool and cursor state: how many wakes are stored, how many are unread, and where the spool lives. Use it when deliveries look wrong.',
    inputSchema: {},
  }, async () => {
    spool.refresh();
    return text({
      spool: spool.dir,
      spooled: spool.size,
      unread: spool.unread().length,
      cursor: spool.cursor,
    });
  });

  return server;
}

/** stdio entry. `SEAT_DAEMON_SPOOL` (or argv[0]) is the spool directory the `serve` side writes. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const dir = process.env.SEAT_DAEMON_SPOOL ?? argv[0];
  if (!dir) throw new Error('seat-daemon mcp: pass the spool directory (SEAT_DAEMON_SPOOL or argv)');
  const spool = new Spool(dir);
  const server = createSeatServer(spool, readSeatLink(dir));
  await server.connect(new StdioServerTransport());
}
