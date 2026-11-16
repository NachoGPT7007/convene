// The systemd unit is decided entirely by pure functions, so its content is tested without
// touching systemd, disk, or the user's services.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serviceUnit, unitName, unitPath, defaultServeExec, locateRepoRoot, type ServiceOptions } from '../src/service.js';

const opts = (over: Partial<ServiceOptions> = {}): ServiceOptions => ({
  name: 'convene',
  port: 7341,
  host: '127.0.0.1',
  dataDir: '/home/me/convene-data',
  repoRoot: '/home/me/convene-construction/mcode-agent-table',
  exec: ['/usr/local/bin/node', '/home/me/convene-construction/mcode-agent-table/dist/src/cli.js'],
  home: '/home/me',
  ...over,
});

describe('convene service', () => {
  it('writes a unit that serves the configured host, port and data directory', () => {
    const u = serviceUnit(opts());
    expect(u).toContain('ExecStart=/usr/local/bin/node /home/me/convene-construction/mcode-agent-table/dist/src/cli.js serve --host 127.0.0.1 --port 7341 --data /home/me/convene-data');
    expect(u).toContain('WorkingDirectory=/home/me/convene-construction/mcode-agent-table');
    expect(u).toContain('Restart=on-failure');
    expect(u).toContain('WantedBy=default.target');
    expect(u).toContain('KillSignal=SIGTERM'); // the single writer should land its last append
    expect(u).toContain('100.64.0.0/10');      // the tailnet must never be proxied
  });

  it('quotes paths that contain spaces, and only those', () => {
    const u = serviceUnit(opts({ dataDir: '/home/me/my data', repoRoot: '/home/me/re po' }));
    expect(u).toContain('--data "/home/me/my data"');
    expect(u).toContain('WorkingDirectory=/home/me/re po'); // WorkingDirectory is a single value: no quotes needed
    const plain = serviceUnit(opts());
    expect(plain).toContain('--data /home/me/convene-data');
  });

  it('names the unit `<name>.service` and places it in the user unit directory', () => {
    expect(unitName('convene')).toBe('convene.service');
    expect(unitPath('convene', '/home/me')).toBe('/home/me/.config/systemd/user/convene.service');
    expect(serviceUnit(opts({ name: 'convene-test' }))).toContain('Description=convene table host');
  });

  it('runs the source by default, and dist only when asked, so no build can go stale', () => {
    const both = mkdtempSync(join(tmpdir(), 'convene-svc-'));
    mkdirSync(join(both, 'dist', 'src'), { recursive: true });
    mkdirSync(join(both, 'node_modules', 'tsx', 'dist'), { recursive: true });
    mkdirSync(join(both, 'src'), { recursive: true });
    writeFileSync(join(both, 'dist', 'src', 'cli.js'), '// built');
    writeFileSync(join(both, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '// tsx');
    writeFileSync(join(both, 'src', 'cli.ts'), '// ts');
    const tsxCmd = ['/usr/bin/node', join(both, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(both, 'src', 'cli.ts')];
    const distCmd = ['/usr/bin/node', join(both, 'dist', 'src', 'cli.js')];

    expect(defaultServeExec(both, '/usr/bin/node')).toEqual(tsxCmd);                 // auto: source wins
    expect(defaultServeExec(both, '/usr/bin/node', 'source')).toEqual(tsxCmd);
    expect(defaultServeExec(both, '/usr/bin/node', 'dist')).toEqual(distCmd);        // explicit only

    const distOnly = mkdtempSync(join(tmpdir(), 'convene-svc-'));
    mkdirSync(join(distOnly, 'dist', 'src'), { recursive: true });
    writeFileSync(join(distOnly, 'dist', 'src', 'cli.js'), '// built');
    expect(defaultServeExec(distOnly, '/usr/bin/node')).toEqual(['/usr/bin/node', join(distOnly, 'dist', 'src', 'cli.js')]);

    const empty = mkdtempSync(join(tmpdir(), 'convene-svc-'));
    expect(() => defaultServeExec(empty)).toThrow(/npm install/);
    expect(() => defaultServeExec(empty, '/usr/bin/node', 'dist')).toThrow(/--from dist/);
  });

  it('finds this package root by walking up to the package.json that names it', () => {
    // Runs against the real checkout, so it proves the resolver on the actual layout.
    const root = locateRepoRoot(join(process.cwd(), 'dist', 'src', 'service.js'));
    expect(root).toBe(process.cwd());
  });
});
