// The MVP scenario from the design, section 9: three seats on 127.0.0.1, two rounds of a
// round table, one direct message in the middle. Four seats in total: three bots and the
// human administrator who signed `read_dm_all` into its own card.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { TableHost } from '../src/host.js';
import { JsonlStore } from '../src/store.js';
import { createTableServer } from '../src/server.js';
import { SeatClient, createTable, type Owner } from '../src/client.js';
import { cfg, owners } from './helpers.js';
import type { ByobError, CapabilityCard } from '../src/protocol.js';

const talkCard: CapabilityCard = { bot: 'scripted', capabilities: [] };
const humanCard: CapabilityCard = { bot: 'human', capabilities: [], grants: { read_dm_all: true } };

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function start() {
  const host = new TableHost(new JsonlStore(mkdtempSync(join(tmpdir(), 'byob-e2e-'))));
  const server = createTableServer(host, { tickMs: 50 });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { host, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('MVP scenario (design section 9)', () => {
  it('runs two rounds with a dm between them, then reports what each seat can read', async () => {
    const { host, url } = await start();
    await createTable(url, cfg('mvp', { kind: 'broadcast', order: ['alice', 'bob', 'carol'], rounds: 2 }, {
      termination: { any: ['rounds_exhausted'] },
      floor: { decision_by: ['alice'] },
    }));
    const alice = await SeatClient.join(url, 'mvp', owners.tao, { seat: 'alice', card: talkCard });
    const bob = await SeatClient.join(url, 'mvp', owners.jenny, { seat: 'bob', card: talkCard });
    const carol = await SeatClient.join(url, 'mvp', owners.ops, { seat: 'carol', card: talkCard });
    const admin = await SeatClient.join(url, 'mvp', owners.ops, { seat: 'admin', kind: 'human', card: humanCard });
    const seats: Record<string, SeatClient> = { alice, bob, carol };

    // Drive the table the way a seat daemon would: read the projection, act when the floor is ours.
    let dmSeq = 0;
    let sentDm = false;
    let aliceTurns = 0;
    const roundsSeen = new Set<number>();
    for (let step = 0; step < 40; step++) {
      const p = await alice.projection(0);
      if (p.status === 'closed') break;
      const holder = p.floor.holder;
      expect(holder).toBeTruthy();
      roundsSeen.add(p.floor.round);
      // Between round 1 and round 2, bob sends alice a direct message out of turn.
      if (p.floor.round >= 1 && !sentDm) {
        dmSeq = (await bob.post({ kind: 'dm', to: ['@alice'], body: 'before round two: I disagree with the first decision' })).seq;
        sentDm = true;
        continue;
      }
      const me = seats[holder!];
      // Alice holds the floor at the start of each round; she closes round 1 with a decision,
      // which is the only thing that moves `round` from 0 to 1.
      if (holder === 'alice') {
        aliceTurns += 1;
        if (aliceTurns === 2) await alice.post({ kind: 'decision', body: 'round two: adopt bob\'s objection' });
        else await me.say(`${holder} speaking in round ${p.floor.round + 1}`);
        continue;
      }
      await me.say(`${holder} speaking in round ${p.floor.round + 1}`);
    }

    const ledger = host.get('mvp');
    expect(ledger.status).toBe('closed');
    expect(ledger.closeReason).toBe('rounds_exhausted');
    // A1: one decision landed, and the round counter moved on.
    expect(ledger.entries.filter(e => e.kind === 'decision')).toHaveLength(1);
    expect([...roundsSeen].sort()).toEqual([0, 1]);
    expect(ledger.entries.filter(e => e.round === 1).length).toBeGreaterThan(0);
    expect(ledger.entries.find(e => e.kind === 'decision')!.round).toBe(0);

    // The dm is on the ledger, between the two rounds.
    expect(dmSeq).toBeGreaterThan(0);
    const dm = ledger.entries.find(e => e.seq === dmSeq)!;
    expect(dm).toMatchObject({ kind: 'dm', seat: 'bob', to: ['@alice'], round: 1 });

    // A2: a third seat reads 404 E_NOT_FOUND, and cannot see it in a projection either.
    const third = await carol.expand(dmSeq).then(() => null, (err: ByobError) => err);
    expect(third?.code).toBe('E_NOT_FOUND');
    expect(third?.status).toBe(404);
    expect((await carol.projection(0)).tail.some(e => e.kind === 'dm')).toBe(false);

    // A3: the recipient and the human administrator read the body.
    expect((await alice.expand(dmSeq)).body).toMatch(/before round two/);
    expect((await admin.expand(dmSeq)).body).toMatch(/before round two/);
    expect((await admin.projection(0)).tail.some(e => e.kind === 'dm')).toBe(true);

    // A4: after close the discussion plane is shut, the work plane is not (no tasks here, so the
    // contract is simply that say is refused and reads still work).
    const late = await carol.say('hello?').then(() => null, (err: ByobError) => err);
    expect(late?.code).toBe('E_TABLE_CLOSED');
    expect((await carol.projection(0)).status).toBe('closed');
  }, 20000);
});
