// Table Core: the single writer of a table's append-only ledger.
// Every state change is an Entry; `apply()` is the only mutator, so replaying the ledger
// reproduces the table exactly (floor, seats, tasks, budget, status).
import { EventEmitter } from 'node:events';
import {
  PROTOCOL, ByobError, estimateTokens,
  type Entry, type TableConfig, type Seat, type Task, type JoinRequest, type PostRequest,
  type OwnerDecision, type Projection, type Effect, type JoinRequestPublic,
} from './protocol.js';
import { makePolicy, matchVisibility, type Policy, type PolicyState } from './policy.js';
import { canonical, sha256, verifyPayload } from './crypto.js';
import { check } from './schema.js';

export interface Store {
  append(e: Entry): void;
}

const GOVERNANCE = new Set(['system', 'proposal', 'decision', 'approval', 'rejection', 'status', 'receipt', 'verify']);

/** Direct-message limits, taken from codync-network: 5 in a burst, then 1 per 2 minutes, no repeat within 10. */
const DM_BURST = 5;
const DM_REFILL_MS = 2 * 60_000;
const DM_REPEAT_MS = 10 * 60_000;

export class Table extends EventEmitter {
  readonly cfg: TableConfig;
  readonly policy: Policy;
  entries: Entry[] = [];
  seats = new Map<string, Seat>();
  tasks = new Map<string, Task>();
  holder: string | null = null;
  grantSeq: number | null = null;
  /** When the current turn started, read from the floor_granted entry so a replay agrees with the host. */
  private grantedAt = 0;
  pstate: PolicyState;
  status: 'open' | 'closed' = 'open';
  closeReason?: string;
  tokens = 0;
  botDepth = 0;
  /** Convene: decisions landed so far. `round` on an entry is this value at the moment it landed. */
  roundNo = 0;
  usedNonces = new Set<string>();
  cursors = new Map<string, number>();
  /** Owners admitted after creation (convene). Rebuilt from join_admitted events on replay. */
  admitted = new Map<string, string>();
  /** Join requests waiting for an operator's yes. Rebuilt from the ledger the same way. */
  pendingJoins = new Map<string, { seat: string; publicKey: string; seq: number }>();
  /** Convene: token buckets and recent bodies per sender->recipient pair. Never on the ledger. */
  private dmBuckets = new Map<string, { tokens: number; last: number }>();
  private dmRecent = new Map<string, { body: string; at: number }[]>();
  private savedHolder: string | null = null;

  constructor(cfg: TableConfig, private store?: Store, replay?: Entry[], private now: () => number = Date.now) {
    super();
    check('table-config', cfg);
    if (!cfg.termination?.any?.length) throw new ByobError('E_NO_TERMINATION', 'a table needs at least one end condition');
    this.cfg = cfg;
    this.policy = makePolicy(cfg);
    this.pstate = this.policy.init();
    if (replay?.length) for (const e of replay) this.apply(e);
    else this.write({ seat: 'core', kind: 'system', event: 'table_opened', body: cfg.topic, data: { topology: cfg.topology.kind } });
  }

  get maxChars() { return this.cfg.floor?.max_chars ?? 4000; }
  get maxBotDepth() { return this.cfg.floor?.max_bot_depth ?? 32; }
  get deciders() { return this.cfg.floor?.decision_by ?? this.policy.deciders(); }

  // ---------- the single writer ----------
  private write(partial: Omit<Entry, 'seq' | 'table'>): Entry {
    const e = { seq: this.entries.length + 1, table: this.cfg.id, round: this.roundNo, ...partial, ts: new Date(this.now()).toISOString() } as Entry;
    this.store?.append(e);
    this.apply(e);
    this.emit('entry', e);
    return e;
  }

