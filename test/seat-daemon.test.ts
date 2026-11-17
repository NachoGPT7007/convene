// The seat daemon's own behaviour, away from the table: what wakes a seat, what the spool keeps
// across a restart, and what the receiver refuses.
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { wakeFor, wantsWake } from '../src/wake.js';
import { Spool } from '../packages/seat-daemon/src/spool.js';
import { createReceiver } from '../packages/seat-daemon/src/receiver.js';
import { createSeatServer } from '../packages/seat-daemon/src/mcp.js';
import { catchUp } from '../packages/seat-daemon/src/catch-up.js';
import { seatServiceUnit, envFileContent } from '../packages/seat-daemon/src/unit.js';
import { mergeEnv } from '../packages/seat-daemon/src/cli.js';
import { TableHost } from '../src/host.js';
import { JsonlStore } from '../src/store.js';
import { createTableServer } from '../src/server.js';
import { cfg, owners, talkCard } from './helpers.js';
import type { Entry } from '../src/protocol.js';
import type { Table } from '../src/table.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

const e = (o: Partial<Entry>): Entry => ({ seq: 1, table: 't', seat: 'core', kind: 'system', ...o } as Entry);
const spoolDir = () => { const d = mkdtempSync(join(tmpdir(), 'seat-spool-')); dirs.push(d); return d; };

