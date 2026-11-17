// `convene daemon ...`: the long-lived receiver, the stdio MCP side, and the operator helpers.
//
// Two subcommands instead of one process: `serve` must outlive the agent (it receives while nobody
// is listening), while `mcp` is spawned by the agent over stdio and dies with it. They meet in the
// spool directory and nowhere else.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Spool } from './spool.js';
import { createReceiver } from './receiver.js';
import { retryRegister, subscriptionSpecFrom } from './register.js';
import { catchUp, readSeatLink } from './catch-up.js';
import { envFileContent, envFilePath, seatServiceUnit } from './unit.js';

export function splitHostPort(listen: string): { host: string; port: number } {
  const i = listen.lastIndexOf(':');
  if (i < 0) throw new Error(`listen expects host:port, got "${listen}"`);
  const host = listen.slice(0, i) || '127.0.0.1';
  const port = Number(listen.slice(i + 1));
  if (!Number.isInteger(port) || port <= 0) throw new Error(`listen has no port: "${listen}"`);
  return { host, port };
}

export function defaultSpoolDir(flags: Record<string, string>): string {
  return flags.spool ?? join(homedir(), '.convene', 'seat-daemon', flags.table ?? 'main', flags.seat ?? 'seat');
}

/** A systemd unit cannot hold the seat token; it reads this file instead (0600, written by `envfile`). */
export function mergeEnv(flags: Record<string, string>): Record<string, string> {
  const pick = (flag: string, env: string) => flags[flag] ?? process.env[env] ?? '';
  return {
    ...flags,
    url: pick('url', 'SEAT_DAEMON_URL'),
    table: pick('table', 'SEAT_DAEMON_TABLE'),
    seat: pick('seat', 'SEAT_DAEMON_SEAT'),
    token: pick('token', 'SEAT_DAEMON_TOKEN'),
    listen: pick('listen', 'SEAT_DAEMON_LISTEN') || '127.0.0.1:7342',
    spool: pick('spool', 'SEAT_DAEMON_SPOOL'),
    'wake-token': pick('wake-token', 'SEAT_DAEMON_WAKE_TOKEN'),
  };
}

export async function runDaemon(sub: string | undefined, rawFlags: Record<string, string>): Promise<void> {
  const flags = mergeEnv(rawFlags);
  switch (sub) {
    case 'serve': return serve(flags);
    case 'mcp': {
      const { main } = await import('./mcp.js');
      return main([defaultSpoolDir(flags)]);
    }
    case 'status': return status(flags);
    case 'register': return registerOnly(flags);
    case 'unit': return printUnit(flags);
    case 'envfile': return writeEnvFile(flags);
    default: throw new Error('convene daemon needs a subcommand: serve | mcp | status | register | unit | envfile');
  }
}

