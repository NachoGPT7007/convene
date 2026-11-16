#!/usr/bin/env node
// convene CLI: serve a table host, generate owner keys, create tables, join, post, read, approve.
// The wire protocol is still byob/0.1; `byob` stays available as an alias so upstream docs keep working.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TableHost } from './host.js';
import { JsonlStore } from './store.js';
import { createTableServer } from './server.js';
import { generateOwnerKeys } from './crypto.js';
import { Owner, SeatClient, createTable, renderPrefix, renderTail } from './client.js';
import { collectDms, formatInbox } from './inbox.js';
import { runChecks, renderChecks, checkSchemas, tailnetAddresses, portIsFree, gitPinnedDirectForGithub, dataDirWritable, proxyFromEnv, noProxyFromEnv, checkGithub, probeGithub, checkEndpoint, probeEndpoint } from './doctor.js';
import { serviceUnit, installService, uninstallService, serviceStatus, unitPath, unitName, defaultServeExec, repoRootFromModule, type ServiceOptions } from './service.js';

const [cmd, ...rest] = process.argv.slice(2);
const flags: Record<string, string> = {};
const pos: string[] = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? 'true' : rest[++i];
  else pos.push(rest[i]);
}
const url = flags.url ?? process.env.BYOB_URL ?? 'http://127.0.0.1:7341';
const loadOwner = (f: string) => { const k = JSON.parse(readFileSync(f, 'utf8')); return new Owner(k.id, { publicKey: k.publicKey, privateKey: k.privateKey }); };
const seatFrom = (f: string) => { const s = JSON.parse(readFileSync(f, 'utf8')); return new SeatClient(s.url, s.table, s.seat, s.token); };

/** Everything `convene service` needs, resolved from flags so the unit matches what you asked for. */
function serviceOptions(name: string): ServiceOptions {
  const repoRoot = repoRootFromModule();
  return {
    name,
    port: Number(flags.port ?? 7341),
    host: flags.host ?? '127.0.0.1',
    dataDir: resolve(flags.data ?? './data'),
    repoRoot,
    exec: defaultServeExec(repoRoot, process.execPath),
  };
}

/** `dm inbox` keeps its read cursor next to the seat file: the server cursor is shared with `read`. */
async function dmInbox(flags: Record<string, string>) {
  const seatPath = flags.seat;
  if (!seatPath) throw new Error('dm inbox requires --seat seat.json');
  const c = seatFrom(seatPath);
  const p = await c.projection(0);
  const dms = collectDms(p.tail, c.seat);
  const stateFile = `${seatPath}.inbox.json`;
  let lastSeen = 0;
  try { lastSeen = Number(JSON.parse(readFileSync(stateFile, 'utf8')).last_seen_seq) || 0; } catch { /* first run */ }
  const r = formatInbox({ me: c.seat, table: c.table, dms, lastSeen });
  console.log(r.text);
  if (!flags['keep-unread'] && r.maxSeq > lastSeen) writeFileSync(stateFile, JSON.stringify({ last_seen_seq: r.maxSeq }, null, 2) + '\n', { mode: 0o600 });
}

const usage = `convene — BYOB Table Protocol v0.1 CLI (fork of the upstream reference CLI)

  convene serve [--port 7341] [--host 127.0.0.1] [--data ./data]
  convene keygen <owner-id> --out owner.json         Ed25519 owner key (keep private)
  convene create <table-config.json>                 prints admin token
  convene join <table> --owner owner.json --seat <id> [--role r] [--bot name] [--card card.json] [--human] --out seat.json
  convene read --seat seat.json [--since N]          projection (prefix + tail)
  convene say --seat seat.json <text> [--to @x]
  convene dm --seat seat.json --to @x <text>         direct message: ledger entry, private to the recipient
  convene dm inbox --seat seat.json [--keep-unread]  read your direct messages, grouped by seat
  convene pass --seat seat.json [text]
  convene propose --seat seat.json <text> --effects '[{"owner":..,"resource":..,"action":..}]'
  convene approve <table> <task> --owner owner.json [--reject] [--reason text]
  convene mcp                                        MCP stdio bridge (env BYOB_URL, BYOB_TABLE, BYOB_OWNER_KEY_FILE)
  convene doctor [--port 7341] [--data ./data] [--url base] [--github]
                                                     read-only checks; --github measures both roads,
                                                     --url verifies a host (directly or via a proxy)
  convene service install|status|uninstall|unit [--name convene] [--port 7341] [--host 127.0.0.1] [--data ./data]
                                                     let systemd --user own the port, so the host
                                                     outlives the terminal and comes back after a reboot

  \`byob\` is kept as an alias for every subcommand above.
`;

