// convene doctor: read-only checks for the things that actually bite when two machines work together.
// Every judgement lives in a pure function; the IO it needs is gathered here and passed in.
import { createServer } from 'node:net';
import { accessSync, constants, existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { spawnSync } from 'node:child_process';
import { check } from './schema.js';
import { ByobError } from './protocol.js';

export type Status = 'ok' | 'warn' | 'fail' | 'info';
export interface Check { name: string; status: Status; detail: string }

/** Upstream's floor: `engines.node` in package.json. */
export const MIN_NODE: [number, number] = [22, 19];

export function checkNode(v: string): Check {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return { name: 'node', status: 'warn', detail: `cannot parse version "${v}"` };
  const [major, minor] = [Number(m[1]), Number(m[2])];
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return { name: 'node', status: ok ? 'ok' : 'fail', detail: `${v} (needs >= ${MIN_NODE[0]}.${MIN_NODE[1]})` };
}

/** The schema module loads on import, so proving it rejects one invalid value proves it works. */
export function checkSchemas(): Check {
  try {
    check('table-config', {});
    return { name: 'schemas', status: 'warn', detail: 'loaded, but an empty table config was accepted — validation is not running' };
  } catch (err) {
    if ((err as ByobError).code === 'E_SCHEMA') return { name: 'schemas', status: 'ok', detail: 'loaded and rejecting invalid configs' };
    return { name: 'schemas', status: 'fail', detail: String((err as Error).message) };
  }
}

/**
 * A proxy in the environment is not a problem by itself; a proxy that git actually uses is.
 * Git's GnuTLS handshake to github.com fails through this proxy, so doctor asks for the pin.
 */
export function checkProxy(proxy: string | undefined, gitPinnedDirect: boolean): Check {
  if (!proxy) return { name: 'proxy', status: 'ok', detail: 'no https_proxy in the environment' };
  if (gitPinnedDirect) return { name: 'proxy', status: 'ok', detail: `${proxy} is set; git is pinned to a direct connection for github.com` };
  return {
    name: 'proxy',
    status: 'warn',
    detail: `${proxy} is set and git will use it. Clone and push to github fail their TLS handshake through this proxy; pin git instead: git config --global http.https://github.com/.proxy ""`,
  };
}

/** Design risk 1: a proxy that also swallows the tailnet turns every cross-machine call into a timeout. */
export function checkNoProxy(noProxy: string | undefined, tailnet: string[]): Check {
  if (!tailnet.length) return { name: 'no_proxy', status: 'info', detail: 'no 100.x address on this machine, nothing to exclude' };
  const excluded = (noProxy ?? '').split(',').map(s => s.trim()).some(entry => entry.startsWith('100.'));
  return excluded
    ? { name: 'no_proxy', status: 'ok', detail: `excludes 100.*; tailnet: ${tailnet.join(', ')}` }
    : { name: 'no_proxy', status: 'warn', detail: `tailnet address ${tailnet.join(', ')} exists but no_proxy has no 100.* entry: cross-machine traffic goes through the proxy and times out` };
}

export function checkPort(port: number, free: boolean): Check {
  return free
    ? { name: `port ${port}`, status: 'ok', detail: 'free' }
    : { name: `port ${port}`, status: 'warn', detail: 'in use — a table host may already be running, or pass --port' };
}

export function checkData(dir: string, writable: boolean): Check {
  return writable
    ? { name: 'data', status: 'ok', detail: `${dir} is writable` }
    : { name: 'data', status: 'fail', detail: `${dir} is not writable` };
}

export interface DoctorInput {
  node: string;
  schemas: Check;
  port: number;
  portFree: boolean;
  proxy?: string;
  gitPinnedDirect: boolean;
  noProxy?: string;
  tailnet: string[];
  dataDir: string;
  dataWritable: boolean;
}

export function runChecks(i: DoctorInput): Check[] {
  return [
    checkNode(i.node),
    i.schemas,
    checkPort(i.port, i.portFree),
    checkProxy(i.proxy, i.gitPinnedDirect),
    checkNoProxy(i.noProxy, i.tailnet),
    checkData(i.dataDir, i.dataWritable),
  ];
}

export function renderChecks(checks: Check[]): string {
  const width = Math.max(...checks.map(c => c.name.length));
  const lines = checks.map(c => `  ${c.status.padEnd(4)}  ${c.name.padEnd(width)}  ${c.detail}`);
  const count = (s: Status) => checks.filter(c => c.status === s).length;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return [
    'convene doctor',
    '',
    ...lines,
    '',
    `${count('ok')} ok, ${plural(count('warn'), 'warning')}, ${plural(count('fail'), 'failure')}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// IO the checks need. Kept here so the CLI stays a switch statement.

export function tailnetAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && a.address.startsWith('100.')) out.push(a.address);
    }
  }
  return out;
}

export function portIsFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

/** True when git is explicitly pinned to no proxy for github.com (an empty value counts as a pin). */
export function gitPinnedDirectForGithub(): boolean {
  const r = spawnSync('git', ['config', '--get', 'http.https://github.com/.proxy'], { encoding: 'utf8' });
  return r.status === 0 && (r.stdout ?? '').trim() === '';
}

/** A partner that does not exist yet is writable as long as its parent is. */
export function dataDirWritable(dir: string): boolean {
  try {
    accessSync(existsSync(dir) ? dir : '.', constants.W_OK);
    return true;
  } catch { return false; }
}

export function proxyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.https_proxy || env.HTTPS_PROXY || undefined;
}

export function noProxyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.no_proxy || env.NO_PROXY || undefined;
}
