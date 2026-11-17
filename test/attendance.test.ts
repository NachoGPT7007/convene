// Managed seats, turn deadlines and task hand-off: the three rules that make "away" mean something.
import { describe, it, expect } from 'vitest';
import { Table } from '../src/table.js';
import { cfg, owners, talkCard, boardCard } from './helpers.js';
import type { TableConfig } from '../src/protocol.js';

/** A table whose clock we control, so a deadline is testable without waiting. */
function make(extra: Partial<TableConfig> = {}, start = 1_000_000) {
  const clock = { now: start };
  const t = new Table(cfg('t', { kind: 'broadcast', order: ['a1', 'a2', 'h'] }, extra), undefined, undefined, () => clock.now);
  return { t, clock };
}

function joinAll(t: Table) {
  // Two bots of one owner (proposer + executor) and one human, so ownership stays single-owner.
  const a1 = t.join(owners.tao.signJoin('t', { seat: 'a1', kind: 'bot', card: talkCard }) as never);
  const a2 = t.join(owners.tao.signJoin('t', { seat: 'a2', kind: 'bot', card: boardCard }) as never);
  const h = t.join(owners.jenny.signJoin('t', { seat: 'h', kind: 'human', card: talkCard }) as never);
  return { a1, a2, h };
}

describe('attendance', () => {
  it('lets a human go away and come back, and a replay agrees', () => {
    const { t } = make();
    joinAll(t);
    t.setAttendance('h', 'away');
    const seats = () => t.projection('h').prefix.seats as { seat: string; attendance?: string }[];
    expect(seats().find(s => s.seat === 'h')).toMatchObject({ attendance: 'away' });
    t.setAttendance('h', 'present');
    expect(t.canVote('h')).toBe(true);

    // Replay is the source of truth: the last attendance entry decides, not the live object.
    const again = new Table(t.cfg, undefined, t.entries, () => 1_000_000);
    expect((again.projection('h').prefix.seats as { seat: string; attendance?: string }[]).find(s => s.seat === 'h'))
      .toMatchObject({ attendance: 'present' });
  });

  it('refuses to give a bot an attendance, or a human a nonsense value', () => {
    const { t } = make();
    joinAll(t);
    expect(() => t.setAttendance('a1', 'away')).toThrow(/bot seat/);
    expect(() => t.setAttendance('h', 'sleeping' as never)).toThrow(/present or away/);
  });

  it('counts only a present human as able to vote', () => {
    const { t } = make();
    joinAll(t);
    expect(t.canVote('h')).toBe(true);
    t.setAttendance('h', 'away');
    expect(t.canVote('h')).toBe(false);
    expect(t.canVote('a1')).toBe(false);
  });
});

describe('turn deadline', () => {
  it('writes a pass and moves on when the holder stays silent', () => {
    const { t, clock } = make({ floor: { turn_ms: 1000 } });
    joinAll(t);
    expect(t.holder).toBe('a1');
    clock.now += 1100;
    t.tick();
    const skip = t.entries.find(e => e.kind === 'pass' && (e.data as { skipped?: boolean })?.skipped);
    expect(skip).toBeTruthy();
    expect(skip?.seat).toBe('a1');
    expect(t.holder).toBe('a2');
  });

  it('does not skip when no turn_ms is configured', () => {
    const { t, clock } = make();
    joinAll(t);
    clock.now += 10_000_000;
    t.tick();
    expect(t.entries.some(e => e.kind === 'pass')).toBe(false);
    expect(t.holder).toBe('a1');
  });
});

describe('task hand-off', () => {
  function approvedTask(t: Table) {
    // a1 proposes, the table picks a2 (same owner, the only bot declaring taskboard:reorder).
    t.post('a1', { kind: 'proposal', body: 'reorder', effects: [{ owner: 'tao', resource: 'taskboard', action: 'reorder' }] });
    const task = [...t.tasks.values()][0];
    expect(task.state).toBe('approved');
    expect(task.executor).toBe('a2');
    return task;
  }

  it('marks an approved task unclaimed when its lease expires', () => {
    const { t, clock } = make({ watchdog: { task_lease_ms: 1000 } });
    joinAll(t);
    const task = approvedTask(t);
    clock.now += 1100;
    t.tick();
    expect(t.tasks.get(task.id)?.state).toBe('unclaimed');
    expect(t.tasks.get(task.id)?.executor).toBeNull();
  });

  it('puts a removed executor\'s task back on the table', () => {
    const { t } = make();
    joinAll(t);
    const task = approvedTask(t);
    t.removeSeat('a2');
    expect(t.tasks.get(task.id)?.state).toBe('unclaimed');
    expect(t.tasks.get(task.id)?.executor).toBeNull();
  });

  it('reassigns to another bot of the same owner, and refuses a human or a stranger', () => {
    const { t } = make();
    joinAll(t);
    const task = approvedTask(t);
    t.removeSeat('a2');
    t.join(owners.tao.signJoin('t', { seat: 'a3', kind: 'bot', card: boardCard }) as never);
    const e = t.reassignTask(task.id, 'a3');
    expect(e.event).toBe('task_state');
    expect(t.tasks.get(task.id)).toMatchObject({ state: 'approved', executor: 'a3' });
    expect(() => t.reassignTask(task.id, 'h')).toThrow(/human seat/);
    // Replay keeps the reassignment: it is a ledger event, not runtime state.
    const again = new Table(t.cfg, undefined, t.entries, () => 1_000_000);
    expect(again.tasks.get(task.id)).toMatchObject({ state: 'approved', executor: 'a3' });
  });
});