  private apply(e: Entry) {
    // A ledger replayed from before the `round` extension carries no round: stamp it while replaying.
    if (e.round === undefined) e.round = this.roundNo;
    this.entries.push(e);
    const d = e.data ?? {};
    if (typeof d.nonce === 'string') this.usedNonces.add(d.nonce);
    switch (e.kind) {
      case 'system':
        if (e.event === 'seat_joined') this.seats.set(d.seat as string, { ...(d as unknown as Seat), joined_seq: e.seq });
        if (e.event === 'floor_granted') {
          this.holder = (d.holder as string) ?? null; this.grantSeq = e.seq; this.pstate = d.policy as PolicyState;
          this.grantedAt = Date.parse(e.ts ?? '') || 0;
          if (d.depth_reset) this.botDepth = 0;
          this.savedHolder = (d.resume as string) ?? null;
        }
        if (e.event === 'attendance') {
          const who = this.seats.get(d.seat as string);
          // A human's own statement about being at the table. Undefined reads as present.
          if (who) who.attendance = d.attendance as 'present' | 'away';
        }
        if (e.event === 'join_request') {
          this.pendingJoins.set(d.owner as string, { seat: d.seat as string, publicKey: d.public_key as string, seq: e.seq });
        }
        if (e.event === 'join_admitted') {
          this.admitted.set(d.owner as string, d.public_key as string);
          this.pendingJoins.delete(d.owner as string);
        }
        if (e.event === 'join_rejected') this.pendingJoins.delete(d.owner as string);
        if (e.event === 'seat_removed') {
          const gone = d.seat as string;
          this.seats.delete(gone);
          if (this.holder === gone) this.holder = null;
          if (this.pstate.queue) this.pstate.queue = this.pstate.queue.filter(x => x !== gone);
          if (this.pstate.stack) this.pstate.stack = this.pstate.stack.filter(x => x !== gone);
        }
        if (e.event === 'table_closed') { this.status = 'closed'; this.holder = null; this.closeReason = d.reason as string; }
        if (e.event === 'task_opened' || e.event === 'task_state') {
          const id = e.task!;
          const prev = this.tasks.get(id);
          const t: Task = prev ?? {
            id, opened_seq: e.seq, proposer: d.proposer as string, owner: d.owner as string,
            effects: d.effects as Effect[], state: 'awaiting_approval', executor: null, last_progress_ms: 0,
          };
          t.state = d.state as Task['state'];
          if (d.executor !== undefined) t.executor = d.executor as string | null;
          if (d.receipt_seq) t.receipt_seq = d.receipt_seq as number;
          if (d.lease_deadline_ms !== undefined) t.lease_deadline_ms = d.lease_deadline_ms as number;
          t.last_progress_ms = Date.parse(e.ts ?? '') || 0;
          this.tasks.set(id, t);
        }
        break;
      case 'raise_hand':
        if (this.status === 'open') this.pstate = this.policy.raiseHand(this.pstate, e.seat);
        break;
      case 'say': case 'proposal': case 'decision':
        this.tokens += e.budget?.tokens_used ?? estimateTokens(e.body);
        if (e.kind === 'say') {
          const s = this.seats.get(e.seat);
          this.botDepth = s?.kind === 'human' ? 0 : this.botDepth + 1;
        }
        // Every landed decision opens the next round; entries already on the ledger keep the round they landed in.
        if (e.kind === 'decision') this.roundNo += 1;
        break;
    }
  }

  /** A key the table accepts: the ones in the config, plus anyone an operator admitted later. */
  ownerKey(ownerId: string): { public_key: string } | undefined {
    const configured = this.cfg.owners[ownerId];
    if (configured) return configured;
    const admitted = this.admitted.get(ownerId);
    return admitted ? { public_key: admitted } : undefined;
  }

  /**
   * Ask to be let in. No seat needed: the signature over the requester's own public key is what
   * proves they hold it. An operator answers with admitJoin or rejectJoin.
   */
  requestJoin(req: JoinRequestPublic): Entry {
    const payload = { table: this.cfg.id, owner: req.owner, seat: req.seat, public_key: req.publicKey, nonce: req.nonce };
    if (!verifyPayload(req.publicKey, payload, req.signature)) throw new ByobError('E_BAD_SIGNATURE', 'join request signature does not verify against the key it carries');
    if (this.usedNonces.has(req.nonce)) throw new ByobError('E_REPLAY', 'nonce already used');
    if (this.ownerKey(req.owner)) throw new ByobError('E_CONFIG', `owner ${req.owner} already holds a key on this table`);
    if (this.seats.has(req.seat)) throw new ByobError('E_SEAT_TAKEN', `seat ${req.seat} already joined`);
    return this.write({ seat: 'core', kind: 'system', event: 'join_request',
      body: `${req.owner} asks to join as ${req.seat}`,
      data: { owner: req.owner, seat: req.seat, public_key: req.publicKey, nonce: req.nonce, signature: req.signature } });
  }

  /** Operator's yes: the key goes on the ledger, so replay admits the same owner. */
  admitJoin(ownerId: string, reason?: string): Entry {
    const pending = this.pendingJoins.get(ownerId);
    if (!pending) throw new ByobError('E_NOT_FOUND', `no join request from ${ownerId}`);
    return this.write({ seat: 'core', kind: 'system', event: 'join_admitted',
      body: `${ownerId} admitted${reason ? `: ${reason}` : ''}`,
      data: { owner: ownerId, seat: pending.seat, public_key: pending.publicKey } });
  }

