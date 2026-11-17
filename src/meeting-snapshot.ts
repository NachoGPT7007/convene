// The shape Rabbit Hole's client expects, built from our own table. A pure projection of what is
// already on the ledger: no new writes, no second application layer, no owner key.
import type { Entry, Projection } from './protocol.js';
import type { Table } from './table.js';
import type { TableHost } from './host.js';

/** One row of the meeting list (client/index.html renders exactly these fields). */
export interface MeetingRow {
  id: string;
  topic: string;
  status: 'open' | 'closed';
  closeReason: string | null;
  parent: string | null;
  seats: number;
  seq: number;
  lastTs: string | null;
  pending: number;
}

export interface Snapshot {
  id: string; topic: string; status: 'open' | 'closed'; closeReason: string | null;
  topology: unknown; deciders: string[]; parent: string | null; children: unknown[];
  holder: string | null; grantSeq: number | null; tokens: number; budget: number | null;
  createdAt: number | null; closedAt: string | null; hands: string[];
  seats: unknown[]; waitingFor: string[]; entries: Entry[]; tasks: unknown[]; turns: unknown[];
}

function lastEntry(entries: Entry[], fn: (e: Entry) => boolean): Entry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) if (fn(entries[i])) return entries[i];
  return undefined;
}

/** A viewer only matters for direct messages; the meeting view does not show them, so any seat works. */
function viewerFor(t: Table): string {
  const human = [...t.seats.values()].find(s => s.kind === 'human');
  return human?.seat ?? [...t.seats.values()][0]?.seat ?? '';
}

export function meetingRows(host: TableHost): MeetingRow[] {
  return [...host.tables.values()].map(t => {
    const opened = lastEntry(t.entries, e => e.event === 'table_opened');
    const last = t.entries[t.entries.length - 1];
    const closed = lastEntry(t.entries, e => e.event === 'table_closed');
    return {
      id: t.cfg.id,
      topic: t.cfg.topic,
      status: t.status,
      closeReason: t.closeReason ?? null,
      parent: t.cfg.parent ?? null,
      seats: t.seats.size,
      seq: t.entries.length,
      lastTs: last?.ts ?? opened?.ts ?? null,
      pending: [...t.tasks.values()].filter(x => x.state === 'awaiting_approval').length,
    };
  }).sort((a, b) => String(b.lastTs ?? '').localeCompare(String(a.lastTs ?? '')));
}

/**
 * What the client renders. `entries` is the full visible tail (since 0), not the seat's incremental
 * cursor: the meeting view is a record, not an inbox.
 */
export function meetingSnapshot(host: TableHost, id: string): Snapshot | null {
  const t = host.tables.get(id);
  if (!t) return null;
  const viewer = viewerFor(t);
  const projection: Projection | null = viewer ? t.projection(viewer, 0) : null;
  // Direct messages never enter the meeting record. The viewer is whichever seat is first, so
  // showing dm here would leak private traffic to anyone who can open the page.
  const entries = (projection?.tail ?? []).filter(e => e.kind !== 'dm');
  const opened = lastEntry(t.entries, e => e.event === 'table_opened');
  const closed = lastEntry(t.entries, e => e.event === 'table_closed');
  const budgetCond = t.cfg.termination.any.find(c => typeof c === 'object' && 'budget_tokens' in c) as { budget_tokens: number } | undefined;
  type PrefixSeat = {
    seat: string; owner: string; role?: string; bot?: string; proxy?: boolean;
    capabilities: unknown[]; attendance?: string | null;
  };
  const seats = (projection?.prefix.seats ?? []) as PrefixSeat[];
  return {
    id: t.cfg.id,
    topic: t.cfg.topic,
    status: t.status,
    closeReason: t.closeReason ?? null,
    topology: t.cfg.topology,
    deciders: t.deciders,
    parent: t.cfg.parent ?? null,
    children: [],
    holder: t.holder,
    grantSeq: t.grantSeq,
    tokens: t.tokens,
    budget: budgetCond?.budget_tokens ?? null,
    createdAt: opened?.ts ? Date.parse(opened.ts) : null,
    closedAt: closed?.ts ?? null,
    hands: (t.pstate.queue ?? []) as string[],
    seats: seats.map(s => ({
      seat: s.seat, owner: s.owner, role: s.role ?? null, joined: true, managed: false,
      persona: null, bot: s.bot, proxy: !!s.proxy, model: null,
      capabilities: s.capabilities,
      // Our extension: the page marks a managed human; the client ignores unknown fields harmlessly.
      attendance: s.attendance ?? null,
    })),
    waitingFor: t.policy.required().filter(s => !t.seats.has(s)),
    entries,
    tasks: [...t.tasks.values()].map(x => ({
      id: x.id, state: x.state, executor: x.executor, owner: x.owner, effects: x.effects,
      proposer: x.proposer, plannedExecutor: null, why: null,
    })),
    // No agent turns: the table does not run models, so nothing is streaming. The view falls back
    // to the last speech it has, which is the honest answer.
    turns: [],
  };
}
