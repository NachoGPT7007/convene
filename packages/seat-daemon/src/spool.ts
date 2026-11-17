// The local spool: what arrived while the agent was down.
//
// Append-only, and fsynced before the receiver acknowledges, so "the daemon answered 200" means the
// wake-up survives a crash. The cursor is the only mutable thing here and it is replaced atomically.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface SpooledWake {
  table: string;
  seat: string;
  seq: number;
  wakes: string[];
  entry: { seq: number; kind?: string; event?: string; seat?: string; to?: string[]; task?: string; state?: string };
  received_at: string;
}

export class Spool {
  readonly wakesFile: string;
  readonly cursorFile: string;
  private wakes: SpooledWake[] = [];
  private seen = new Set<string>();
  private cursors: Record<string, number> = {};
  /** Bytes of wakes.jsonl already consumed, so a second process (the MCP side) can follow it. */
  private offset = 0;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.wakesFile = join(dir, 'wakes.jsonl');
    this.cursorFile = join(dir, 'cursor.json');
    this.load();
  }

  /**
   * Idempotent: the same (table, seq) is spooled once. The host retries a delivery it did not get a
   * 200 for, so a duplicate here is expected, not an error.
   */
  append(w: SpooledWake): boolean {
    const key = `${w.table}:${w.seq}`;
    if (this.seen.has(key)) return false;
    // O_APPEND plus an explicit fsync: the acknowledgement must not outrun the disk.
    const fd = openSync(this.wakesFile, 'a');
    try {
      writeSync(fd, JSON.stringify(w) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.seen.add(key);
    this.wakes.push(w);
    return true;
  }

  /** Everything past the cursor, oldest first. */
  unread(): SpooledWake[] {
    return this.wakes.filter(w => w.seq > (this.cursors[w.table] ?? 0));
  }

  /** Advance one table's cursor. Returns the cursor actually stored (an old ack never rewinds it). */
  ack(table: string, seq: number): number {
    const current = this.cursors[table] ?? 0;
    if (!Number.isFinite(seq) || seq <= current) return current;
    this.cursors[table] = Math.floor(seq);
    this.saveCursor();
    return this.cursors[table];
  }

  get cursor(): Record<string, number> { return { ...this.cursors }; }

  get size(): number { return this.wakes.length; }

  /**
   * Pick up wakes another process appended since the last call. The receiver and the MCP side are
   * separate processes on purpose (the daemon outlives the agent), so this side follows the file.
   */
  refresh(): number {
    if (!existsSync(this.wakesFile)) return 0;
    const size = statSync(this.wakesFile).size;
    if (size <= this.offset) return 0;
    const fd = openSync(this.wakesFile, 'r');
    let added = 0;
    try {
      const buf = Buffer.alloc(size - this.offset);
      const n = readSync(fd, buf, 0, buf.length, this.offset);
      const text = buf.subarray(0, n).toString('utf8');
      // Only whole lines are consumed: a half-written line waits for the next refresh.
      const cut = text.lastIndexOf('\n') + 1;
      if (!cut) return 0;
      for (const line of text.slice(0, cut).split('\n')) {
        if (!line.trim()) continue;
        try {
          const w = JSON.parse(line) as SpooledWake;
          if (typeof w.table !== 'string' || typeof w.seq !== 'number') continue;
          const key = `${w.table}:${w.seq}`;
          if (this.seen.has(key)) continue;
          this.seen.add(key);
          this.wakes.push(w);
          added++;
        } catch {
          // The receiver only ever appends whole, parsed lines; an unreadable one is not a wake.
        }
      }
      this.offset += Buffer.byteLength(text.slice(0, cut), 'utf8');
    } finally {
      closeSync(fd);
    }
    return added;
  }

  private load(): void {
    if (existsSync(this.cursorFile)) {
      try { this.cursors = (JSON.parse(readFileSync(this.cursorFile, 'utf8')) as { tables?: Record<string, number> }).tables ?? {}; }
      catch (err) { console.warn(`seat-daemon: ignoring unreadable cursor ${this.cursorFile}: ${(err as Error).message}`); }
    }
    if (!existsSync(this.wakesFile)) return;
    let text = readFileSync(this.wakesFile, 'utf8');
    // A crash during an append can leave a line without its newline. Cut it before the next append,
    // or the new wake would be glued onto the fragment and neither line would parse.
    if (text && !text.endsWith('\n')) {
      const cut = text.lastIndexOf('\n') + 1;
      const kept = text.slice(0, cut);
      try { truncateSync(this.wakesFile, Buffer.byteLength(kept, 'utf8')); } catch { /* read-only is still usable */ }
      console.warn('seat-daemon: dropped an incomplete trailing wake line');
      text = kept;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const w = JSON.parse(line) as SpooledWake;
        if (typeof w.table !== 'string' || typeof w.seq !== 'number') throw new Error('missing table/seq');
        this.seen.add(`${w.table}:${w.seq}`);
        this.wakes.push(w);
      } catch (err) {
        // A corrupt line in the middle is not a torn tail; skip it rather than refuse to start.
        console.warn(`seat-daemon: skipping an unreadable wake line: ${(err as Error).message}`);
      }
    }
    // Follow from the end of what is already in memory: refresh() only needs what comes after.
    this.offset = existsSync(this.wakesFile) ? statSync(this.wakesFile).size : 0;
  }

  private saveCursor(): void {
    const tmp = join(dirname(this.cursorFile), `.cursor.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ tables: this.cursors }, null, 2));
    renameSync(tmp, this.cursorFile);
  }
}