  rejectJoin(ownerId: string, reason?: string): Entry {
    if (!this.pendingJoins.has(ownerId)) throw new ByobError('E_NOT_FOUND', `no join request from ${ownerId}`);
    return this.write({ seat: 'core', kind: 'system', event: 'join_rejected',
      body: `${ownerId} refused${reason ? `: ${reason}` : ''}`, data: { owner: ownerId } });
  }

  // ---------- joining ----------
  join(req: JoinRequest): Seat {
    check('join-request', req);
    if (req.protocol !== PROTOCOL) throw new ByobError('E_PROTOCOL', `unsupported protocol ${req.protocol}`);
    const owner = this.ownerKey(req.owner);
    if (!owner) throw new ByobError('E_NOT_OWNER', `owner ${req.owner} is not registered on table ${this.cfg.id}`);
    if (this.usedNonces.has(req.nonce)) throw new ByobError('E_REPLAY', 'nonce already used');
    const { signature, ...rest } = req;
    const payload = { table: this.cfg.id, seat: rest.seat, owner: rest.owner, kind: rest.kind, role: rest.role, card: rest.card, nonce: rest.nonce };
    if (!verifyPayload(owner.public_key, payload, signature)) throw new ByobError('E_BAD_SIGNATURE', 'join signature does not verify against the owner key');
    if (this.seats.has(req.seat)) throw new ByobError('E_SEAT_TAKEN', `seat ${req.seat} already joined`);
    if (this.status === 'closed') throw new ByobError('E_TABLE_CLOSED', 'table is closed');
    this.write({
      seat: 'core', kind: 'system', event: 'seat_joined',
      body: `${req.seat} joined for ${req.owner}${req.card.proxy ? ' (PROXY seat)' : ''}`,
      data: { seat: req.seat, owner: req.owner, kind: req.kind, role: req.role, transport: req.transport ?? 'http', card: req.card, nonce: req.nonce },
    });
    this.maybeStart();
    return this.seats.get(req.seat)!;
  }

  private maybeStart() {
    if (this.grantSeq !== null || this.status !== 'open') return;
    if (this.policy.required().every(s => this.seats.has(s))) this.advance(this.pstate, true);
  }

  /** Grant the floor per policy state `s`, or close the table. */
  private advance(s: PolicyState, initial = false) {
    if (this.checkTermination()) return;
    // Floor control: too many consecutive bot turns -> floor goes to a human, or the table stops.
    if (!initial && this.botDepth >= this.maxBotDepth) {
      const human = [...this.seats.values()].find(x => x.kind === 'human');
      const cur = this.policy.current(s);
      if (human) {
        this.write({ seat: 'core', kind: 'system', event: 'floor_granted', to: ['@' + human.seat], body: `bot depth ${this.botDepth} reached; floor to human ${human.seat}`,
          data: { holder: human.seat, policy: s, resume: 'holder' in cur ? cur.holder : null } });
        return;
      }
      return this.close(`depth_exhausted (${this.botDepth} consecutive bot turns, no human seated)`);
    }
    // A removed seat may still be next in the policy's sequence. Walk past the seats that are
    // gone instead of granting the floor to somebody who is no longer at the table.
    let state = s;
    for (let guard = 0; guard < 256; guard++) {
      const n = this.policy.current(state);
      if ('end' in n) {
        if (this.cfg.termination.any.includes('rounds_exhausted')) return this.close('rounds_exhausted');
        return this.close('rounds_exhausted (policy has no more turns)');
      }
      if (this.seats.has(n.holder)) {
        this.pstate = state;
        return this.write({ seat: 'core', kind: 'system', event: 'floor_granted', to: ['@' + n.holder], body: `floor -> ${n.holder}`,
          data: { holder: n.holder, policy: state, max_chars: this.maxChars } });
      }
      state = this.policy.after(state, { seq: 0, table: this.cfg.id, seat: 'core', kind: 'pass' });
    }
    return this.close('no_eligible_holder (every remaining seat was removed)');
  }

  private checkTermination(): boolean {
    for (const c of this.cfg.termination.any) {
      if (typeof c === 'object' && 'budget_tokens' in c && this.tokens > c.budget_tokens) { this.close(`budget_exhausted (${this.tokens} > ${c.budget_tokens} tokens)`); return true; }
      if (typeof c === 'object' && 'max_entries' in c && this.entries.length >= c.max_entries) { this.close(`max_entries (${c.max_entries})`); return true; }
    }
    return false;
  }

  systemNote(body: string, data: Record<string, unknown>, refs?: string[]) {
    return this.write({ seat: 'core', kind: 'system', event: data.decisions ? 'subtable_result' : 'note', body, data, refs });
  }

