import { describe, it, expect } from 'vitest';
import { collectDms, formatInbox, peerOf } from '../src/inbox.js';
import type { Entry } from '../src/protocol.js';

const dm = (seq: number, seat: string, to: string[], body: string, round = 0) =>
  ({ seq, table: 't', seat, kind: 'dm', to, body, round }) as Entry;

describe('dm inbox', () => {
  it('collects only the dms this seat can read, from both directions', () => {
    const entries: Entry[] = [
      { seq: 1, table: 't', seat: 'core', kind: 'system', event: 'table_opened' },
      { seq: 2, table: 't', seat: 'alice', kind: 'say', body: 'on the floor' },
      dm(3, 'bob', ['@alice'], 'for alice'),
      dm(4, 'bob', ['@carol'], 'not for alice'),
      dm(5, 'alice', ['@bob'], 'reply from alice'),
    ];
    expect(collectDms(entries, 'alice').map(d => d.seq)).toEqual([3, 5]);
    expect(collectDms(entries, 'carol').map(d => d.seq)).toEqual([4]);
  });

  it('names the other party and keeps direction straight', () => {
    const incoming = { seq: 3, from: 'bob', to: ['@alice'], body: 'x' };
    const outgoing = { seq: 5, from: 'alice', to: ['@bob'], body: 'y' };
    expect(peerOf(incoming, 'alice')).toBe('bob');
    expect(peerOf(outgoing, 'alice')).toBe('bob');
    // A dm to several seats still groups under the first non-self peer, never under '?'.
    expect(peerOf({ seq: 6, from: 'alice', to: ['@bob', '@carol'], body: 'z' }, 'alice')).toBe('bob');
  });

  it('groups by peer, orders by latest message, and marks only what is newer than the last visit', () => {
    const entries: Entry[] = [
      dm(2, 'bob', ['@alice'], 'old question'),
      dm(4, 'alice', ['@bob'], 'old answer'),
      dm(7, 'carol', ['@alice'], 'a newer one'),
    ];
    const r = formatInbox({ me: 'alice', table: 't', dms: collectDms(entries, 'alice'), lastSeen: 4 });
    expect(r.total).toBe(3);
    expect(r.newCount).toBe(1);
    expect(r.maxSeq).toBe(7);
    // Carol's conversation is newest, so it comes first.
    expect(r.text.indexOf('@carol')).toBeLessThan(r.text.indexOf('@bob'));
    expect(r.text).toMatch(/← old question/);
    expect(r.text).toMatch(/→ old answer/);
    // Only carol's message carries the `new` mark (the header line says "1 new" too).
    const newLines = r.text.split('\n').filter(l => /#\d+\s+new\s/.test(l));
    expect(newLines).toHaveLength(1);
    expect(newLines[0]).toMatch(/a newer one/);
  });

  it('never marks a message this seat sent itself as unread', () => {
    const entries: Entry[] = [
      dm(2, 'bob', ['@alice'], 'incoming'),
      dm(3, 'alice', ['@bob'], 'my own reply'),
    ];
    const r = formatInbox({ me: 'alice', table: 't', dms: collectDms(entries, 'alice'), lastSeen: 0 });
    expect(r.newCount).toBe(1); // the incoming one only
    const marked = r.text.split('\n').filter(l => /#\d+\s+new\s/.test(l));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatch(/incoming/);
    // Nothing is lost from the view: the seat's own message is still listed.
    expect(r.text).toMatch(/my own reply/);
  });

  it('says so when the inbox is empty, and cuts very long bodies with a pointer to read', () => {
    expect(formatInbox({ me: 'alice', table: 't', dms: [], lastSeen: 0 }).text).toBe('inbox for @alice on t: no direct messages');

    const long = 'L'.repeat(500);
    const r = formatInbox({ me: 'alice', table: 't', dms: collectDms([dm(9, 'bob', ['@alice'], long)], 'alice'), lastSeen: 0, bodyLimit: 40 });
    expect(r.text).toMatch(/L{40} …/);
    expect(r.text).toMatch(/convene read/);
  });
});