async function listen(server: Server): Promise<string> {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('wakeFor', () => {
  it('wakes the seat the floor was granted to', () => {
    expect(wakeFor(e({ event: 'floor_granted', to: ['@bob'], data: { holder: 'bob' } }), 'bob')).toEqual(['floor']);
    // Older ledgers name the holder in `data` only; the address is the fallback that still works.
    expect(wakeFor(e({ event: 'floor_granted', to: ['@bob'], data: { holder: 'bob' } }), 'alice')).toEqual([]);
  });

  it('wakes the direct message recipient but not the sender', () => {
    expect(wakeFor(e({ seat: 'alice', kind: 'dm', to: ['@bob'] }), 'bob')).toEqual(['dm']);
    expect(wakeFor(e({ seat: 'alice', kind: 'dm', to: ['@bob'] }), 'alice')).toEqual([]);
  });

  it('does not double-count a dm as a mention', () => {
    expect(wakeFor(e({ seat: 'alice', kind: 'dm', to: ['@bob'] }), 'bob')).not.toContain('mention');
  });

  it('wakes the seat a task was opened for, and the next actor on a state change', () => {
    expect(wakeFor(e({ event: 'task_opened', to: ['@bob'], task: 'T1' }), 'bob')).toEqual(['task']);
    expect(wakeFor(e({ event: 'task_state', to: ['@bob'], task: 'T1', state: 'verified' }), 'bob')).toEqual(['task']);
  });

  it('treats an address on a say as a mention, and never wakes the speaker', () => {
    expect(wakeFor(e({ seat: 'alice', kind: 'say', to: ['@bob'] }), 'bob')).toEqual(['mention']);
    expect(wakeFor(e({ seat: 'alice', kind: 'say', to: ['@bob'] }), 'alice')).toEqual([]);
  });

  it('honours an events filter, where an empty list means everything', () => {
    expect(wantsWake(['dm'], ['floor'])).toBe(false);
    expect(wantsWake(['dm'], ['dm'])).toBe(true);
    expect(wantsWake(undefined, ['floor'])).toBe(true);
    expect(wantsWake([], ['floor'])).toBe(true);
  });
});

describe('spool', () => {
  const wake = (seq: number) => ({ table: 't', seat: 'bob', seq, wakes: ['floor'], entry: { seq }, received_at: new Date().toISOString() });

  it('is idempotent: a retried delivery is stored once', () => {
    const spool = new Spool(spoolDir());
    expect(spool.append(wake(1))).toBe(true);
    expect(spool.append(wake(1))).toBe(false);
    expect(spool.size).toBe(1);
  });

  it('keeps unread wakes across a restart, which is the point of the spool', () => {
    const dir = spoolDir();
    const first = new Spool(dir);
    first.append(wake(1));
    first.append(wake(2));
    // The agent process is gone; the daemon process is gone. A new reader still sees both.
    const second = new Spool(dir);
    expect(second.unread().map(w => w.seq)).toEqual([1, 2]);
  });

  it('drops acked wakes from unread, and an old ack never rewinds the cursor', () => {
    const dir = spoolDir();
    const spool = new Spool(dir);
    spool.append(wake(1));
    spool.append(wake(2));
    expect(spool.ack('t', 2)).toBe(2);
    expect(spool.unread()).toEqual([]);
    expect(spool.ack('t', 1)).toBe(2);
    expect(new Spool(dir).unread()).toEqual([]);
  });

  it('follows appends another process wrote', () => {
    const dir = spoolDir();
    const reader = new Spool(dir);
    reader.append(wake(1)); // written by the receiver side, then read by this process
    const writer = new Spool(dir);
    writer.append(wake(2));
    expect(reader.unread().length).toBe(1);
    expect(reader.refresh()).toBe(1);
    expect(reader.unread().map(w => w.seq)).toEqual([1, 2]);
    expect(reader.refresh()).toBe(0);
  });

  it('drops an incomplete trailing line instead of gluing the next wake onto it', async () => {
    const dir = spoolDir();
    const spool = new Spool(dir);
    spool.append(wake(1));
    const { appendFileSync } = await import('node:fs');
    appendFileSync(join(dir, 'wakes.jsonl'), '{"table":"t","seq":2');
    const reopened = new Spool(dir);
    expect(reopened.size).toBe(1);
    reopened.append(wake(3));
    expect(new Spool(dir).unread().map(w => w.seq)).toEqual([1, 3]);
  });
});

describe('receiver', () => {
  const body = (seq = 1) => ({
    protocol: 'byob/0.1', table: 't', seat: 'bob', cursor: seq,
    wakes: ['floor'], at: new Date().toISOString(),
    entry: { seq, kind: 'system', event: 'floor_granted', to: ['@bob'] },
  });

  it('refuses a wrong wake token and a malformed body', async () => {
    const spool = new Spool(spoolDir());
    const url = await listen(createReceiver(spool, { token: 's3cret' }));
    const noToken = await fetch(url + '/wake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body()) });
    expect(noToken.status).toBe(401);
    const bad = await fetch(url + '/wake', { method: 'POST', headers: { 'content-type': 'application/json', 'x-convene-wake-token': 's3cret' }, body: '{"nope":1}' });
    expect(bad.status).toBe(400);
    expect(spool.size).toBe(0);
  });

  it('stores a valid wake before it acknowledges, and reports it unread', async () => {
    const dir = spoolDir();
    const spool = new Spool(dir);
    const url = await listen(createReceiver(spool, { token: 's3cret' }));
    const res = await fetch(url + '/wake', { method: 'POST', headers: { 'content-type': 'application/json', 'x-convene-wake-token': 's3cret' }, body: JSON.stringify(body(7)) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, added: true, unread: 1 });
    // Written through, not merely queued: a fresh reader sees it on disk.
    expect(new Spool(dir).unread().map(w => w.seq)).toEqual([7]);
    expect(readFileSync(join(dir, 'wakes.jsonl'), 'utf8')).toContain('"seq":7');
  });

  it('accepts a duplicate without storing it twice', async () => {
    const spool = new Spool(spoolDir());
    const url = await listen(createReceiver(spool));
    for (const _ of [1, 2]) {
      const res = await fetch(url + '/wake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body(3)) });
      expect(res.status).toBe(200);
    }
    expect(spool.size).toBe(1);
  });
});

describe('local MCP', () => {
  async function pair(spool: Spool) {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const server = createSeatServer(spool);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'test-agent', version: '0.0.0' });
    await client.connect(b);
    return client;
  }

  it('lists unread wakes and acks them, without touching the ledger', async () => {
    const spool = new Spool(spoolDir());
    spool.append({ table: 't', seat: 'bob', seq: 4, wakes: ['dm'], entry: { seq: 4, kind: 'dm', seat: 'alice' }, received_at: new Date().toISOString() });
    const client = await pair(spool);
    const inbox = await client.callTool({ name: 'seat_inbox', arguments: {} });
    expect((inbox.content as { text: string }[])[0].text).toContain('#4');
    expect((inbox.content as { text: string }[])[0].text).toContain('[dm]');
    const ack = await client.callTool({ name: 'seat_ack', arguments: {} });
    expect((ack.content as { text: string }[])[0].text).toContain('unread now 0');
    expect(spool.unread()).toEqual([]);
    await client.close();
  });

  it('seat_wait returns when another process appends a wake', async () => {
    const dir = spoolDir();
    const spool = new Spool(dir);
    const client = await pair(spool);
    const waiting = client.callTool({ name: 'seat_wait', arguments: { timeout_ms: 3000 } });
    setTimeout(() => { new Spool(dir).append({ table: 't', seat: 'bob', seq: 9, wakes: ['floor'], entry: { seq: 9, event: 'floor_granted' }, received_at: new Date().toISOString() }); }, 100);
    const res = await waiting;
    expect((res.content as { text: string }[])[0].text).toContain('#9');
    await client.close();
  });

  it('seat_wait reports an empty wait instead of hanging forever', async () => {
    const client = await pair(new Spool(spoolDir()));
    const res = await client.callTool({ name: 'seat_wait', arguments: { timeout_ms: 1000 } });
    expect((res.content as { text: string }[])[0].text).toContain('no unread');
    await client.close();
  });
});

describe('the unit and its env file', () => {
  const unit = (over: Record<string, string> = {}) => seatServiceUnit({
    name: 'convene-seat', repoRoot: '/repo', exec: ['node', '/repo/tsx', '/repo/src/cli.ts'],
    table: 'main', seat: 'bob', spoolDir: '/spool', ...over,
  });

  it('never puts the seat token on the ExecStart line', () => {
    const text = unit();
    expect(text).toContain('EnvironmentFile=-/spool/seat-daemon.env');
    expect(text).toContain('daemon serve');
    expect(text).not.toContain('token');
    expect(envFileContent({ url: 'http://h', table: 'main', seat: 'bob', token: 'T', listen: '127.0.0.1:7342', spoolDir: '/spool' }))
      .toContain('SEAT_DAEMON_TOKEN=T');
  });

  it('lets systemd start the daemon without a missing env file being fatal', () => {
    // The `-` prefix: a daemon with no token still starts and says what is missing, instead of
    // entering a restart loop that only systemd sees.
    expect(unit()).toMatch(/EnvironmentFile=-/);
  });

  it('takes connection details from the environment when flags are absent', () => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      SEAT_DAEMON_URL: 'http://env-host:7341', SEAT_DAEMON_TABLE: 'envtable',
      SEAT_DAEMON_SEAT: 'envseat', SEAT_DAEMON_TOKEN: 'envtok', SEAT_DAEMON_LISTEN: '127.0.0.1:7999',
    });
    try {
      const merged = mergeEnv({});
      expect(merged.url).toBe('http://env-host:7341');
      expect(merged.table).toBe('envtable');
      expect(merged.token).toBe('envtok');
      expect(merged.listen).toBe('127.0.0.1:7999');
      // A flag still wins over the environment.
      expect(mergeEnv({ seat: 'flagseat' }).seat).toBe('flagseat');
    } finally {
      for (const k of ['SEAT_DAEMON_URL', 'SEAT_DAEMON_TABLE', 'SEAT_DAEMON_SEAT', 'SEAT_DAEMON_TOKEN', 'SEAT_DAEMON_LISTEN']) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }
  });
});