  close(reason: string) {
    if (this.status === 'closed') return;
    this.write({ seat: 'core', kind: 'system', event: 'table_closed', body: `table closed: ${reason}`, data: { reason } });
  }

  // ---------- posting ----------
  seat(id: string): Seat {
    const s = this.seats.get(id);
    if (!s) throw new ByobError('E_NOT_FOUND', `seat ${id}`);
    return s;
  }

  post(seatId: string, req: PostRequest): Entry {
    check('post-request', req);
    const seat = this.seat(seatId);
    const human = seat.kind === 'human';
    const floorPlane = ['say', 'pass', 'proposal', 'decision'].includes(req.kind);
    if (floorPlane || req.kind === 'raise_hand') {
      if (this.status === 'closed') throw new ByobError('E_TABLE_CLOSED', `table closed (${this.closeReason})`);
    }
    if (floorPlane && !human && this.holder !== seatId) throw new ByobError('E_NOT_FLOOR', `${seatId} does not hold the floor (holder: ${this.holder ?? 'none'}); use raise_hand`);
    if (req.kind === 'decision' && !this.deciders.includes(seatId)) throw new ByobError('E_NOT_DECIDER', `${seatId} may not post decisions (decision_by: ${this.deciders.join(', ') || 'none'})`);
    for (const a of req.to ?? []) if (a.startsWith('@') && !this.seats.has(a.slice(1))) throw new ByobError('E_ADDRESS', `no seat ${a}`);
    if (req.kind === 'say') this.policy.checkAddress?.(this.pstate, seatId, req.to);

    let body = req.body;
    let truncated: boolean | undefined;
    if (body !== undefined && floorPlane && body.length > this.maxChars) { body = body.slice(0, this.maxChars); truncated = true; }

    switch (req.kind) {
      case 'raise_hand': {
        return this.write({ seat: seatId, kind: 'raise_hand', body }); // queued by apply()
      }
      case 'say': case 'pass': {
        const e = this.write({ seat: seatId, kind: req.kind, to: req.to, reply_to: req.reply_to, body, truncated, refs: req.refs, budget: req.budget });
        this.endTurn(seatId, e);
        return e;
      }
      case 'proposal': case 'decision': {
        if (req.kind === 'proposal' && !req.effects?.length) throw new ByobError('E_SCHEMA', 'proposal requires effects; to speak without asking for an action, post kind "say"');
        const plan = req.effects?.length ? this.planTask(seat, req.effects) : null;
        const e = this.write({ seat: seatId, kind: req.kind, to: req.to, reply_to: req.reply_to, body, truncated, effects: req.effects, refs: req.refs, budget: req.budget });
        if (plan) this.openTask(e, seat, plan);
        if (req.kind === 'decision') {
          if (this.cfg.termination.any.includes('decision')) this.close(`decision #${e.seq}`);
          else this.endTurn(seatId, e);
        }
        return e;
      }
      case 'status': case 'receipt': case 'verify':
        return this.workPlane(seat, req);
      case 'dm':
        return this.privateMessage(seatId, req);
    }
  }

  /**
   * A direct message: no floor, but it is a ledger entry. Only the sender, the named recipients and
   * seats whose owner-signed card carries `grants.read_dm_all` may ever see it (see canSee).
   */
  private privateMessage(seatId: string, req: PostRequest): Entry {
    if (this.status === 'closed') throw new ByobError('E_TABLE_CLOSED', `table closed (${this.closeReason})`);
    const to = req.to ?? [];
    if (!to.length) throw new ByobError('E_SCHEMA', 'dm requires "to": name at least one seat, e.g. ["@bob"]');
    if (!req.body) throw new ByobError('E_SCHEMA', 'dm requires a body');
    const targets = [...new Set(to.map(a => (a.startsWith('@') ? a.slice(1) : '')))];
    // Point to point only: `*` and `role:` would turn a private channel into a broadcast.
    if (targets.some(s => !s || !this.seats.has(s))) throw new ByobError('E_ADDRESS', `dm may only address seats as "@<seat>"; got ${to.join(', ')}`);
    this.checkDmRate(seatId, targets, req.body);
    const e = this.write({ seat: seatId, kind: 'dm', to, reply_to: req.reply_to, body: req.body, refs: req.refs });
    this.noteDm(seatId, targets, req.body);
    return e;
  }

