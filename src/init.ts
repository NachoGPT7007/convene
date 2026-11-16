// Turning "I want a table with these people" into a config file, without hand-writing JSON or
// transcribing public keys. The address someone joins at is not in here: it is whatever `--url`
// says later, because a table lives at a loopback port, a tailnet address or a domain equally.
import { ByobError, type TableConfig, type TerminationCond } from './protocol.js';

export interface SeatSpec {
  /** The seat id this person will occupy. */
  seat: string;
  /** The owner's Ed25519 public key. Omitted when it comes from `owners` by owner id. */
  publicKey?: string;
  /** The owner id that key belongs to; several seats may share one owner. */
  owner: string;
  /** How this seat gets in: 'mcp', 'cli', 'http'… shown to every seat in the projection. */
  transport?: string;
}

/** An owner whose public key is known without a key file — what a participant sends you. */
export interface OwnerKey { owner: string; publicKey: string }

/**
 * co-create: everyone takes the floor in turn, and each decision opens the next round.
 * coordinate: the first seat dispatches, the rest are its reports — the assign-a-task shape.
 */
export type TableMode = 'co-create' | 'coordinate';

export interface InitOptions {
  id: string;
  topic: string;
  seats: SeatSpec[];
  /** Public keys collected from people who are not on this machine. */
  owners?: OwnerKey[];
  mode?: TableMode;
  rounds?: number;
  decisionBy?: string;
  budgetTokens?: number;
  maxBotDepth?: number;
  maxChars?: number;
}

export function buildTableConfig(o: InitOptions): TableConfig {
  if (!o.id) throw new ByobError('E_CONFIG', 'table id is required');
  if (!o.seats.length) throw new ByobError('E_CONFIG', 'at least one --seat <name>:<owner key file> is required');

  const seen = new Set<string>();
  for (const s of o.seats) {
    if (!s.seat) throw new ByobError('E_CONFIG', 'every seat needs a name');
    if (seen.has(s.seat)) throw new ByobError('E_CONFIG', `seat "${s.seat}" appears twice`);
    seen.add(s.seat);
  }

  // One entry per owner, however many seats that owner holds.
  const owners: TableConfig['owners'] = {};
  const supplied = new Map((o.owners ?? []).map(x => [x.owner, x.publicKey]));
  for (const s of o.seats) {
    if (!s.owner) throw new ByobError('E_CONFIG', `seat "${s.seat}": no owner id`);
    const publicKey = s.publicKey ?? supplied.get(s.owner);
    if (!publicKey) {
      throw new ByobError('E_CONFIG', `seat "${s.seat}": owner "${s.owner}" has no public key — pass --owner ${s.owner}:<base64>`);
    }
    const existing = owners[s.owner];
    if (existing && existing.public_key !== publicKey) {
      throw new ByobError('E_CONFIG', `owner "${s.owner}" is used with two different keys`);
    }
    owners[s.owner] = { public_key: publicKey };
  }
  // A key nobody seats is still an owner: they may join later with a seat the table already lists.
  for (const [owner, publicKey] of supplied) {
    if (!owners[owner]) owners[owner] = { public_key: publicKey };
  }

  const order = o.seats.map(s => s.seat);
  const rounds = o.rounds && o.rounds > 0 ? o.rounds : 3;
  const mode: TableMode = o.mode ?? 'co-create';
  const topology: TableConfig['topology'] = mode === 'coordinate'
    ? { kind: 'delegation', hub: order[0], reports: { [order[0]]: order.slice(1) }, rounds }
    : { kind: 'broadcast', order, rounds };
  // In a dispatched table the dispatcher decides; in a round table the first seat does.
  const decisionBy = o.decisionBy ?? order[0];

  const termination: TerminationCond[] = ['rounds_exhausted'];
  if (o.budgetTokens && o.budgetTokens > 0) termination.push({ budget_tokens: o.budgetTokens });

  return {
    id: o.id,
    topic: o.topic,
    owners,
    topology,
    floor: {
      max_chars: o.maxChars ?? 4000,
      max_bot_depth: o.maxBotDepth ?? 32,
      decision_by: [decisionBy],
    },
    termination: { any: termination },
    projection: { inline_limit: 2000 },
    watchdog: { heartbeat_ms: 300000 },
  };
}

/** Parse `alice:alice.owner.json` — the seat name is what people type, the file holds the key. */
export function parseSeatSpec(raw: string): { seat: string; keyFile: string } {
  // Split on the first colon: a path may legitimately contain more of them (`a:b.owner.json`).
  const i = raw.indexOf(':');
  if (i <= 0 || i === raw.length - 1) {
    throw new ByobError('E_CONFIG', `--seat expects <name>:<owner key file>, got "${raw}"`);
  }
  return { seat: raw.slice(0, i), keyFile: raw.slice(i + 1) };
}
