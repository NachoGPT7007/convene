// Inbox view for direct messages: a read-only pass over one projection's tail.
// The projection carries no wall clock by design, so ordering is by seq, never by time.
import type { Entry } from './protocol.js';

export interface DmItem {
  seq: number;
  from: string;
  to: string[];
  body: string;
  round?: number;
}

/** Every dm this seat may read: the ones it sent, and the ones addressed to it. */
export function collectDms(entries: Entry[], me: string): DmItem[] {
  return entries
    .filter(e => e.kind === 'dm' && (e.seat === me || (e.to ?? []).includes('@' + me)))
    .map(e => ({ seq: e.seq, from: e.seat, to: e.to ?? [], body: e.body ?? '', round: e.round }));
}

/** The other seat in this conversation. */
export function peerOf(dm: DmItem, me: string): string {
  if (dm.from !== me) return dm.from;
  const other = dm.to.find(a => a !== '@' + me) ?? '';
  return other.replace(/^@/, '') || '?';
}

export interface InboxFormat {
  text: string;
  maxSeq: number;
  newCount: number;
  total: number;
}

/**
 * Render the inbox. Peers are ordered by their latest message, newest group first; each group
 * stays in seq order. `←` is received, `→` is sent. Anything older than `lastSeen` is not new.
 */
export function formatInbox(o: { me: string; table: string; dms: DmItem[]; lastSeen: number; bodyLimit?: number }): InboxFormat {
  const limit = o.bodyLimit ?? 240;
  const maxSeq = o.dms.reduce((m, d) => Math.max(m, d.seq), 0);
  const head = `inbox for @${o.me} on ${o.table}`;
  if (!o.dms.length) return { text: `${head}: no direct messages`, maxSeq, newCount: 0, total: 0 };

  const groups = new Map<string, DmItem[]>();
  for (const d of o.dms) {
    const peer = peerOf(d, o.me);
    const list = groups.get(peer) ?? [];
    list.push(d);
    groups.set(peer, list);
  }
  for (const list of groups.values()) list.sort((a, b) => a.seq - b.seq);

  const order = [...groups.entries()].sort((a, b) => {
    const last = (l: DmItem[]) => l[l.length - 1].seq;
    return last(b[1]) - last(a[1]);
  });

  const isNew = (d: DmItem) => d.from !== o.me && d.seq > o.lastSeen;
  const newCount = o.dms.filter(isNew).length;
  const lines: string[] = [`${head} — ${o.dms.length} message${o.dms.length === 1 ? '' : 's'}, ${newCount} new`, ''];
  for (const [peer, list] of order) {
    lines.push(`@${peer} (${list.length})`);
    for (const d of list) {
      const sent = d.from === o.me;
      const body = d.body.length > limit ? d.body.slice(0, limit) + ' …' : d.body;
      const mark = isNew(d) ? 'new' : '   ';
      lines.push(`  #${String(d.seq).padEnd(4)} ${mark}  ${sent ? '→' : '←'} ${body}`);
    }
    lines.push('');
  }
  if (o.dms.some(d => d.body.length > limit)) lines.push(`(bodies longer than ${limit} chars are cut; \`convene read\` prints the entry in full)`);
  return { text: lines.join('\n').trimEnd(), maxSeq, newCount, total: o.dms.length };
}
