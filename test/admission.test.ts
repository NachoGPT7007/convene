// Asking to join, and an operator letting someone in — the two halves of a door.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { TableHost } from '../src/host.js';
import { JsonlStore } from '../src/store.js';
import { createTableServer } from '../src/server.js';
import { SeatClient, createTable } from '../src/client.js';
import { Table } from '../src/table.js';
import { cfg, owners } from './helpers.js';

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function start() {
  const host = new TableHost(new JsonlStore(mkdtempSync(join(tmpdir(), 'byob-adm-'))));
  const server = createTableServer(host, { tickMs: 50, dataDir: mkdtempSync(join(tmpdir(), 'byob-adm-data-')) });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A table that knows only tao, so jenny is a stranger. */
const onlyTao = { owners: { tao: { public_key: owners.tao.publicKey } } };
const card = { bot: 'x', capabilities: [] };

async function askToJoin(url: string, table: string, owner: typeof owners.jenny, seat: string) {
  const req = owner.signJoinRequest(table, { seat });
  return fetch(`${url}/v0.1/tables/${table}/join-requests`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req),
  });
}

describe('join requests', () => {
  it('lets a stranger ask, and keeps them out until an operator agrees', async () => {
    const url = await start();
    await createTable(url, cfg('adm', { kind: 'broadcast', order: ['a'] }, onlyTao));
    const a = await SeatClient.join(url, 'adm', owners.tao, { seat: 'a', card });

    // Not an owner yet: joining is refused, asking is allowed.
    const tooEarly = await SeatClient.join(url, 'adm', owners.jenny, { seat: 'b', card })
      .then(() => null, (e: { code: string }) => e);
    expect(tooEarly?.code).toBe('E_NOT_OWNER');

    expect((await askToJoin(url, 'adm', owners.jenny, 'b')).status).toBe(201);

    // The request is on the ledger, so everyone can see who is asking.
    const seen = await a.projection(0);
    const ask = seen.tail.find((e: { event?: string }) => e.event === 'join_request') as
      { data: { owner: string; seat: string } } | undefined;
    expect(ask).toBeTruthy();
    expect(ask!.data).toMatchObject({ owner: 'jenny', seat: 'b' });

    // Approved by the operator, not by the asker.
    const ok = await fetch(url + '/local/tables/adm/join-requests/jenny/admit', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(ok.status).toBe(200);

    const b = await SeatClient.join(url, 'adm', owners.jenny, { seat: 'b', card });
    expect(b.seat).toBe('b');
    const after = await a.projection(0);
    expect((after.prefix.seats as { seat: string }[]).map(x => x.seat).sort()).toEqual(['a', 'b']);
  });

  it('a refusal is on the ledger too, and the door stays shut', async () => {
    const url = await start();
    await createTable(url, cfg('adm2', { kind: 'broadcast', order: ['a'] }, onlyTao));
    await SeatClient.join(url, 'adm2', owners.tao, { seat: 'a', card });
    await askToJoin(url, 'adm2', owners.jenny, 'b');

    await fetch(url + '/local/tables/adm2/join-requests/jenny/reject', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'not now' }),
    });
    const refused = await SeatClient.join(url, 'adm2', owners.jenny, { seat: 'b', card })
      .then(() => null, (e: { code: string }) => e);
    expect(refused?.code).toBe('E_NOT_OWNER');
  });

  it('refuses a request whose signature does not match the key it carries', async () => {
    const url = await start();
    await createTable(url, cfg('adm3', { kind: 'broadcast', order: ['a'] }, onlyTao));
    await SeatClient.join(url, 'adm3', owners.tao, { seat: 'a', card });

    const forged = { ...owners.jenny.signJoinRequest('adm3', { seat: 'b' }), publicKey: owners.ops.publicKey };
    const res = await fetch(url + '/v0.1/tables/adm3/join-requests', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(forged),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('E_BAD_SIGNATURE');
  });

  it('replays admitted owners from the ledger, so a restart does not shut the door again', () => {
    const t1 = new Table(cfg('r', { kind: 'broadcast', order: ['a'] }, onlyTao));
    t1.join(owners.tao.signJoin('r', { seat: 'a', kind: 'bot', card }) as never);
    t1.requestJoin(owners.jenny.signJoinRequest('r', { seat: 'b' }) as never);
    t1.admitJoin('jenny');
    expect(t1.ownerKey('jenny')).toBeTruthy();

    const snapshot = JSON.parse(JSON.stringify(t1.entries));
    const t2 = new Table(cfg('r', { kind: 'broadcast', order: ['a'] }, onlyTao), undefined, snapshot);
    expect(t2.ownerKey('jenny')).toBeTruthy();
    // The admitted owner can actually sit down after the rebuild.
    expect(t2.join(owners.jenny.signJoin('r', { seat: 'b', kind: 'bot', card }) as never).seat).toBe('b');
  });
});
