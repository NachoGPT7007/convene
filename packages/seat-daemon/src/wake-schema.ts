// Validate a wake-up against the Schema this package froze, so the daemon and the table host cannot
// drift into a private dialect. The Schema itself lives in packages/seat-daemon/schemas/wake.json
// and reuses the protocol's common.json definitions.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

function findUp(relative: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const p = join(dir, relative);
    if (existsSync(p)) return p;
    dir = dirname(dir);
  }
  throw new Error(`seat-daemon: cannot find ${relative}`);
}

type AjvLike = { addSchema(s: unknown): void; getSchema(id: string): (((v: unknown) => boolean) & { errors?: unknown }) | undefined; errorsText(e: unknown): string };
const mod = Ajv2020 as unknown as { default?: new (o: object) => AjvLike } & (new (o: object) => AjvLike);
const AjvCtor = mod.default ?? mod;
const ajv: AjvLike = new AjvCtor({ allErrors: true, strict: false });

let loaded = false;
function ensureLoaded(): void {
  if (loaded) return;
  // common.json defines the id pattern wake.json references; both must be in the same instance.
  ajv.addSchema(JSON.parse(readFileSync(findUp('schemas/common.json'), 'utf8')));
  ajv.addSchema(JSON.parse(readFileSync(findUp('packages/seat-daemon/schemas/wake.json'), 'utf8')));
  loaded = true;
}

/** Throws a human-readable message when the body is not a wake-up; returns nothing when it is. */
export function checkWake(body: unknown): void {
  ensureLoaded();
  const v = ajv.getSchema('https://byob.dev/schemas/v0.1/wake.json');
  if (!v) throw new Error('wake schema not loaded');
  if (!v(body)) throw new Error('wake: ' + ajv.errorsText(v.errors));
}