async function serve(flags: Record<string, string>): Promise<void> {
  const spool = new Spool(defaultSpoolDir(flags));
  const listen = flags.listen;
  const { host, port } = splitHostPort(listen);
  const receiver = createReceiver(spool, { token: flags['wake-token'] });

  // A port already held by another process would make the daemon look healthy in a log while
  // never receiving anything; refuse loudly instead.
  await new Promise<void>((resolve, reject) => {
    receiver.once('error', reject);
    receiver.listen(port, host, () => { receiver.off('error', reject); resolve(); });
  });
  console.log(`seat daemon listening on http://${host}:${port}/wake (spool: ${spool.dir})`);

  const spec = subscriptionSpecFrom(flags);
  if (spec) {
    // The subscription is left in place on exit: registration is idempotent per (seat, url), and a
    // host that kept it can push the moment the daemon is back, before it has re-registered.
    mkdirSync(spool.dir, { recursive: true });
    // The MCP side reads this to catch up on pushes that arrived while no receiver was up.
    writeFileSync(join(spool.dir, 'seat.json'), JSON.stringify({ url: spec.url, table: spec.table, seat: spec.seat, token: spec.token }, null, 2), { mode: 0o600 });
    const id = await retryRegister(spec);
    console.log(`registered as ${id} for table ${spec.table}, seat ${spec.seat}`);
  } else {
    console.log('not registered (pass --url, --table, --seat and --token, or --no-register on purpose)');
  }

  // Start the spool from the ledger, not from what happened to be pushed while we were up: a host
  // that dropped a wake-up because nobody answered still has the entry.
  const link = readSeatLink(spool.dir);
  if (link) {
    const caught = await catchUp(spool, link);
    if (caught) console.log(`caught up: ${caught} wake-up(s) that arrived while the daemon was down`);
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      console.log(`seat daemon: ${sig}, closing`);
      receiver.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

async function status(flags: Record<string, string>): Promise<void> {
  const dir = defaultSpoolDir(flags);
  if (!existsSync(join(dir, 'wakes.jsonl'))) {
    console.log(`no spool at ${dir}`);
    return;
  }
  const spool = new Spool(dir);
  console.log(`spool:  ${spool.dir}`);
  console.log(`wakes:  ${spool.size} stored, ${spool.unread().length} unread`);
  console.log(`cursor: ${JSON.stringify(spool.cursor)}`);
  const { host, port } = splitHostPort(flags.listen);
  const reachable = await new Promise<boolean>((resolve) => {
    const s = createNetServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
  console.log(`listen: ${flags.listen} ${reachable ? 'free (the daemon is not listening)' : 'held (a daemon is listening)'}`);
}

async function registerOnly(flags: Record<string, string>): Promise<void> {
  const spec = subscriptionSpecFrom(flags);
  if (!spec) throw new Error('register needs --url, --table, --seat and --token');
  const id = await retryRegister(spec);
  console.log(JSON.stringify({ ok: true, id, deliverTo: spec.deliverTo }));
}

/**
 * Print the unit; do not install it. Installing is a change to this machine, and the person who
 * asked for it should see the exact text (and the token handling) before it can be enabled.
 */
async function printUnit(flags: Record<string, string>): Promise<void> {
  const { locateRepoRoot, defaultServeExec } = await import('../../../src/service.js');
  const repoRoot = locateRepoRoot(fileURLToPath(import.meta.url));
  const unit = seatServiceUnit({
    name: flags.name ?? 'convene-seat',
    repoRoot,
    exec: defaultServeExec(repoRoot),
    table: flags.table ?? 'main',
    seat: flags.seat ?? 'seat',
    spoolDir: defaultSpoolDir(flags),
  });
  console.log(unit);
  console.log('# install (after reading the above):');
  console.log(`#   convene daemon envfile --url <host> --table ${flags.table ?? 'main'} --seat ${flags.seat ?? 'seat'} --token <seat token>`);
  console.log(`#   mkdir -p ~/.config/systemd/user && convene daemon unit ... > ~/.config/systemd/user/${flags.name ?? 'convene-seat'}.service`);
  console.log(`#   systemctl --user daemon-reload && systemctl --user enable --now ${flags.name ?? 'convene-seat'}`);
  console.log('# rollback:');
  console.log(`#   systemctl --user disable --now ${flags.name ?? 'convene-seat'} && rm ~/.config/systemd/user/${flags.name ?? 'convene-seat'}.service`);
}

/** Write the env file a systemd unit reads, so the token never appears on a command line. */
async function writeEnvFile(flags: Record<string, string>): Promise<void> {
  const spec = subscriptionSpecFrom(flags);
  if (!spec) throw new Error('envfile needs --url, --table, --seat and --token');
  const dir = defaultSpoolDir(flags);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = envFilePath(dir);
  writeFileSync(file, envFileContent({
    url: spec.url, table: spec.table, seat: spec.seat, token: spec.token,
    listen: flags.listen, spoolDir: dir, wakeToken: spec.wakeToken,
  }), { mode: 0o600 });
  console.log(file);
}