  /** Token bucket per sender->recipient pair, plus a repeat guard: cheap, in-memory, restart-forgiving. */
  private checkDmRate(from: string, targets: string[], body: string) {
    const now = this.now();
    for (const to of targets) {
      const key = `${from}->${to}`;
      const b = this.dmBuckets.get(key);
      let tokens = b?.tokens ?? DM_BURST;
      let last = b?.last ?? now;
      const refill = Math.floor((now - last) / DM_REFILL_MS);
      if (refill > 0) { tokens = Math.min(DM_BURST, tokens + refill); last += refill * DM_REFILL_MS; }
      const recent = (this.dmRecent.get(key) ?? []).filter(x => now - x.at < DM_REPEAT_MS);
      if (recent.some(x => x.body === body)) throw new ByobError('E_DM_DUPLICATE', `the same message was already sent to ${to} within ${DM_REPEAT_MS / 60_000} minutes`);
      if (tokens < 1) throw new ByobError('E_DM_RATE_LIMIT', `${from} has used its burst to ${to}; one message per ${DM_REFILL_MS / 60_000} minutes after that`);
      this.dmBuckets.set(key, { tokens: tokens - 1, last });
      this.dmRecent.set(key, recent);
    }
  }

  private noteDm(from: string, targets: string[], body: string) {
    const now = this.now();
    for (const to of targets) {
      const key = `${from}->${to}`;
      const recent = (this.dmRecent.get(key) ?? []).filter(x => now - x.at < DM_REPEAT_MS);
      recent.push({ body, at: now });
      this.dmRecent.set(key, recent);
    }
  }

  /**
   * Take a seat off the table. It is an ordinary system event, so replay reproduces the table:
   * the seat disappears from every projection and its token stops authenticating.
   */
  removeSeat(seatId: string, reason?: string): Entry {
    if (!this.seats.has(seatId)) throw new ByobError('E_NOT_FOUND', `seat ${seatId}`);
    const held = this.holder === seatId;
    const e = this.write({ seat: 'core', kind: 'system', event: 'seat_removed',
      body: `${seatId} removed${reason ? `: ${reason}` : ''}`, data: { seat: seatId } });
    // A removed executor cannot finish: put its tasks back on the table so an operator can reassign them.
    for (const t of this.tasks.values()) {
      if (t.executor === seatId && ['approved', 'running', 'stalled'].includes(t.state)) {
        this.write({ seat: 'core', kind: 'system', event: 'task_state', task: t.id,
          body: `${t.id} unclaimed: executor ${seatId} was removed`,
          data: { state: 'unclaimed', executor: null, reason: 'executor_removed' } });
      }
    }
    // Its turn cannot be left hanging: hand the floor on, or close if nobody is left.
    if (held && this.status === 'open' && this.grantSeq !== null) this.advance(this.pstate, true);
    return e;
  }

  private endTurn(seatId: string, e: Entry) {
    if (this.status === 'closed') return;
    if (this.holder === seatId) {
      const resume = this.savedHolder;
      if (this.seats.get(seatId)?.kind === 'human' && resume !== null) {
        // human interjection while holding the floor after a depth stop: resume the policy where it was
        this.write({ seat: 'core', kind: 'system', event: 'floor_granted', to: ['@' + resume], body: `floor -> ${resume} (resumed after human)`, data: { holder: resume, policy: this.pstate, depth_reset: true } });
        return;
      }
      this.advance(this.policy.after(this.pstate, e));
    }
    // A human speaking out of turn does not move the floor; it only resets the bot-depth counter (apply()).
  }

  // ---------- tasks: propose -> approve -> execute -> verify ----------
  private planTask(proposer: Seat, effects: Effect[]) {
    const owner = effects[0].owner;
    if (effects.some(f => f.owner !== owner)) throw new ByobError('E_MIXED_OWNERS', 'v0.1: one proposal may affect only one owner; split it');
    if (!this.cfg.owners[owner]) throw new ByobError('E_NOT_OWNER', `owner ${owner} is not registered`);
    const can = (s: Seat) => effects.every(f => s.card.capabilities.some(c => c.resource === f.resource && c.actions.includes(f.action)));
    const executor = [...this.seats.values()].find(s => s.owner === owner && s.kind === 'bot' && can(s));
    if (!executor) throw new ByobError('E_NO_EXECUTOR', `no seat of owner ${owner} declares ${effects.map(f => f.resource + ':' + f.action).join(', ')}`);
    const flagged = effects.some(f => executor.card.capabilities.some(c => c.resource === f.resource && c.requires_approval));
    // Cross-owner auto-approval comes only from the executor's card, which the affected owner signed at join.
    // The table config is written by the table creator, who does not hold that owner's key.
    const autoRule = effects.every(f => executor.card.capabilities.some(c =>
      c.resource === f.resource && c.actions.includes(f.action) && c.auto_approve === true && !c.requires_approval));
    const auto = autoRule || (proposer.owner === owner && !flagged);
    return { owner, executor: executor.seat, auto, why: autoRule ? 'auto_approve in the owner-signed card' : auto ? 'own-owner action' : null };
  }

