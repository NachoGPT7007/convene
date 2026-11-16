// What this machine already has: tables it hosts, owner public keys it holds, seat files it wrote.
// Only served to loopback: it is an operator view, not part of the protocol.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LocalTable { id: string; topic: string; status: string; seats: string[] }
export interface LocalOwner { id: string; publicKey: string; file: string }
export interface LocalSeat { table: string; seat: string; token: string; file: string; url?: string }
export interface LocalState { dataDir: string; tables: LocalTable[]; owners: LocalOwner[]; seats: LocalSeat[] }

/** The bits of a live Table this scan needs, so local.ts does not import Table Core. */
export interface LiveTableLike { cfg: { topic: string }; status: string; seats: Map<string, unknown> }

const readJson = (file: string): Record<string, unknown> | null => {
  try { return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { return null; }
};

const listDir = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);

/**
 * Tables come from the running host (it loads every table in the data dir on boot), keys and seats
 * from the conventional `keys/` and `seats/` subdirectories.
 *
 * A private key is never read into the result: the owner entry carries only id and public key.
 */
export function scanLocal(dataDir: string, live: Map<string, LiveTableLike>): LocalState {
  const tables: LocalTable[] = [...live].map(([id, t]) => ({
    id,
    topic: t.cfg.topic,
    status: t.status,
    seats: [...t.seats.keys()].sort(),
  })).sort((a, b) => a.id.localeCompare(b.id));

  const owners: LocalOwner[] = [];
  for (const file of listDir(join(dataDir, 'keys'))) {
    if (!file.endsWith('.json')) continue;
    const j = readJson(join(dataDir, 'keys', file));
    if (!j || typeof j.id !== 'string' || typeof j.publicKey !== 'string') continue;
    owners.push({ id: j.id, publicKey: j.publicKey, file: join(dataDir, 'keys', file) });
  }
  owners.sort((a, b) => a.id.localeCompare(b.id));

  const seats: LocalSeat[] = [];
  for (const file of listDir(join(dataDir, 'seats'))) {
    if (!file.endsWith('.json')) continue;
    const j = readJson(join(dataDir, 'seats', file));
    if (!j || typeof j.seat !== 'string' || typeof j.token !== 'string') continue;
    seats.push({
      table: String(j.table ?? ''),
      seat: j.seat,
      token: j.token,
      file: join(dataDir, 'seats', file),
      url: typeof j.url === 'string' ? j.url : undefined,
    });
  }
  seats.sort((a, b) => (a.table + a.seat).localeCompare(b.table + b.seat));

  return { dataDir, tables, owners, seats };
}

/** A request from this machine only. Anything proxied in from outside is not loopback. */
export function isLoopback(remoteAddress: string | undefined): boolean {
  const ip = remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
