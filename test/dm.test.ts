// convene MVP (design section 9): a direct-message channel that lives on the ledger but is
// filtered server-side, plus a round counter stamped by Table Core.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Table } from '../src/table.js';
import { TableHost } from '../src/host.js';
import { JsonlStore } from '../src/store.js';
import { createTableServer } from '../src/server.js';
import { SeatClient, createTable } from '../src/client.js';
import { cfg, seat, owners, boardCard, talkCard } from './helpers.js';
import { check } from '../src/schema.js';
import type { ByobError, CapabilityCard, Entry } from '../src/protocol.js';

const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { code: string }).code; } return 'OK'; };

const humanCard: CapabilityCard = { bot: 'human', capabilities: [], grants: { read_dm_all: true } };
/** A plain talk-only card: no grants block at all, exactly what an old client sends. */
const legacyCard: CapabilityCard = { bot: 'legacy-client', capabilities: [] };

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function start() {
  const host = new TableHost(new JsonlStore(mkdtempSync(join(tmpdir(), 'byob-dm-'))));
  const server = createTableServer(host, { tickMs: 50 });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { host, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const dmTable = (id: string, extra = {}) => new Table(cfg(id, { kind: 'broadcast', order: ['a', 'b'], rounds: 3 }, { termination: { any: ['rounds_exhausted'] }, ...extra }));

describe('round (extension 5.5)', () => {
  it('stamps the decisions landed so far: a decision belongs to the round it ends, later entries open the next', () => {
    const t = new Table(cfg('rd', { kind: 'broadcast', order: ['a', 'b'], rounds: 3 }, { termination: { any: ['rounds_exhausted'] }, floor: { decision_by: ['a'] } }));
    seat(t, 'a', 'tao'); seat(t, 'b', 'jenny');
    expect(t.projection('a', 0).floor.round).toBe(0);

    const s1 = t.post('a', { kind: 'say', body: 'round one, a' });
    const s2 = t.post('b', { kind: 'say', body: 'round one, b' });
    const d1 = t.post('a', { kind: 'decision', body: 'round one decided' });
    // The first three turns all belong to round 1, which this code numbers 0.
    expect([s1.round, s2.round, d1.round]).toEqual([0, 0, 0]);
    // Once the decision lands, the table is in its second round.
    expect(t.projection('b', 0).floor.round).toBe(1);
    const s3 = t.post('b', { kind: 'say', body: 'round two, b' });
    expect(s3.round).toBe(1);
    for (const e of t.entries) { check('ledger-entry', e); expect(typeof e.round).toBe('number'); }
  });

  it('rebuilds the same rounds by replaying a ledger written by an older version without `round`', () => {
    const t1 = new Table(cfg('rp', { kind: 'broadcast', order: ['a', 'b'], rounds: 3 }, { termination: { any: ['rounds_exhausted'] }, floor: { decision_by: ['a'] } }));
    seat(t1, 'a', 'tao'); seat(t1, 'b', 'jenny');
    t1.post('a', { kind: 'say', body: 'x' });
    t1.post('b', { kind: 'say', body: 'y' });
    t1.post('a', { kind: 'decision', body: 'd' });
    t1.post('b', { kind: 'say', body: 'z' });
    // An old ledger has no round field: strip it, as a pre-extension writer would have.
    const snapshot = (JSON.parse(JSON.stringify(t1.entries)) as Entry[]).map(({ round: _r, ...e }) => e as Entry);
    const t2 = new Table(cfg('rp', { kind: 'broadcast', order: ['a', 'b'], rounds: 3 }, { termination: { any: ['rounds_exhausted'] }, floor: { decision_by: ['a'] } }), undefined, snapshot);
    expect(t2.roundNo).toBe(t1.roundNo);
    expect(t2.projection('a', 0).tail.map(e => e.round)).toEqual(t1.projection('a', 0).tail.map(e => e.round));
  });
});

describe('dm visibility (extension 5.4)', () => {
  it('is visible to sender, recipients and read_dm_all seats only; a third seat gets E_NOT_FOUND', () => {
    const t = dmTable('dmv');
    seat(t, 'a', 'tao'); seat(t, 'b', 'jenny');
    seat(t, 'c', 'ops', talkCard);
    seat(t, 'h', 'ops', humanCard, 'human');

    const e = t.post('b', { kind: 'dm', to: ['@a'], body: 'psst, only for you' });
    expect(e.kind).toBe('dm');
    check('ledger-entry', e);
    // b was not the floor holder: a dm needs no floor.
    expect(t.holder).toBe('a');
    expect(t.canSee(e, 'b')).toBe(true);  // sender
    expect(t.canSee(e, 'a')).toBe(true);  // recipient
    expect(t.canSee(e, 'h')).toBe(true);  // signed read_dm_all
    expect(t.canSee(e, 'c')).toBe(false); // third seat
    expect(codeOf(() => t.expand('c', e.seq))).toBe('E_NOT_FOUND');
    expect(t.expand('a', e.seq).body).toBe('psst, only for you');
    expect(t.projection('c', 0).tail.some(x => x.kind === 'dm')).toBe(false);
    expect(t.projection('h', 0).tail.some(x => x.kind === 'dm')).toBe(true);
  });

  it('is not exposed by a `visibility: ["*.*"]` override: that pattern opens the floor plane, not private channels', () => {
    const t = dmTable('dmvis', { visibility: { c: ['*.*'] } });
    seat(t, 'a', 'tao'); seat(t, 'b', 'jenny'); seat(t, 'c', 'ops', talkCard);
    t.post('a', { kind: 'say', body: 'on the floor' });
    const e = t.post('b', { kind: 'dm', to: ['@a'], body: 'off the record' });
    // c sees every floor-plane entry through the override, but still not the dm.
    expect(t.projection('c', 0).tail.some(x => x.kind === 'say')).toBe(true);
    expect(t.projection('c', 0).tail.some(x => x.kind === 'dm')).toBe(false);
    expect(codeOf(() => t.expand('c', e.seq))).toBe('E_NOT_FOUND');
  });

  it('stays invisible to a client that sends no grants at all (old clients keep working)', () => {
    const t = dmTable('dmlegacy');
    seat(t, 'a', 'tao', legacyCard); seat(t, 'b', 'jenny', legacyCard);
    const e = t.post('a', { kind: 'dm', to: ['@b'], body: 'new feature' });
    expect(t.projection('a', 0).tail.some(x => x.kind === 'dm')).toBe(true);
    expect(codeOf(() => t.expand('c', e.seq))).toBe('E_NOT_FOUND'); // no such seat at all
  });

  it('is point to point: no recipients, an unknown seat, `*` or a role address are all refused', () => {
    const t = dmTable('dmbad');
    seat(t, 'a', 'tao'); seat(t, 'b', 'jenny');
    expect(codeOf(() => t.post('a', { kind: 'dm', body: 'nobody' }))).toBe('E_SCHEMA');
    expect(codeOf(() => t.post('a', { kind: 'dm', to: ['@nobody'], body: 'x' }))).toBe('E_ADDRESS');
    expect(codeOf(() => t.post('a', { kind: 'dm', to: ['*'], body: 'x' }))).toBe('E_ADDRESS');
    expect(codeOf(() => t.post('a', { kind: 'dm', to: ['role:judge'], body: 'x' }))).toBe('E_ADDRESS');
    expect(codeOf(() => t.post('a', { kind: 'dm', to: ['@b'] }))).toBe('E_SCHEMA'); // no body
  });
});

describe('dm rate limit', () => {
  it('allows a burst of 5 per pair, then 1 per 2 minutes, and refuses a repeat within 10 minutes', () => {
    let now = 1_000_000;
    const t = new Table(cfg('dmr', { kind: 'broadcast', order: ['a', 'b'], rounds: 3 }), undefined, undefined, () => now);
    seat(t, 'a', 'tao'); seat(t, 'b', 'jenny');
    for (let i = 0; i < 5; i++) t.post('a', { kind: 'dm', to: ['@b'], body: `burst ${i}` });
    expect(codeOf(() => t.post('a', { kind: 'dm', to: ['@b'], body: 'burst 5' }))).toBe('E_DM_RATE_LIMIT');
    // Two minutes later one token is back.
    now += 120_000;
    expect(() => t.post('a', { kind: 'dm', to: ['@b'], body: 'burst 5' })).not.toThrow();
    // The same body again, inside the 10-minute repeat window, is refused even though a token exists.
    now += 120_000;
    expect(codeOf(() => t.post('a', { kind: 'dm', to: ['@b'], body: 'burst 5' }))).toBe('E_DM_DUPLICATE');
    // A different pair has its own budget.
    expect(() => t.post('b', { kind: 'dm', to: ['@a'], body: 'reply' })).not.toThrow();
  });
});

describe('work plane outlives the discussion plane (A4)', () => {
  it('after close, say is refused while verify is still accepted', () => {
    const t = new Table(cfg('wp', { kind: 'broadcast', order: ['p', 'q'], rounds: 3 }));
    seat(t, 'p', 'tao', boardCard); seat(t, 'q', 'jenny', boardCard); seat(t, 'chk', 'ops', talkCard);
    const pr = t.post('p', { kind: 'proposal', body: 'reorder', effects: [{ owner: 'jenny', resource: 'taskboard', action: 'reorder' }] });
    const id = `task-${pr.seq}`;
    t.ownerDecision(owners.jenny.signDecision('wp', id, 'approve', 'ok') as never);
    t.post('q', { kind: 'receipt', task: id, body: 'reordered', artifact: { board: ['#461'] } });
    expect(t.task(id).state).toBe('reported');

    t.close('admin closed the meeting');
    expect(codeOf(() => t.post('p', { kind: 'say', body: 'late' }))).toBe('E_TABLE_CLOSED');
    expect(codeOf(() => t.post('a', { kind: 'dm', to: ['@b'], body: 'late' }))).toBe('E_NOT_FOUND'); // no such seat
    // The work plane stays open so the table can still settle its tasks.
    t.post('chk', { kind: 'verify', task: id, result: 'pass', body: 'board top is #461' });
    expect(t.task(id).state).toBe('verified');
  });
});

describe('dm over HTTP (A2 / A3)', () => {
  it('a third seat reads 404 E_NOT_FOUND; the recipient and the read_dm_all human read the body', async () => {
    const { url } = await start();
    await createTable(url, cfg('dmhttp', { kind: 'broadcast', order: ['a', 'b'], rounds: 2 }, { termination: { any: ['rounds_exhausted'] } }));
    const a = await SeatClient.join(url, 'dmhttp', owners.tao, { seat: 'a', card: legacyCard });
    const b = await SeatClient.join(url, 'dmhttp', owners.jenny, { seat: 'b', card: legacyCard });
    const c = await SeatClient.join(url, 'dmhttp', owners.ops, { seat: 'c', card: legacyCard });
    const h = await SeatClient.join(url, 'dmhttp', owners.ops, { seat: 'h', kind: 'human', card: humanCard });

    const e = await b.post({ kind: 'dm', to: ['@a'], body: 'off the record' });
    const third = await c.expand(e.seq).then(() => null, (err: ByobError) => err);
    expect(third?.code).toBe('E_NOT_FOUND');
    expect(third?.status).toBe(404);
    expect((await a.expand(e.seq)).body).toBe('off the record');
    expect((await h.expand(e.seq)).body).toBe('off the record');

    // The recipient's own projection carries it; the third seat's does not.
    expect((await a.projection(0)).tail.some(x => x.kind === 'dm')).toBe(true);
    expect((await c.projection(0)).tail.some(x => x.kind === 'dm')).toBe(false);
    expect((await c.projection(0)).floor.round).toBe(0);
  });
});