  private openTask(e: Entry, proposer: Seat, plan: { owner: string; executor: string; auto: boolean; why: string | null }) {
    const id = `task-${e.seq}`;
    this.write({ seat: 'core', kind: 'system', event: 'task_opened', task: id, reply_to: e.seq, to: plan.auto ? ['@' + plan.executor] : [],
      body: plan.auto ? `${id} auto-approved (${plan.why}); executor ${plan.executor}` : `${id} awaiting approval from owner ${plan.owner}`,
      data: { proposer: proposer.seat, owner: plan.owner, effects: e.effects, state: plan.auto ? 'approved' : 'awaiting_approval',
        executor: plan.auto ? plan.executor : null, planned_executor: plan.executor,
        ...(this.cfg.watchdog?.task_lease_ms ? { lease_deadline_ms: this.now() + this.cfg.watchdog.task_lease_ms } : {}) } });
  }

  task(id: string): Task {
    const t = this.tasks.get(id);
    if (!t) throw new ByobError('E_NOT_FOUND', `task ${id}`);
    return t;
  }

  ownerDecision(req: OwnerDecision): Entry {
    check('owner-decision', req);
    const t = this.task(req.task);
    if (req.owner !== t.owner) throw new ByobError('E_NOT_OWNER', `${req.task} affects owner ${t.owner}, not ${req.owner}`);
    if (this.usedNonces.has(req.nonce)) throw new ByobError('E_REPLAY', 'nonce already used');
    const payload = { table: this.cfg.id, owner: req.owner, task: req.task, decision: req.decision, reason: req.reason, nonce: req.nonce };
    if (!verifyPayload(this.cfg.owners[req.owner].public_key, payload, req.signature)) throw new ByobError('E_BAD_SIGNATURE', 'owner signature does not verify');
    if (t.state !== 'awaiting_approval') throw new ByobError('E_TASK_STATE', `${t.id} is ${t.state}`);
    const approve = req.decision === 'approve';
    const e = this.write({ seat: 'owner:' + req.owner, kind: approve ? 'approval' : 'rejection', task: t.id, reply_to: t.opened_seq, body: req.reason, data: { nonce: req.nonce, signature: req.signature } });
    const planned = (this.entries[t.opened_seq - 1].data?.planned_executor as string) ?? null;
    this.write({ seat: 'core', kind: 'system', event: 'task_state', task: t.id, to: approve && planned ? ['@' + planned] : [],
      body: approve ? `${t.id} approved by ${req.owner}; executor ${planned}` : `${t.id} rejected by ${req.owner}`,
      data: { state: approve ? 'approved' : 'rejected', executor: approve ? planned : null,
        ...(approve && this.cfg.watchdog?.task_lease_ms ? { lease_deadline_ms: this.now() + this.cfg.watchdog.task_lease_ms } : {}) } });
    return e;
  }

  private workPlane(seat: Seat, req: PostRequest): Entry {
    if (!req.task) throw new ByobError('E_SCHEMA', `${req.kind} requires task`);
    const t = this.task(req.task);
    const setState = (state: string, body: string, extra: Record<string, unknown> = {}) =>
      this.write({ seat: 'core', kind: 'system', event: 'task_state', task: t.id, body, data: { state, ...extra } });
    if (req.kind === 'status' || req.kind === 'receipt') {
      if (seat.seat !== t.executor) throw new ByobError('E_NOT_OWNER', `only executor ${t.executor ?? '(none yet)'} may report on ${t.id}`);
      if (!['approved', 'running', 'stalled'].includes(t.state)) throw new ByobError('E_TASK_STATE', `${t.id} is ${t.state}`);
      if (req.kind === 'status') {
        if (!req.state) throw new ByobError('E_SCHEMA', 'status requires state');
        const e = this.write({ seat: seat.seat, kind: 'status', task: t.id, state: req.state, body: req.body });
        setState(req.state, `${t.id} ${req.state}`);
        return e;
      }
      const e = this.write({ seat: seat.seat, kind: 'receipt', task: t.id, reply_to: t.opened_seq, body: req.body, artifact: req.artifact, refs: req.refs });
      setState('reported', `${t.id} reported by ${seat.seat}; needs verify from another seat`, { receipt_seq: e.seq });
      return e;
    }
    // verify
    if (seat.seat === t.executor) throw new ByobError('E_SELF_VERIFY', 'the executor cannot verify its own receipt');
    if (t.state !== 'reported') throw new ByobError('E_TASK_STATE', `${t.id} is ${t.state}; verify needs a receipt first`);
    if (!req.result) throw new ByobError('E_SCHEMA', 'verify requires result');
    const e = this.write({ seat: seat.seat, kind: 'verify', task: t.id, reply_to: t.receipt_seq, result: req.result, body: req.body });
    setState(req.result === 'pass' ? 'verified' : 'failed', `${t.id} ${req.result === 'pass' ? 'verified' : 'failed verification'} by ${seat.seat}`);
    return e;
  }

