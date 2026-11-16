// Finding a seat file by the name a person actually types: "alice", "alice.seat.json",
// "seats/alice.seat.json" — wherever the data directory happens to be.
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';

/** Directories worth looking in, most specific first. */
export function seatDirs(dataDir?: string): string[] {
  const dirs: string[] = [];
  const add = (d: string | undefined) => { if (d) dirs.push(resolve(d)); };
  if (dataDir) { add(join(dataDir, 'seats')); add(dataDir); }
  add(join(homedir(), 'convene-data', 'seats'));
  add(join(homedir(), 'convene-data'));
  add('./seats');
  return [...new Set(dirs)];
}

/**
 * Every path this input could mean, in the order they should be tried.
 *
 * A bare name ("alice") means the data directories first: a stray `alice.seat.json` in whatever
 * directory you happen to be standing in is more likely a leftover than the seat you want. A path
 * with a separator is honoured first, then falls back to the same search.
 */
export function seatCandidates(input: string, dirs: string[]): string[] {
  const out: string[] = [];
  const add = (p: string) => { if (p) out.push(p); };
  const withExt = input.endsWith('.json') ? input : `${input}.seat.json`;
  const name = basename(withExt);
  const explicit = input.includes('/') || input.includes('\\');

  if (explicit) {
    add(resolve(input));
    add(resolve(withExt));
  }
  for (const dir of dirs) add(join(dir, name));
  if (!explicit) {
    add(resolve(input));
    add(resolve(withExt));
  }
  return [...new Set(out)];
}

export interface FoundSeat { path: string; tried: string[] }

/**
 * The first candidate that exists. When none does, the caller gets every path that was tried
 * plus a listing of what is actually there — an ENOENT with no context is a dead end.
 */
export function findSeatFile(input: string, dirs: string[]): FoundSeat | null {
  const tried = seatCandidates(input, dirs);
  const hit = tried.find(p => existsSync(p));
  return hit ? { path: hit, tried } : null;
}

/** The seat files that do exist, for an error message that can be acted on. */
export function listSeatFiles(dirs: string[]): string[] {
  const found: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.seat.json')) found.push(join(dir, f));
    }
  }
  return [...new Set(found)];
}
