// The /api shape is a projection of our table, not a second application: these tests pin the fields
// Rabbit Hole's client actually reads.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TableHost } from '../src/host.js';
import { JsonlStore } from '../src/store.js';
import { meetingRows, meetingSnapshot } from '../src/meeting-snapshot.js';
import { cfg, owners, talkCard } from './helpers.js';

function start() {
  const host = new TableHost(new JsonlStore(mkdtempSync(join(tmpdir(), 'byob-api-'))));
  host.create(cfg('main', { kind: 'broadcast', order: ['alice', 'bob'] }, { topic: '会议视图' }));
  const alice = host.join('main', owners.jenny.signJoin('main', { seat: 'alice', kind: 'human', card: talkCard }) as never);
  host.join('main', owners.tao.signJoin('main', { seat: 'bob', kind: 'bot', card: talkCard }) as never);
  return { host, alice };
}

describe('meeting snapshot', () => {
  it('lists the table with the fields the client reads', () => {
    const { host } = start();
    const rows = meetingRows(host);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'main', topic: '会议视图', status: 'open', seats: 2 });
    expect(rows[0].seq).toBeGreaterThan(0);
    expect(rows[0].pending).toBe(0);
  });

  it('gives the room everything the client renders, and no invented turns', () => {
    const { host } = start();
    host.get('main').post('alice', { kind: 'say', body: '第一轮' });
    const snap = meetingSnapshot(host, 'main')!;
    expect(snap).toMatchObject({ id: 'main', status: 'open', holder: 'bob' });
    expect(snap.seats).toHaveLength(2);
    // Our attendance extension rides along; the client ignores what it does not know.
    const aliceSeat = (snap.seats as { seat: string; attendance?: string | null }[]).find(s => s.seat === 'alice');
    expect(aliceSeat?.attendance).toBe('present');
    // The client re-reads this after every SSE event, so it must contain the whole visible record.
    expect(snap.entries.some(e => e.kind === 'say' && e.body === '第一轮')).toBe(true);
    expect(snap.turns).toEqual([]);
    expect(snap.tasks).toEqual([]);
    expect(snap.hands).toEqual([]);
  });

  it('returns null for a table that does not exist', () => {
    const { host } = start();
    expect(meetingSnapshot(host, 'nope')).toBeNull();
  });
});
