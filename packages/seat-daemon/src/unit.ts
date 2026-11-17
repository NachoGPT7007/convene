// A systemd --user unit for the receiver, and the env file it reads.
//
// The seat token is a credential: it goes in an EnvironmentFile with mode 0600, never on the
// command line, where the whole machine can read it from /proc. Everything that decides what the
// unit says is a pure function; the CLI only prints or writes what these return.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface SeatUnitOptions {
  /** Unit base name, without `.service`. */
  name: string;
  repoRoot: string;
  /** Absolute command line that ends up before `daemon serve`: interpreter plus its arguments. */
  exec: string[];
  table: string;
  seat: string;
  spoolDir: string;
  home?: string;
}

export const seatUnitName = (name: string) => `${name}.service`;
export const seatUnitPath = (name: string, home = homedir()) => join(home, '.config', 'systemd', 'user', seatUnitName(name));
export const envFilePath = (spoolDir: string) => join(spoolDir, 'seat-daemon.env');

const q = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

export function seatServiceUnit(o: SeatUnitOptions): string {
  return [
    '[Unit]',
    `Description=convene seat daemon for ${o.table}/${o.seat} (BYOB byob/0.1)`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${resolve(o.repoRoot)}`,
    // Optional (`-`): the daemon still starts and reports what is missing when the file is absent.
    `EnvironmentFile=-${envFilePath(resolve(o.spoolDir))}`,
    `ExecStart=${[...o.exec, 'daemon', 'serve'].map(q).join(' ')}`,
    '# A daemon that lost its host keeps the spool and retries; it must not die with the host.',
    'Restart=on-failure',
    'RestartSec=2',
    'KillSignal=SIGTERM',
    'TimeoutStopSec=10',
    'Environment="no_proxy=localhost,127.0.0.1,::1,100.64.0.0/10"',
    'Environment="NO_PROXY=localhost,127.0.0.1,::1,100.64.0.0/10"',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export interface EnvFileOptions {
  url: string;
  table: string;
  seat: string;
  token: string;
  listen: string;
  spoolDir: string;
  wakeToken?: string;
}

export function envFileContent(o: EnvFileOptions): string {
  return [
    `SEAT_DAEMON_URL=${o.url}`,
    `SEAT_DAEMON_TABLE=${o.table}`,
    `SEAT_DAEMON_SEAT=${o.seat}`,
    `SEAT_DAEMON_TOKEN=${o.token}`,
    `SEAT_DAEMON_LISTEN=${o.listen}`,
    `SEAT_DAEMON_SPOOL=${o.spoolDir}`,
    ...(o.wakeToken ? [`SEAT_DAEMON_WAKE_TOKEN=${o.wakeToken}`] : []),
    '',
  ].join('\n');
}
