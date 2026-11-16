// The local operator interface: what this machine has, and creating a table without a signature.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { TableHost } from '../src/host.js';
import { JsonlStore } from '../src/store.js';
import { createTableServer } from '../src/server.js';
import { isLoopback } from '../src/local.js';
import { cfg, owners } from './helpers.js';
import { SeatClient, createTable } from '../src/client.js';

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function start(dataDir?: string) {
  const host = new TableHost(new JsonlStore(mkdtempSync(join(tmpdir(), 'byob-local-'))));
  const server = createTableServer(host, { tickMs: 50, dataDir: dataDir ?? mkdtempSync(join(tmpdir(), 'byob-data-')) });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { host, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const wizardBody = {
  id: 'scan-built',
  topic: '两个席位一个人',
  mode: 'coordinate',
  seats: [{ seat: 'nacho.wsl', owner: 'tao' }, { seat: 'nacho.fedora', owner: 'tao' }],
  owners: [{ owner: 'tao', publicKey: owners.tao.publicKey }],
};

describe('local operator interface', () => {
  it('describes what this machine holds, and never returns a private key', async () => {
    const { url } = await start();
    const state = await (await fetch(url + '/local/state')).json();
    expect(state.tables).toEqual([]);
    expect(state.owners).toEqual([]);
    expect(state.seats).toEqual([]);
    expect(JSON.stringify(state)).not.toMatch(/privateKey/);
  });

  it('creates a table from the wizard form, because creating needs no signature', async () => {
    const { url } = await start();
    const res = await fetch(url + '/local/tables', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(wizardBody),
    });
    expect(res.status).toBe(201);
    const out = await res.json();
    expect(out.table).toBe('scan-built');
    expect(typeof out.admin_token).toBe('string');

    const state = await (await fetch(url + '/local/state')).json();
    expect(state.tables).toHaveLength(1);
    // Longest-path topology: one dispatcher, one report.
    expect(state.tables[0]).toMatchObject({ id: 'scan-built', topic: '两个席位一个人', status: 'open' });
  });


  it('closes a table, then deletes it with its files', async () => {
    const { url } = await start();
    await fetch(url + '/local/tables', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(wizardBody),
    });
    const closed = await fetch(url + '/local/tables/scan-built/close', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'done here' }),
    });
    expect(closed.status).toBe(200);
    let state = await (await fetch(url + '/local/state')).json();
    expect(state.tables[0].status).toBe('closed');

    const removed = await fetch(url + '/local/tables/scan-built', { method: 'DELETE' });
    expect(removed.status).toBe(200);
    state = await (await fetch(url + '/local/state')).json();
    expect(state.tables).toEqual([]);
  });

  it('reports the round, the entry count and who holds the floor', async () => {
    const { url } = await start();
    await fetch(url + '/local/tables', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(wizardBody),
    });
    const state = await (await fetch(url + '/local/state')).json();
    const t = state.tables[0];
    expect(t).toMatchObject({ id: 'scan-built', round: 0 });
    expect(t.entries).toBeGreaterThan(0); // table_opened
    expect(t.holder).toBeNull();          // nobody has joined yet
    expect(typeof t.tokens).toBe('number');
  });


  it('removing a seat drops it from the projection and kills its token', async () => {
    const { url } = await start();
    await createTable(url, cfg('kick', { kind: 'broadcast', order: ['ka', 'kb'] }));
    const a = await SeatClient.join(url, 'kick', owners.tao, { seat: 'ka', card: { bot: 'x', capabilities: [] } });
    const b = await SeatClient.join(url, 'kick', owners.tao, { seat: 'kb', card: { bot: 'x', capabilities: [] } });

    expect((await a.projection(0)).prefix.seats.map((x: { seat: string }) => x.seat)).toEqual(['ka', 'kb']);

    const rm = await fetch(url + '/local/tables/kick/seats/ka/remove', { method: 'POST' });
    expect(rm.status).toBe(200);

    expect((await b.projection(0)).prefix.seats.map((x: { seat: string }) => x.seat)).toEqual(['kb']);
    // The credential is revoked, so this is an auth failure and not a missing-seat 404.
    const dead = await a.projection(0).then(() => null, (e: { code: string }) => e);
    expect(dead?.code).toBe('E_UNAUTHORIZED');
  });

  it('hands the floor on when the removed seat was holding it', async () => {
    const { url } = await start();
    await createTable(url, cfg('kick2', { kind: 'broadcast', order: ['ka', 'kb'] }));
    const b = await SeatClient.join(url, 'kick2', owners.tao, { seat: 'kb', card: { bot: 'x', capabilities: [] } });
    await SeatClient.join(url, 'kick2', owners.tao, { seat: 'ka', card: { bot: 'x', capabilities: [] } });
    expect((await b.projection(0)).floor.holder).toBe('ka');

    await fetch(url + '/kick2-placeholder', { method: 'GET' }).catch(() => null);
    await fetch(url + '/local/tables/kick2/seats/ka/remove', { method: 'POST' });
    const after = await b.projection(0);
    expect(after.prefix.seats.map((x: { seat: string }) => x.seat)).toEqual(['kb']);
    // ka held the floor; it must not be left dangling.
    expect(after.floor.holder).toBe('kb');
  });

  it('refuses the interface when a proxy forwarded the request', async () => {
    const { url } = await start();
    for (const header of ['x-forwarded-for', 'cf-connecting-ip', 'x-real-ip']) {
      const res = await fetch(url + '/local/state', { headers: { [header]: '1.2.3.4' } });
      expect(res.status).toBe(404);
    }
    // The protocol surface is untouched by that guard.
    expect((await fetch(url + '/v0.1')).status).toBe(200);
  });

  it('is off when no data directory is configured', async () => {
    const host = new TableHost(new JsonlStore(mkdtempSync(join(tmpdir(), 'byob-local-'))));
    const server = createTableServer(host, { tickMs: 50 });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await fetch(url + '/local/state')).status).toBe(404);
  });

  it('recognises loopback addresses only', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('100.69.213.72')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});
