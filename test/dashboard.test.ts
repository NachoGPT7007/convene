// The dashboard is served from the same host as the API, so the two must not shadow each other.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { TableHost } from '../src/host.js';
import { JsonlStore } from '../src/store.js';
import { createTableServer } from '../src/server.js';

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function start() {
  const host = new TableHost(new JsonlStore(mkdtempSync(join(tmpdir(), 'byob-ui-'))));
  const server = createTableServer(host, { tickMs: 50 });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('dashboard route', () => {
  it('serves the static page at the root', async () => {
    const url = await start();
    const res = await fetch(url + '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    // The two behaviours that matter for safety: badges are scrubbed, and the page only reads.
    expect(html).toContain('safeSvg');
    expect(html).toContain('foreignObject');
  });

  it('leaves the protocol routes and unknown paths alone', async () => {
    const url = await start();
    const health = await fetch(url + '/v0.1');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ protocol: 'byob/0.1' });

    const missing = await fetch(url + '/nope');
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('E_NOT_FOUND');

    // A POST to the root is not a page request.
    const post = await fetch(url + '/', { method: 'POST' });
    expect(post.status).toBe(404);
  });
});
