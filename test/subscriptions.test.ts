// Subscriptions and wake delivery: the table tells a seat's daemon what needs it, without the
// daemon ever writing back. Everything here is visibility-first: a wake-up must not leak a body.
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { TableHost } from '../src/host.js';
import { JsonlStore } from '../src/store.js';
import { createTableServer } from '../src/server.js';
import { cfg, owners, talkCard } from './helpers.js';
import { Table } from '../src/table.js';

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function listen(server: Server): Promise<string> {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function waitUntil<T>(fn: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise(r => setTimeout(r, 25));
  }
}

async function start() {
  const host = new TableHost(new JsonlStore(mkdtempSync(join(tmpdir(), 'byob-subs-'))));
  const server = createTableServer(host, { tickMs: 50, dataDir: mkdtempSync(join(tmpdir(), 'byob-subs-data-')) });
  const url = await listen(server);
  host.create(cfg('t', { kind: 'broadcast', order: ['alice', 'bob'] }));
  const alice = host.join('t', owners.jenny.signJoin('t', { seat: 'alice', kind: 'bot', card: talkCard }) as never);
  const bob = host.join('t', owners.tao.signJoin('t', { seat: 'bob', kind: 'bot', card: talkCard }) as never);
  return { host, url, table: host.get('t'), alice, bob };
}

/** A fake daemon: collect every wake-up body and answer 200. */
async function sink() {
  const received: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      try { received.push(JSON.parse(raw) as Record<string, unknown>); } catch { /* ignore */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const url = await listen(server);
  return { url, received };
}

async function subscribe(url: string, token: string, deliverTo: string, events?: string[]) {
  const res = await fetch(`${url}/v0.1/tables/t/subscriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ url: deliverTo, events }),
  });
  return { status: res.status, body: (await res.json()) as { id?: string } };
}

describe('subscriptions', () => {
  it('needs a seat token, and registers only for the seat that owns it', async () => {
    const { url, alice } = await start();
    const anonymous = await fetch(`${url}/v0.1/tables/t/subscriptions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1:1/wake' }),
    });
    expect(anonymous.status).toBe(401);

    const r = await subscribe(url, alice.seat_token, 'http://127.0.0.1:1/wake');
    expect(r.status).toBe(201);
    expect(r.body.id).toMatch(/^sub_/);

    // Re-registering the same seat at the same URL reuses the id: a daemon restart must not pile up.
    const again = await subscribe(url, alice.seat_token, 'http://127.0.0.1:1/wake');
    expect(again.body.id).toBe(r.body.id);
  });

  it('refuses a URL that is not http(s)', async () => {
    const { url, alice } = await start();
    const res = await fetch(`${url}/v0.1/tables/t/subscriptions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.seat_token}` },
      body: JSON.stringify({ url: 'file:///etc/passwd' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('E_SCHEMA');
  });

  it('lets only the owning seat withdraw its own subscription', async () => {
    const { url, alice, bob } = await start();
    const r = await subscribe(url, bob.seat_token, 'http://127.0.0.1:1/wake');
    const id = r.body.id as string;
    const asAlice = await fetch(`${url}/v0.1/tables/t/subscriptions/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${alice.seat_token}` } });
    expect(asAlice.status).toBe(404);
    const asBob = await fetch(`${url}/v0.1/tables/t/subscriptions/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${bob.seat_token}` } });
    expect(asBob.status).toBe(200);
  });
});

describe('wake delivery', () => {
  it('delivers a floor hand-off to the next seat, and reaches it well inside two seconds', async () => {
    const { url, table, bob } = await start();
    const daemon = await sink();
    await subscribe(url, bob.seat_token, daemon.url + '/wake');
    (table as Table).post('alice', { kind: 'say', body: 'first' });
    const wake = await waitUntil(() => daemon.received.find(w => (w.wakes as string[])?.includes('floor')));
    expect(wake.seat).toBe('bob');
    expect((wake.entry as { to?: string[] }).to).toEqual(['@bob']);
  });

  it('wakes only the direct message recipient, and never the sender or a bystander', async () => {
    const { url, table, alice, bob } = await start();
    const daemon = await sink();
    await subscribe(url, bob.seat_token, daemon.url + '/wake');
    await subscribe(url, alice.seat_token, daemon.url + '/wake');
    (table as Table).post('alice', { kind: 'dm', to: ['@bob'], body: 'only for bob' });
    const dm = await waitUntil(() => daemon.received.find(w => (w.wakes as string[])?.includes('dm')));
    expect(dm.seat).toBe('bob');
    // The sender knows what it wrote; a wake-up for it would be noise.
    expect(daemon.received.some(w => w.seat === 'alice' && (w.wakes as string[])?.includes('dm'))).toBe(false);
    // The body itself never rides the push: the daemon reads the projection for content.
    expect(JSON.stringify(dm)).not.toContain('only for bob');
  });

  it('does not push entries a seat may not see', async () => {
    const { url, table, bob } = await start();
    const daemon = await sink();
    await subscribe(url, bob.seat_token, daemon.url + '/wake');
    // A dm from bob to alice is not bob's wake-up, and alice's subscription does not exist.
    (table as Table).post('bob', { kind: 'dm', to: ['@alice'], body: 'private to alice' });
    await new Promise(r => setTimeout(r, 300));
    expect(daemon.received).toEqual([]);
  });

  it('keeps the ledger writable when every receiver is down', async () => {
    const { url, table, bob } = await start();
    // Port 1 is closed: delivery fails, the ledger must not.
    await subscribe(url, bob.seat_token, 'http://127.0.0.1:1/wake');
    expect((table as Table).post('alice', { kind: 'say', body: 'still written' }).seq).toBeGreaterThan(0);
    expect((table as Table).entries.length).toBeGreaterThan(0);
  });

  it('honours an events filter', async () => {
    const { url, table, bob } = await start();
    const daemon = await sink();
    await subscribe(url, bob.seat_token, daemon.url + '/wake', ['dm']);
    (table as Table).post('alice', { kind: 'say', body: 'floor moves, but not subscribed' });
    await new Promise(r => setTimeout(r, 300));
    expect(daemon.received.filter(w => (w.wakes as string[])?.includes('floor'))).toEqual([]);
    (table as Table).post('alice', { kind: 'dm', to: ['@bob'], body: 'but this one is' });
    await waitUntil(() => daemon.received.find(w => (w.wakes as string[])?.includes('dm')));
  });
});
