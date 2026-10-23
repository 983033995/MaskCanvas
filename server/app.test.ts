import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';
import sharp from 'sharp';
import { createApp } from './app.js';
import { createStore } from './store.js';

const roots: string[] = [];
after(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

it('serves the HTTP contract and requires a local origin plus session token for mutations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maskcanvas-http-'));
  roots.push(root);
  const app = createApp({ store: createStore({ dataDir: root }), token: 'test-session-token' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${baseUrl}/api/session`);
    assert.deepEqual(await session.json(), { token: 'test-session-token' });
    assert.equal(session.headers.get('cache-control'), 'no-store');
    assert.equal(session.headers.get('x-content-type-options'), 'nosniff');
    const rebound = await rawGet(`${baseUrl}/api/session`, { host: 'evil.example' });
    assert.equal(rebound.status, 403);
    assert.equal((JSON.parse(rebound.body) as { error: { code: string } }).error.code, 'LOCAL_ONLY');
    const foreignReadOrigin = await fetch(`${baseUrl}/api/session`, { headers: { origin: 'http://127.0.0.1:9999' } });
    assert.equal(foreignReadOrigin.status, 403);
    assert.equal((await foreignReadOrigin.json() as { error: { code: string } }).error.code, 'INVALID_ORIGIN');
    const capabilities = await fetch(`${baseUrl}/api/capabilities`);
    assert.equal((await capabilities.json() as { localCore: boolean; qwen: { available: boolean } }).localCore, true);

    const png = await sharp(Buffer.from([10, 20, 30, 255]), { raw: { width: 1, height: 1, channels: 4 } }).png().toBuffer();
    const imageDataUrl = `data:image/png;base64,${png.toString('base64')}`;
    const denied = await fetch(`${baseUrl}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json', host: `127.0.0.1:${address.port}` }, body: JSON.stringify({ name: 'Denied', imageDataUrl }) });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: { code: 'INVALID_SESSION', message: '会话令牌无效或已过期' } });

    const foreignOrigin = await fetch(`${baseUrl}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-maskcanvas-token': 'test-session-token', origin: 'https://evil.example', host: `127.0.0.1:${address.port}` }, body: JSON.stringify({ name: 'Denied', imageDataUrl }) });
    assert.equal(foreignOrigin.status, 403);
    assert.equal((await foreignOrigin.json() as { error: { code: string } }).error.code, 'INVALID_ORIGIN');

    const created = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-maskcanvas-token': 'test-session-token', origin: `http://127.0.0.1:${address.port}`, host: `127.0.0.1:${address.port}` },
      body: JSON.stringify({ name: 'HTTP 项目', imageDataUrl }),
    });
    assert.equal(created.status, 201);
    const project = await created.json() as { id: string; versions: Array<{ asset: string }> };
    const fetched = await fetch(`${baseUrl}/api/projects/${project.id}`);
    assert.equal(fetched.status, 200);
    const exportResponse = await fetch(`${baseUrl}/api/projects/${project.id}/export`);
    assert.equal(exportResponse.headers.get('content-type'), 'image/png');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function rawGet(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: parsed.hostname, port: parsed.port, path: `${parsed.pathname}${parsed.search}`, method: 'GET', headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });
}

