import { describe, it, expect } from 'vitest';
import {
  checkNode, checkProxy, checkNoProxy, checkPort, checkData, checkSchemas, checkGithub, checkEndpoint,
  runChecks, renderChecks, type DoctorInput,
} from '../src/doctor.js';

const base = (over: Partial<DoctorInput> = {}): DoctorInput => ({
  node: 'v24.19.0',
  schemas: { name: 'schemas', status: 'ok', detail: 'loaded' },
  port: 7341,
  portFree: true,
  proxy: undefined,
  gitPinnedDirect: false,
  noProxy: undefined,
  tailnet: [],
  dataDir: './data',
  dataWritable: true,
  ...over,
});

describe('doctor', () => {
  it('passes the required node version and fails below it', () => {
    expect(checkNode('v24.19.0').status).toBe('ok');
    expect(checkNode('22.19.0').status).toBe('ok');
    expect(checkNode('v22.18.9').status).toBe('fail');
    expect(checkNode('v20.11.0').status).toBe('fail');
    expect(checkNode('not-a-version').status).toBe('warn');
  });

  it('proves the schema system works by making it reject something', () => {
    // The real schemas are loaded in this process, so this exercises the actual files.
    expect(checkSchemas().status).toBe('ok');
  });

  it('warns when git would use a proxy for github, and stops warning once pinned', () => {
    expect(checkProxy(undefined, false).status).toBe('ok');
    const warned = checkProxy('http://172.26.48.1:7890', false);
    expect(warned.status).toBe('warn');
    expect(warned.detail).toMatch(/convene doctor --github/);
    expect(checkProxy('http://172.26.48.1:7890', true).status).toBe('ok');
  });

  it('warns when a tailnet address exists but no_proxy does not exclude 100.*', () => {
    expect(checkNoProxy(undefined, []).status).toBe('info');
    const warned = checkNoProxy('localhost,127.0.0.1', ['100.64.1.2']);
    expect(warned.status).toBe('warn');
    expect(warned.detail).toContain('100.64.1.2');
    expect(checkNoProxy('localhost,100.0.0.0/8', ['100.64.1.2']).status).toBe('ok');
  });

  it('reports the port and the data directory without changing anything', () => {
    expect(checkPort(7341, true).status).toBe('ok');
    expect(checkPort(7341, false).status).toBe('warn');
    expect(checkData('./data', true).status).toBe('ok');
    expect(checkData('/nope', false).status).toBe('fail');
  });

  it('recommends pinning only when the direct road works and the proxy does not', () => {
    const ok = (d: string) => ({ ok: true, detail: d });
    const bad = (d: string) => ({ ok: false, detail: d });

    expect(checkGithub(ok('HTTP 200 in 1.2s'), ok('HTTP 200 in 1.4s')).detail).toMatch(/either path works/);
    const pin = checkGithub(ok('HTTP 200 in 1.2s'), bad('failed (timeout)'));
    expect(pin.status).toBe('ok');
    expect(pin.detail).toMatch(/pin git to direct/);
    expect(checkGithub(bad('failed (timeout)'), ok('HTTP 200 in 3s')).detail).toMatch(/leave git on the proxy/);
    expect(checkGithub(bad('x'), null).status).toBe('fail');
    expect(checkGithub(bad('x'), bad('y')).detail).toMatch(/neither path reached github/);
  });

  it('verifies a host, directly or through a proxy, and notices a protocol mismatch', () => {
    expect(checkEndpoint('http://127.0.0.1:7341', { ok: true, protocol: 'byob/0.1', tables: 2 }).detail).toMatch(/2 table\(s\) open/);
    expect(checkEndpoint('https://x', { ok: false, error: 'ECONNREFUSED' }).status).toBe('fail');
    expect(checkEndpoint('https://x', { ok: true, protocol: 'other/9' }).status).toBe('warn');
  });

  it('summarises into a readable report with counts', () => {
    const text = renderChecks(runChecks(base({ proxy: 'http://p:7890', tailnet: ['100.64.1.2'] })));
    expect(text.startsWith('convene doctor')).toBe(true);
    expect(text).toMatch(/2 warnings, 0 failures/);
    expect(
      renderChecks(runChecks(base({ node: 'v20.0.0', dataWritable: false }))),
    ).toMatch(/0 warnings, 2 failures/);
  });
});
