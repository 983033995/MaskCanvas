import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from './app.js';
import { Store } from './store.js';

test('HTTP observation requires a matching per-image analysis grant, and revocation stops access immediately', async t => {
  const store = new Store({ dataDir: await mkdtemp(path.join(os.tmpdir(), 'maskcanvas-observe-')) });
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#abc' } }).png().toBuffer();
  const project = await store.createProject({ name: 'synthetic scope', imageDataUrl: `data:image/png;base64,${png.toString('base64')}` });
  const other = await store.createProject({ name: 'other photo', imageDataUrl: `data:image/png;base64,${png.toString('base64')}` });
  const server = createApp({ store, token: 'test' }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (route: string, body: unknown, token = 'test') => {
    const response = await fetch(root + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-maskcanvas-token': token }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const prefix = `/api/projects/${project.id}`;
  assert.equal((await request(`${prefix}/permissions`, { baseVersionId: project.baseVersionId, purpose: 'analysis', backend: 'agent', destination: 'client:codex' }, 'wrong')).status, 403);
  const created = await request(`${prefix}/permissions`, { baseVersionId: project.baseVersionId, purpose: 'analysis', backend: 'agent', destination: 'client:codex' });
  assert.equal(created.status, 201);
  const assertion = { grantId: created.body.id, destination: 'client:codex' };
  const observed = await request(`${prefix}/observe`, assertion);
  assert.equal(observed.status, 200); assert.equal(observed.body.versionId, project.baseVersionId);
  const decoded = await sharp(Buffer.from(observed.body.data, 'base64')).metadata();
  assert.equal(decoded.width, 8); assert.equal(decoded.height, 8);
  assert.equal((await request(`${prefix}/observe`, { ...assertion, destination: 'client:qoder' })).status, 403);
  assert.equal((await request(`/api/projects/${other.id}/observe`, assertion)).status, 404);
  assert.equal((await request(`${prefix}/permissions/${created.body.id}/revoke`, {})).status, 200);
  const revoked = await request(`${prefix}/observe`, assertion);
  assert.equal(revoked.status, 403); assert.equal(revoked.body.error.code, 'PERMISSION_REVOKED');
});