describe('end to end: a table pushes, the spool keeps', () => {
  it('catches up on entries a downed daemon missed, without writing to the table', async () => {
    const host = new TableHost(new JsonlStore(mkdtempSync(join(tmpdir(), 'seat-catchup-'))));
    const server = createTableServer(host, { tickMs: 50, dataDir: mkdtempSync(join(tmpdir(), 'seat-catchup-data-')) });
    const url = await listen(server);
    host.create(cfg('t', { kind: 'broadcast', order: ['alice', 'bob'] }));
    host.join('t', owners.jenny.signJoin('t', { seat: 'alice', kind: 'bot', card: talkCard }) as never);
    const bob = host.join('t', owners.tao.signJoin('t', { seat: 'bob', kind: 'bot', card: talkCard }) as never);
    // No subscription: this is what a daemon that was down looks like from the host's side.
    (host.get('t') as Table).post('alice', { kind: 'dm', to: ['@bob'], body: 'you were not listening' });

    const spool = new Spool(spoolDir());
    const link = { url, table: 't', seat: 'bob', token: bob.seat_token };
    expect(await catchUp(spool, link)).toBeGreaterThan(0);
    expect(spool.unread().some(w => w.wakes.includes('dm'))).toBe(true);
    const ledgerBefore = (host.get('t') as Table).entries.length;
    expect(await catchUp(spool, link)).toBe(0);
    expect((host.get('t') as Table).entries.length).toBe(ledgerBefore);
  });

  it('spools a direct message within two seconds and still has it after the agent is killed', async () => {
    const host = new TableHost(new JsonlStore(mkdtempSync(join(tmpdir(), 'seat-e2e-'))));
    const server = createTableServer(host, { tickMs: 50, dataDir: mkdtempSync(join(tmpdir(), 'seat-e2e-data-')) });
    const url = await listen(server);
    host.create(cfg('t', { kind: 'broadcast', order: ['alice', 'bob'] }));
    const alice = host.join('t', owners.jenny.signJoin('t', { seat: 'alice', kind: 'bot', card: talkCard }) as never);
    const bob = host.join('t', owners.tao.signJoin('t', { seat: 'bob', kind: 'bot', card: talkCard }) as never);

    const dir = spoolDir();
    const spool = new Spool(dir);
    const daemon = await listen(createReceiver(spool));

    const reg = await fetch(`${url}/v0.1/tables/t/subscriptions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.seat_token}` },
      body: JSON.stringify({ url: daemon + '/wake' }),
    });
    expect(reg.status).toBe(201);

    const started = Date.now();
    (host.get('t') as Table).post('alice', { kind: 'dm', to: ['@bob'], body: 'wake up' });
    for (;;) {
      if (spool.unread().length) break;
      if (Date.now() - started > 2000) throw new Error('wake did not arrive within two seconds');
      await new Promise(r => setTimeout(r, 25));
    }
    expect(spool.unread()[0].wakes).toEqual(['dm']);
    expect(spool.unread()[0].entry.task).toBeUndefined();

    // The agent and its MCP side die. The daemon process and the spool do not.
    const afterRestart = new Spool(dir);
    expect(afterRestart.unread().map(w => w.wakes)).toEqual([['dm']]);
    expect(alice.seat_token).toBeTruthy();
  });
});