  /**
   * A human says whether they are watching the table. Only the human seat itself can change it, and
   * a bot seat has no attendance at all. Managed (away) means: no vote, no interjection, no approval.
   */
  setAttendance(seatId: string, attendance: 'present' | 'away'): Entry {
    const s = this.seat(seatId);
    if (s.kind !== 'human') throw new ByobError('E_NOT_OWNER', `${seatId} is a bot seat; attendance belongs to a human`);
    if (attendance !== 'present' && attendance !== 'away') throw new ByobError('E_SCHEMA', 'attendance must be present or away');
    return this.write({ seat: 'core', kind: 'system', event: 'attendance',
      body: `${seatId} is ${attendance === 'away' ? 'away (managed: no vote, no interjection)' : 'present'}`,
      data: { seat: seatId, attendance } });
  }

  /** Who may vote or be counted as "present": a human who says they are watching, never a bot or a managed seat. */
  canVote(seatId: string): boolean {
    const s = this.seats.get(seatId);
    return s?.kind === 'human' && (s.attendance ?? 'present') === 'present';
  }

  /** Give a waiting task to another bot of the same owner. The operator's lever after a seat is removed. */
  reassignTask(taskId: string, executor: string): Entry {
    const t = this.task(taskId);
    const s = this.seat(executor);
    // Say "a task runs on a bot" before "wrong owner": the first is the actionable mistake.
    if (s.kind !== 'bot') throw new ByobError('E_CONFIG', `${executor} is a human seat; tasks run on bots`);
    if (s.owner !== t.owner) throw new ByobError('E_NOT_OWNER', `${executor} belongs to ${s.owner}; ${t.id} affects ${t.owner}`);
    if (!['approved', 'unclaimed', 'stalled'].includes(t.state)) throw new ByobError('E_TASK_STATE', `${t.id} is ${t.state}`);
    return this.write({ seat: 'core', kind: 'system', event: 'task_state', task: t.id, to: ['@' + executor],
      body: `${t.id} reassigned to ${executor}`,
      data: { state: 'approved', executor, reassigned_from: t.executor ?? null } });
  }

  /** Watchdog: mark tasks with no progress past heartbeat as stalled. */
  tick() {
    // A held turn has a deadline: a managed seat that went quiet must not freeze the table. The skip
    // is a ledger entry, so a replay shows the same order; it is not a silent projection rule.
    const turn = this.cfg.floor?.turn_ms;
    if (turn && this.status === 'open' && this.holder && this.grantSeq !== null && this.grantedAt) {
      if (this.now() - this.grantedAt >= turn) {
        const holder = this.holder;
        const e = this.write({ seat: holder, kind: 'pass',
          body: `skipped: no reply within ${turn}ms`,
          data: { skipped: true, timeout_ms: turn } });
        this.advance(this.policy.after(this.pstate, e));
      }
    }
    // An approved task that nobody started inside its lease goes back to the table, where an operator
    // can reassign it. Without this, a removed or sleeping executor leaves the task waiting forever.
    const lease = this.cfg.watchdog?.task_lease_ms;
    if (lease) {
      for (const t of this.tasks.values()) {
        if (t.state === 'approved' && t.lease_deadline_ms && this.now() > t.lease_deadline_ms) {
          this.write({ seat: 'core', kind: 'system', event: 'task_state', task: t.id,
            body: `${t.id} unclaimed: not started within ${lease}ms`,
            data: { state: 'unclaimed', executor: null, reason: 'lease_expired' } });
        }
      }
    }
    const hb = this.cfg.watchdog?.heartbeat_ms;
    if (!hb) return;
    for (const t of this.tasks.values()) {
      if ((t.state === 'approved' || t.state === 'running') && this.now() - t.last_progress_ms > hb)
        this.write({ seat: 'core', kind: 'system', event: 'task_state', task: t.id, body: `${t.id} stalled (no progress for ${hb}ms)`, data: { state: 'stalled' } });
    }
  }

