// Turning "I want a table with these people" into a config file, without hand-writing JSON or
// transcribing public keys. The address someone joins at is not in here: it is whatever `--url`
// says later, because a table lives at a loopback port, a tailnet address or a domain equally.
import { ByobError, type TableConfig, type TerminationCond } from './protocol.js';

export interface SeatSpec {
  /** The seat id this person will occupy. */
  seat: string;
  /** The owner's Ed25519 public key (from their key file). */
  publicKey: string;
  /** The owner id that key belongs to; several seats may share one owner. */
  owner: string;
}

export interface InitOptions {
  id: string;
  topic: string;
  seats: SeatSpec[];
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
  for (const s of o.seats) {
    if (!s.owner) throw new ByobError('E_CONFIG', `seat "${s.seat}": the owner key file has no id`);
    const existing = owners[s.owner];
    if (existing && existing.public_key !== s.publicKey) {
      throw new ByobError('E_CONFIG', `owner "${s.owner}" is used with two different keys`);
    }
    owners[s.owner] = { public_key: s.publicKey };
  }

  const order = o.seats.map(s => s.seat);
  const decisionBy = o.decisionBy ?? order[0];

  const termination: TerminationCond[] = ['rounds_exhausted'];
  if (o.budgetTokens && o.budgetTokens > 0) termination.push({ budget_tokens: o.budgetTokens });

  return {
    id: o.id,
    topic: o.topic,
    owners,
    topology: { kind: 'broadcast', order, rounds: o.rounds && o.rounds > 0 ? o.rounds : 3 },
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
