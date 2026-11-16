// Let the project own its port instead of a terminal: a systemd --user unit for the table host.
// Everything that decides what the unit says is a pure function; only install/uninstall touch disk
// and systemctl.
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export interface ServiceOptions {
  /** Unit base name, without `.service`. */
  name: string;
  port: number;
  host: string;
  dataDir: string;
  /** Absolute path to the convene package root. */
  repoRoot: string;
  /** Absolute command line: an interpreter followed by its arguments. */
  exec: string[];
  /** Present for readability in tests; defaults to the current user's home. */
  home?: string;
}

export const unitName = (name: string) => `${name}.service`;

export const unitPath = (name: string, home = homedir()) => join(home, '.config', 'systemd', 'user', unitName(name));

/** Quote an ExecStart argument the way systemd expects: only when it contains a space or a quote. */
const q = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

export function serviceUnit(o: ServiceOptions): string {
  const repo = resolve(o.repoRoot);
  const data = resolve(o.dataDir);
  const exec = o.exec.map(q).join(' ');
  return [
    '[Unit]',
    `Description=convene table host on ${o.host}:${o.port} (BYOB byob/0.1)`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${repo}`,
    `ExecStart=${exec} serve --host ${q(o.host)} --port ${o.port} --data ${q(data)}`,
    '# Exit cleanly on the first signal: the host is the ledger\'s only writer, so the last',
    '# append should land whole rather than be cut off mid-write.',
    'KillSignal=SIGTERM',
    'TimeoutStopSec=10',
    'Restart=on-failure',
    'RestartSec=3',
    '# A user unit does not inherit an interactive shell, so there is no proxy to inherit.',
    '# Keep the tailnet and the loopback out of any proxy that does appear system-wide.',
    'Environment="no_proxy=localhost,127.0.0.1,::1,100.64.0.0/10"',
    'Environment="NO_PROXY=localhost,127.0.0.1,::1,100.64.0.0/10"',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** The convene package root, found by walking up to the package.json that names this package. */
export function locateRepoRoot(from: string): string {
  let dir = dirname(from);
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).name === 'convene') return dir;
      } catch { /* keep walking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('cannot find the convene package root (package.json with name "convene" above this file)');
}

export type ServeSource = 'auto' | 'source' | 'dist';

/**
 * A resident host does not need a build step. tsx runs the source directly — about 0.7s at start,
 * once — and there is then no artifact that can be older than the code it came from. `dist` is for
 * a machine without node_modules (a release, a container) and has to be asked for on purpose.
 */
export function defaultServeExec(repoRoot: string, nodePath = process.execPath, source: ServeSource = 'auto'): string[] {
  const src = join(repoRoot, 'src', 'cli.ts');
  const tsx = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const built = join(repoRoot, 'dist', 'src', 'cli.js');

  const fromSource = existsSync(tsx) && existsSync(src) ? [nodePath, tsx, src] : null;
  const fromDist = existsSync(built) ? [nodePath, built] : null;

  if (source === 'source') return fromSource ?? missing('tsx and src/cli.ts');
  if (source === 'dist') return fromDist ?? missing('dist/src/cli.js');
  return fromSource ?? fromDist ?? missing('either tsx + src/cli.ts or dist/src/cli.js');
}

function missing(what: string): never {
  throw new Error(`cannot run the host: ${what} not found — run \`npm install\` (and \`npm run build\` for --from dist)`);
}

export function systemctlUser(args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: out.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: `${e.stderr ?? ''}${e.stdout ?? ''}${e.message}`.trim() };
  }
}

export interface InstallResult { unitFile: string; action: 'started' | 'restarted' | 'failed'; detail: string }

/** Write the unit and hand it to systemd. Re-running is safe: it restarts rather than duplicating. */
export function installService(o: ServiceOptions): InstallResult {
  const file = unitPath(o.name, o.home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serviceUnit(o), { mode: 0o644 });

  const reload = systemctlUser(['daemon-reload']);
  if (!reload.ok) return { unitFile: file, action: 'failed', detail: `daemon-reload: ${reload.out}` };

  const wasActive = systemctlUser(['is-active', unitName(o.name)]).out === 'active';
  const start = wasActive ? systemctlUser(['restart', unitName(o.name)]) : systemctlUser(['enable', '--now', unitName(o.name)]);
  if (!start.ok) return { unitFile: file, action: 'failed', detail: start.out };
  return { unitFile: file, action: wasActive ? 'restarted' : 'started', detail: '' };
}

export function uninstallService(name: string, home = homedir()): { ok: boolean; detail: string } {
  const file = unitPath(name, home);
  const stop = systemctlUser(['disable', '--now', unitName(name)]);
  if (existsSync(file)) rmSync(file);
  const reload = systemctlUser(['daemon-reload']);
  if (!stop.ok && !/not loaded|not-found|No such file/i.test(stop.out)) return { ok: false, detail: stop.out };
  return { ok: reload.ok, detail: reload.ok ? '' : reload.out };
}

export function serviceStatus(name: string, home = homedir()): { installed: boolean; unitFile: string; detail: string } {
  const file = unitPath(name, home);
  const st = systemctlUser(['is-active', unitName(name)]);
  return { installed: existsSync(file), unitFile: file, detail: st.out || 'unknown' };
}

/** Resolve the CLI's own repo root from this module's location (works under tsx and from dist). */
export const repoRootFromModule = () => locateRepoRoot(fileURLToPath(import.meta.url));
