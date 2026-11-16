import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { seatDirs, seatCandidates, findSeatFile, listSeatFiles } from '../src/seatfile.js';

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

function dataDirWith(seatName: string): string {
  const dir = tmp('sf-data-');
  mkdirSync(join(dir, 'seats'), { recursive: true });
  writeFileSync(join(dir, 'seats', `${seatName}.seat.json`), '{}');
  return dir;
}

describe('seat file lookup', () => {
  it('puts the data directories before the current directory for a bare name', () => {
    const dir = dataDirWith('shirley');
    const cands = seatCandidates('shirley', seatDirs(dir));
    const fromData = cands.indexOf(join(dir, 'seats', 'shirley.seat.json'));
    const fromCwd = cands.indexOf(resolve('shirley.seat.json'));
    expect(fromData).toBeGreaterThanOrEqual(0);
    if (fromCwd >= 0) expect(fromData).toBeLessThan(fromCwd);
  });

  it('honours a path with a separator first, then falls back to the data dirs', () => {
    const dir = dataDirWith('x');
    const cands = seatCandidates('seats/x.seat.json', seatDirs(dir));
    expect(cands[0]).toBe(resolve('seats/x.seat.json'));
    expect(cands).toContain(join(dir, 'seats', 'x.seat.json'));
  });

  it('accepts a name with or without the .seat.json suffix', () => {
    const dir = dataDirWith('tom');
    expect(findSeatFile('tom', seatDirs(dir))?.path).toBe(join(dir, 'seats', 'tom.seat.json'));
    expect(findSeatFile('tom.seat.json', seatDirs(dir))?.path).toBe(join(dir, 'seats', 'tom.seat.json'));
  });

  it('returns every path it tried when nothing matches', () => {
    const dir = dataDirWith('tom');
    const hit = findSeatFile('nobody', seatDirs(dir));
    expect(hit).toBeNull();
    expect(seatCandidates('nobody', seatDirs(dir)).length).toBeGreaterThan(1);
  });

  it('lists what is actually there, so the error can point somewhere', () => {
    const dir = dataDirWith('gladys');
    const found = listSeatFiles(seatDirs(dir));
    expect(found.some(p => p.endsWith('gladys.seat.json'))).toBe(true);
  });
});
