// Where a seat's daemon can be reached. A subscription is not a ledger entry: it changes delivery,
// never the table, so it lives in its own file and a restart must not lose it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PROTOCOL, type Entry } from './protocol.js';
import { wakeFor, wantsWake, type WakeKind } from './wake.js';

export interface Subscription {
  id: string;
  seat: string;
  url: string;
  /** Empty means every wake kind. */
  events: WakeKind[];
  /** Sent back as `x-convene-wake-token`, so a daemon on a shared network can refuse strangers. */
  token?: string;
  created_at: string;
}

export interface SubscribeInput { url: string; events?: WakeKind[]; token?: string }

const WAKE_KINDS: WakeKind[] = ['floor', 'task', 'dm', 'mention'];

/** One body per delivered entry: what the daemon needs, and nothing it could act on as a writer. */
export interface WakeBody {
  protocol: typeof PROTOCOL;
  table: string;
  seat: string;
  subscription: string;
  cursor: number;
  wakes: WakeKind[];
  entry: Record<string, unknown>;
  at: string;
}

function newId(): string { return 'sub_' + randomBytes(6).toString('hex'); }

export class SubscriptionRegistry {
  private byTable = new Map<string, Map<string, Subscription>>();

  constructor(readonly file: string | null) {
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, Subscription>>;
        for (const [table, subs] of Object.entries(raw)) this.byTable.set(table, new Map(Object.entries(subs)));
      } catch (err) {
        // A corrupt file must not keep the host from serving tables; subscriptions are re-registrable.
        console.warn(`convene: ignoring unreadable subscriptions file ${file}: ${(err as Error).message}`);
      }
    }
  }

  /** Re-registering the same seat at the same URL reuses the id, so a daemon restart does not pile up. */
  add(table: string, seat: string, input: SubscribeInput): Subscription {
    if (!/^https?:\/\//i.test(input.url)) throw new Error('subscription url must be http(s)');
    const events = (input.events ?? []).filter((k): k is WakeKind => WAKE_KINDS.includes(k));
    const existing = [...(this.byTable.get(table)?.values() ?? [])].find(s => s.seat === seat && s.url === input.url);
    const sub: Subscription = existing
      ? { ...existing, events, token: input.token }
      : { id: newId(), seat, url: input.url, events, token: input.token, created_at: new Date().toISOString() };
    const subs = this.byTable.get(table) ?? new Map<string, Subscription>();
    subs.set(sub.id, sub);
    this.byTable.set(table, subs);
    this.save();
    return sub;
  }

  remove(table: string, seat: string, id: string): boolean {
    const subs = this.byTable.get(table);
    const sub = subs?.get(id);
    // A seat can only withdraw its own subscription: the id alone is not a capability.
    if (!subs || !sub || sub.seat !== seat) return false;
    subs.delete(id);
    this.save();
    return true;
  }

  forTable(table: string): Subscription[] { return [...(this.byTable.get(table)?.values() ?? [])]; }

  private save(): void {
    if (!this.file) return;
    const out: Record<string, Record<string, Subscription>> = {};
    for (const [table, subs] of this.byTable) out[table] = Object.fromEntries(subs);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = join(dirname(this.file), `.subscriptions.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(out, null, 2));
    renameSync(tmp, this.file);
  }
}

/**
 * Deliver one entry to every subscription that should hear about it, off the write path. A slow or
 * dead receiver must never make a seat wait for the ledger, so failures are logged and dropped:
 * the daemon closes the gap by reading the projection once it is woken for another reason.
 */
export function deliverWake(table: string, entry: Entry, subscribers: Subscription[], now: () => string = () => new Date().toISOString()): void {
  for (const sub of subscribers) {
    const wakes = wakeFor(entry, sub.seat);
    if (!wakes.length || !wantsWake(sub.events, wakes)) continue;
    const body: WakeBody = {
      protocol: PROTOCOL,
      table,
      seat: sub.seat,
      subscription: sub.id,
      cursor: entry.seq,
      wakes,
      // Content is narrowed to what this seat may see, and to the fields a wake-up needs. The
      // daemon reads the projection for the rest, so a push is never a way around visibility.
      entry: {
        seq: entry.seq, kind: entry.kind, event: entry.event, seat: entry.seat,
        to: entry.to, task: entry.task, state: entry.state, status: undefined,
      },
      at: now(),
    };
    void postWake(sub, body);
  }
}

/** One POST per wake, with two retries. A 4xx is not retried: the receiver refused the shape. */
export async function postWake(sub: Subscription, body: WakeBody, attempts = 3): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(sub.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(sub.token ? { 'x-convene-wake-token': sub.token } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(1500),
      });
      if (r.ok) return true;
      if (r.status >= 400 && r.status < 500) {
        console.warn(`convene: wake for ${sub.seat} refused by ${sub.url} (HTTP ${r.status}); not retried`);
        return false;
      }
    } catch (err) {
      if (i === attempts - 1) console.warn(`convene: wake for ${sub.seat} failed: ${(err as Error).message}`);
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 200 * (i + 1)));
  }
  return false;
}
