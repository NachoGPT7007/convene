// The /api shape Rabbit Hole's client expects, served from our own table. Read-only on purpose:
// the meeting view shows the table, it never writes to it, and it never touches an owner key.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { meetingRows, meetingSnapshot } from './meeting-snapshot.js';
import type { TableHost } from './host.js';

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

export function handleApi(host: TableHost, req: IncomingMessage, res: ServerResponse, parts: string[], clients: Set<ServerResponse>): void {
  const n = parts.length;
  if (req.method === 'GET' && n === 2 && parts[1] === 'tables') {
    return json(res, 200, { meetings: meetingRows(host) });
  }
  if (req.method === 'GET' && n === 3 && parts[1] === 'tables') {
    const snap = meetingSnapshot(host, parts[2]);
    if (!snap) return json(res, 404, { error: { code: 'E_NOT_FOUND', message: 'no such table' } });
    return json(res, 200, snap);
  }
  // Rabbit Hole asks for models to populate its "new meeting" dialog; we run no models.
  if (req.method === 'GET' && n === 2 && parts[1] === 'models') {
    return json(res, 200, { models: [], default: null });
  }
  if (req.method === 'GET' && n === 2 && parts[1] === 'events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method !== 'GET') {
    // Opening, closing and signing all live in the CLI (or the operator page); the meeting view is
    // a reader. Saying so beats a silent 404 that looks like a broken app.
    return json(res, 405, { error: { code: 'E_NOT_SUPPORTED', message: 'the meeting view is read-only; use the convene CLI for writes' } });
  }
  return json(res, 404, { error: { code: 'E_NOT_FOUND', message: `${req.method} ${req.url}` } });
}

/** One SSE event per ledger entry is enough: the client re-reads the snapshot after each. */
export function broadcastEntry(clients: Set<ServerResponse>, table: string): void {
  const frame = `event: entry\ndata: ${JSON.stringify({ table })}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch { clients.delete(res); }
  }
}