async function run() {
  switch (cmd) {
    case 'serve': {
      const dataDir = flags.data ?? './data';
      const port = Number(flags.port ?? 7341);
      const bind = flags.host ?? '127.0.0.1';
      const host = new TableHost(new JsonlStore(dataDir));
      const server = createTableServer(host);
      server.listen(port, bind, () => {
        console.log(`convene table host on http://${bind}:${port}/v0.1 (data: ${dataDir})`);
        console.log(`  health: GET http://${bind}:${port}/v0.1`);
        if (bind === '0.0.0.0' || bind === '::') {
          // Everything is bearer-token guarded, but the surface is now reachable from the network:
          // put a proxy in front that terminates TLS and, for humans, adds its own auth.
          console.log('  warning: bound to all interfaces. Put a TLS proxy in front before exposing it.');
        }
      });
      // A table host is the single writer: close it cleanly so the ledger's last append lands whole.
      for (const sig of ['SIGINT', 'SIGTERM'] as const) {
        process.on(sig, () => {
          console.log(`\nconvene: ${sig}, closing the host`);
          server.close(() => process.exit(0));
          setTimeout(() => process.exit(0), 3000).unref();
        });
      }
      return;
    }
    case 'keygen': {
      const k = generateOwnerKeys();
      const out = flags.out ?? `${pos[0]}.owner.json`;
      writeFileSync(out, JSON.stringify({ id: pos[0], ...k }, null, 2), { mode: 0o600 });
      console.log(`wrote ${out}; public key: ${k.publicKey}`);
      return;
    }
    case 'create': return console.log(JSON.stringify(await createTable(url, JSON.parse(readFileSync(pos[0], 'utf8')))));
    case 'join': {
      const card = flags.card ? JSON.parse(readFileSync(flags.card, 'utf8')) : { bot: flags.bot ?? 'cli', capabilities: [] };
      const s = await SeatClient.join(url, pos[0], loadOwner(flags.owner), { seat: flags.seat, role: flags.role, kind: flags.human ? 'human' : 'bot', card });
      writeFileSync(flags.out ?? `${flags.seat}.seat.json`, JSON.stringify({ url, table: pos[0], seat: s.seat, token: s.token }), { mode: 0o600 });
      return console.log(`seated @${s.seat}`);
    }
    case 'read': {
      const p = await seatFrom(flags.seat).projection(flags.since ? Number(flags.since) : 0);
      return console.log(`${renderPrefix(p)}\n\nfloor: ${p.floor.holder}${p.floor.you_have_floor ? ' (you)' : ''}  round: ${p.floor.round + 1}  status: ${p.status}\n\n${renderTail(p)}`);
    }
    case 'say': return console.log(JSON.stringify(await seatFrom(flags.seat).say(pos.join(' '), { to: flags.to?.split(',') })));
    case 'dm': {
      if (pos[0] === 'inbox') return dmInbox(flags);
      if (!flags.to) throw new Error('dm requires --to @seat[,@seat]');
      return console.log(JSON.stringify(await seatFrom(flags.seat).post({ kind: 'dm', to: flags.to.split(','), body: pos.join(' ') })));
    }
    case 'pass': return console.log(JSON.stringify(await seatFrom(flags.seat).pass(pos.join(' ') || undefined)));
    case 'propose': return console.log(JSON.stringify(await seatFrom(flags.seat).propose(pos.join(' '), JSON.parse(flags.effects))));
    case 'approve': return console.log(JSON.stringify(await loadOwner(flags.owner).decide(url, pos[0], pos[1], flags.reject ? 'reject' : 'approve', flags.reason)));
    case 'mcp': { const { main } = await import('./mcp.js'); return main(); }
    case 'doctor': {
      const port = Number(flags.port ?? 7341);
      const dataDir = flags.data ?? './data';
      const proxy = proxyFromEnv();
      const checks = runChecks({
        node: process.version,
        schemas: checkSchemas(),
        port,
        portFree: await portIsFree(port),
        proxy,
        gitPinnedDirect: gitPinnedDirectForGithub(),
        noProxy: noProxyFromEnv(),
        tailnet: tailnetAddresses(),
        dataDir,
        dataWritable: dataDirWritable(dataDir),
      });
      // --github measures both roads instead of guessing: this network changes, so the answer does too.
      if (flags.github) checks.push(checkGithub(probeGithub(6), proxy ? probeGithub(6, proxy) : null));
      if (flags.url) checks.push(checkEndpoint(flags.url, await probeEndpoint(flags.url)));
      console.log(renderChecks(checks));
      if (checks.some(c => c.status === 'fail')) process.exitCode = 1;
      return;
    }
    case 'service': {
      const sub = pos[0] ?? 'status';
      const name = flags.name ?? 'convene';
      if (sub === 'status') {
        const s = serviceStatus(name);
        console.log(`unit:  ${s.installed ? s.unitFile : '(not installed)'}`);
        console.log(`state: ${s.detail}`);
        return;
      }
      if (sub === 'unit') return console.log(serviceUnit(serviceOptions(name)));
      if (sub === 'uninstall') {
        const r = uninstallService(name);
        console.log(r.ok ? `removed ${unitName(name)}` : `failed: ${r.detail}`);
        if (!r.ok) process.exitCode = 1;
        return;
      }
      if (sub !== 'install') throw new Error(`unknown service subcommand "${sub}": use install | status | uninstall | unit`);

      const o = serviceOptions(name);
      // A running unit holds the port itself; anything else holding it will make systemd fail.
      if (!(serviceStatus(name).detail === 'active') && !(await portIsFree(o.port))) {
        console.log(`port ${o.port} is already in use by something else — stop it first (convene doctor --port ${o.port})`);
        process.exitCode = 1;
        return;
      }
      const r = installService(o);
      if (r.action === 'failed') {
        console.log(`failed: ${r.detail}`);
        process.exitCode = 1;
        return;
      }
      console.log(`convene ${r.action}: ${unitName(name)} on http://${o.host}:${o.port}/v0.1`);
      console.log(`  unit:  ${r.unitFile}`);
      console.log(`  data:  ${o.dataDir}`);
      console.log(`  keeps running after logout and restarts on failure`);
      console.log(`  logs:  journalctl --user -u ${unitName(name)} -f`);
      return;
    }
    default: console.log(usage);
  }
}
run().catch(e => { console.error(e.message); process.exit(1); });
