// The webhook receiver: the table host POSTs here, the spool keeps it, the agent asks later.
// Loopback only by default; on a shared network configure a token and put this behind the host.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { Spool, type SpooledWake } from './spool.js';
import { checkWake } from './wake-schema.js';

export interface ReceiverOptions {
  /** When set, a POST must carry it as `x-convene-wake-token`. */
  token?: string;
  maxBytes?: number;
  now?: () => string;
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > maxBytes) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  if (!n) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('invalid JSON'); }
}

function toSpooled(body: Record<string, unknown>, now: () => string): SpooledWake {
  const entry = (body.entry ?? {}) as SpooledWake['entry'];
  return {
    table: String(body.table),
    seat: String(body.seat),
    seq: Number(body.cursor ?? entry.seq),
    wakes: Array.isArray(body.wakes) ? body.wakes.map(String) : [],
    entry: {
      seq: Number(entry.seq ?? body.cursor),
      kind: entry.kind,
      event: entry.event,
      seat: entry.seat,
      to: entry.to,
      task: entry.task,
      state: entry.state,
    },
    received_at: now(),
  };
}

export function createReceiver(spool: Spool, opts: ReceiverOptions = {}): Server {
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const now = opts.now ?? (() => new Date().toISOString());

  return createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? '/', 'http://x');

    // Health is unauthenticated on purpose: the operator checks it before registering anything.
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(200, { ok: true, spooled: spool.size, unread: spool.unread().length, cursor: spool.cursor });
    }
    if (req.method !== 'POST' || url.pathname !== '/wake') {
      return send(404, { error: { code: 'E_NOT_FOUND', message: 'use POST /wake' } });
    }
    if (opts.token && req.headers['x-convene-wake-token'] !== opts.token) {
      return send(401, { error: { code: 'E_UNAUTHORIZED', message: 'missing or wrong wake token' } });
    }
    let body: unknown;
    try {
      body = await readBody(req, maxBytes);
    } catch (err) {
      return send((err as Error).message === 'body too large' ? 413 : 400, { error: { code: 'E_SCHEMA', message: (err as Error).message } });
    }
    try {
      checkWake(body);
    } catch (err) {
      return send(400, { error: { code: 'E_SCHEMA', message: (err as Error).message } });
    }
    const wake = toSpooled(body as Record<string, unknown>, now);
    // A duplicate (the host retried because it did not see our 200) is accepted, not repeated.
    const added = spool.append(wake);
    return send(200, { ok: true, seq: wake.seq, added, unread: spool.unread().length });
  });
}