  // ---------- reading ----------
  canSee(e: Entry, viewer: string): boolean {
    // Direct messages are filtered here, before any `visibility` override: a `*.*` pattern opts a
    // seat into the floor plane, never into other seats' private channels. Only `read_dm_all` does.
    if (e.kind === 'dm') return this.canSeeDm(e, viewer);
    if (e.seat === viewer || GOVERNANCE.has(e.kind)) return true;
    const v = this.seats.get(viewer);
    if (!v) return false;
    const override = this.cfg.visibility?.[viewer];
    if (override) return matchVisibility(override, e);
    return this.policy.visible(e, viewer);
  }

  /** Sender, named recipients, or a seat whose owner signed `grants.read_dm_all`. Everyone else: 404. */
  private canSeeDm(e: Entry, viewer: string): boolean {
    if (e.seat === viewer) return true;
    if ((e.to ?? []).some(a => a === '@' + viewer)) return true;
    return this.seats.get(viewer)?.card.grants?.read_dm_all === true;
  }

  prefix() {
    const seats = [...this.seats.values()].sort((a, b) => a.joined_seq - b.joined_seq).map(s => ({
      seat: s.seat, owner: s.owner, kind: s.kind, role: s.role, bot: s.card.bot, proxy: s.card.proxy ?? false,
      // Who is behind this seat, what runs it, and how it got here: owner is the human principal,
      // bot is the agent, transport is the channel it joined over.
      transport: s.transport ?? null,
      // A managed human has no vote; the page must be able to say so, not guess from a nickname.
      attendance: s.kind === 'human' ? (s.attendance ?? 'present') : null,
      runtime: s.card.runtime ?? null,
      // The privileges the owner signed. Without this the dashboard showed "权限 无" for everyone.
      grants: s.card.grants ?? null,
      capabilities: s.card.capabilities,
      // Signed into the card, so it cannot be set by a client that is not the owner (convene).
      badge: s.card.badge ?? null,
    }));
    const decisions = this.entries.filter(e => e.kind === 'decision').map(e => ({ seq: e.seq, seat: e.seat, body: e.body }));
    return {
      topic: this.cfg.topic,
      rules: { protocol: PROTOCOL, table: this.cfg.id, parent: this.cfg.parent, topology: this.cfg.topology, floor: { max_chars: this.maxChars, max_bot_depth: this.maxBotDepth, decision_by: this.deciders }, termination: this.cfg.termination },
      seats, decisions,
    };
  }

  projection(viewer: string, since?: number): Projection {
    this.seat(viewer);
    const from = since ?? this.cursors.get(viewer) ?? 0;
    const limit = this.cfg.projection?.inline_limit ?? 2000;
    const tail = this.entries.filter(e => e.seq > from && this.canSee(e, viewer)).map(e => {
      const { ts: _ts, ...rest } = e; // no wall clock in projections: it would break prompt caching
      if (rest.data) { const { signature: _s, nonce: _n, ...d } = rest.data; rest.data = d; }
      if (rest.body && rest.body.length > limit) return { ...rest, body: rest.body.slice(0, limit) + ' …', refs: [...(rest.refs ?? []), `entry:${e.seq}`] };
      return rest;
    });
    const cursor = this.entries.length;
    this.cursors.set(viewer, cursor);
    const prefix = this.prefix();
    return {
      protocol: PROTOCOL, table: this.cfg.id, seat: viewer, prefix, prefix_hash: sha256(canonical(prefix)), tail, cursor,
      floor: { holder: this.holder, you_have_floor: this.holder === viewer, grant_seq: this.grantSeq, max_chars: this.maxChars, round: this.roundNo },
      status: this.status,
      my_tasks: [...this.tasks.values()].filter(t => t.executor === viewer || t.proposer === viewer),
    };
  }

  expand(viewer: string, seq: number): Entry {
    const e = this.entries[seq - 1];
    if (!e || !this.canSee(e, viewer)) throw new ByobError('E_NOT_FOUND', `entry ${seq}`);
    const { ts: _ts, ...rest } = e;
    return rest;
  }

  /** Table memory: what the table itself remembers (never any bot's private memory). */
  memory() {
    return {
      topic: this.cfg.topic,
      decisions: this.entries.filter(e => e.kind === 'decision').map(e => ({ seq: e.seq, seat: e.seat, body: e.body })),
      tasks: [...this.tasks.values()].map(t => ({ id: t.id, owner: t.owner, state: t.state, executor: t.executor, effects: t.effects })),
      status: this.status, close_reason: this.closeReason, tokens: this.tokens,
    };
  }
}
