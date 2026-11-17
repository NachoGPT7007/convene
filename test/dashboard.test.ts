// Routing: the meeting view is Rabbit Hole's own client, the operator page is still web/index.html,
// and the /api adapter that feeds the former is loopback-only.
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

describe('pages', () => {
  it('serves the meeting view at the root and keeps the operator page at /admin', async () => {
    const url = await start();
    const root = await fetch(url + '/');
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    const html = await root.text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    // Rabbit Hole's own document: mount point and its module, not our dashboard.
    expect(html).toContain('id="app"');
    expect(html).toContain('/app.js');
    expect(html).not.toContain('safeSvg');

    const admin = await fetch(url + '/admin');
    expect(admin.status).toBe(200);
    const adminHtml = await admin.text();
    // Still the dashboard, with the badge scrubber that keeps a signed SVG from executing.
    expect(adminHtml).toContain('safeSvg');
    expect(adminHtml).toContain('foreignObject');
  });

  it('serves the client assets the meeting page loads', async () => {
    const url = await start();
    for (const [path, type] of [['/app.js', 'javascript'], ['/style.css', 'css']]) {
      const res = await fetch(url + path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain(type);
    }
  });

  it('leaves protocol routes and unknown paths alone', async () => {
    const url = await start();
    const health = await fetch(url + '/v0.1');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ protocol: 'byob/0.1' });

    const missing = await fetch(url + '/nope');
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('E_NOT_FOUND');

    const post = await fetch(url + '/', { method: 'POST' });
    expect(post.status).toBe(404);
  });
});

describe('meeting API', () => {
  it('answers the shapes the client asks for', async () => {
    const url = await start();
    const list = await (await fetch(url + '/api/tables')).json();
    expect(list).toEqual({ meetings: [] });

    const models = await (await fetch(url + '/api/models')).json();
    expect(models).toEqual({ models: [], default: null });

    const missing = await fetch(url + '/api/tables/nope');
    expect(missing.status).toBe(404);
  });

  it('refuses writes with a reason instead of a silent 404', async () => {
    const url = await start();
    const res = await fetch(url + '/api/tables', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(405);
    expect((await res.json()).error.code).toBe('E_NOT_SUPPORTED');
  });

  it('refuses a proxied request, like the local operator interface', async () => {
    const url = await start();
    const res = await fetch(url + '/api/tables', { headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(res.status).toBe(404);
  });
});
