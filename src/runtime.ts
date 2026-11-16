// What this seat is actually running on, read from the machine rather than typed into a form.
import { existsSync, readFileSync } from 'node:fs';
import { hostname, release, type } from 'node:os';

export interface Runtime {
  /** Distribution label, with the WSL marker when the process runs inside one. */
  os: string;
  host: string;
  /** The agent implementation, e.g. the card's bot name. */
  agent: string;
}

/** PRETTY_NAME from /etc/os-release; the platform and kernel when there is no such file. */
function osLabel(): string {
  try {
    if (existsSync('/etc/os-release')) {
      const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(readFileSync('/etc/os-release', 'utf8'));
      if (m) return m[1];
    }
  } catch { /* fall through to the platform */ }
  return `${type()} ${release()}`;
}

/**
 * The client fills this into the card before the owner signs it, so the table shows what a seat
 * really ran on and nobody can type a nicer answer. Two machines of one person are told apart here.
 */
/** WSL sets environment variables in an interactive shell, but not always under systemd or npx. */
function isWsl(env: NodeJS.ProcessEnv): boolean {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch { return false; }
}

export function detectRuntime(agent = 'convene-cli', env: NodeJS.ProcessEnv = process.env): Runtime {
  const wsl = isWsl(env);
  const label = osLabel();
  return {
    os: wsl ? `${label}（WSL）` : label,
    host: hostname(),
    agent,
  };
}
