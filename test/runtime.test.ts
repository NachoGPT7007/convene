// A seat should say what it runs on without being asked, and nobody should be able to type a nicer answer.
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
import { detectRuntime } from '../src/runtime.js';
import { cfg, owners } from './helpers.js';

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function start() {
  const host = new TableHost(new JsonlStore(mkdtempSync(join(tmpdir(), 'byob-rt-'))));
  const server = createTableServer(host, { tickMs: 50 });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('seat runtime', () => {
  it('marks WSL when the environment says so', () => {
    const r = detectRuntime('dsh', { WSL_DISTRO_NAME: 'Ubuntu-24.04' } as NodeJS.ProcessEnv);
    expect(r.os).toMatch(/WSL/);
    expect(r.agent).toBe('dsh');
    expect(r.host.length).toBeGreaterThan(0);
  });

  it('still finds the distribution and the host when no environment variable is set', () => {
    // This runs under npm/vitest, where WSL_DISTRO_NAME is usually absent: the kernel string
    // in /proc/version is what saves it.
    const r = detectRuntime('convene-cli', {});
    expect(r.os.length).toBeGreaterThan(3);
    expect(r.os).not.toMatch(/undefined/);
    expect(r.host.length).toBeGreaterThan(0);
    if (process.platform === 'linux') expect(r.os).toMatch(/(WSL|Ubuntu|Debian|Fedora|Linux)/);
  });

  it('is filled by the client at join time and shows up in the projection', async () => {
    const url = await start();
    await createTable(url, cfg('rt', { kind: 'broadcast', order: ['a'] }));
    const c = await SeatClient.join(url, 'rt', owners.tao, { seat: 'a', card: { bot: 'dsh', capabilities: [] } });
    const p = await c.projection(0);
    const s = (p.prefix.seats as { seat: string; runtime?: { os?: string; host?: string; agent?: string } }[])[0];
    expect(s.runtime).toMatchObject({ agent: 'dsh' });
    expect(typeof s.runtime!.os).toBe('string');
    expect(s.runtime!.os!.length).toBeGreaterThan(3);
    expect(typeof s.runtime!.host).toBe('string');
  });

  it('cannot be swapped after signing: a card that differs from the signed payload is refused', async () => {
    const { Table } = await import('../src/table.js');
    const t = new Table(cfg('rt2', { kind: 'broadcast', order: ['a', 'b'] }));
    const signed = owners.tao.signJoin('rt2', { seat: 'a', kind: 'bot', card: { bot: 'dsh', capabilities: [] } });
    const forged = { ...signed, card: { ...signed.card, runtime: { os: 'TempleOS', host: 'nowhere', agent: 'x' } } };
    let code = 'OK';
    try { t.join(forged as never); } catch (e) { code = (e as { code: string }).code; }
    expect(code).toBe('E_BAD_SIGNATURE');
  });
});
