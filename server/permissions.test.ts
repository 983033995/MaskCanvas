import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';
import sharp from 'sharp';
import { ProjectPermissions } from './permissions.js';
import { createStore, StoreError } from './store.js';

const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });

it('defaults to no grants, persists scoped grants per project, and restores them after restart', async () => {
  const { root, store, project, permissions } = await fixture();
  assert.deepEqual(await permissions.list(project.id), []);
  await assert.rejects(
    permissions.assertAllowed(project.id, assertion(project.baseVersionId, '00000000-0000-4000-8000-000000000099')),
    (error: unknown) => error instanceof StoreError && error.code === 'GRANT_NOT_FOUND',
  );

  const created = await permissions.create(project.id, grantInput(project.baseVersionId));
  assert.equal(created.projectId, project.id);
  assert.equal(created.purpose, 'analysis');
  assert.equal(created.destination, 'client:codex');
  assert.equal(created.consumedJobs, 0);
  assert.equal((await permissions.get(project.id, created.id)).id, created.id);
  assert.equal((await permissions.assertAllowed(project.id, assertion(project.baseVersionId, created.id))).id, created.id);
  assert.ok(await readFile(path.join(root, project.id, 'permissions.json'), 'utf8'));

  const restored = new ProjectPermissions(createStore({ dataDir: root }));
  assert.deepEqual(await restored.list(project.id), [created]);
  const externalClientGrant = await restored.create(project.id, { ...grantInput(project.baseVersionId), destination: 'client:external-agent' });
  assert.equal(externalClientGrant.destination, 'client:external-agent');
});

it('strictly rejects malformed scopes and destinations that could identify paths or carry credentials', async () => {
  const { project, permissions } = await fixture();
  for (const destination of [
    'file:///Users/private/photo.jpg',
    '/Users/private/photo.jpg',
    'https://user:password@example.test',
    'https://example.test/path',
    'https://example.test/?token=secret',
    'https://example.test/#secret',
  ]) {
    await assert.rejects(permissions.create(project.id, { ...grantInput(project.baseVersionId), destination }));
  }
  await assert.rejects(permissions.create(project.id, { ...grantInput(project.baseVersionId), maxJobs: 1 }));
  await assert.rejects(permissions.create(project.id, { ...grantInput(project.baseVersionId), unexpected: true }));
  await assert.rejects(permissions.create(project.id, { ...grantInput(project.baseVersionId, 'generation'), backend: 'agent' }));
  await assert.rejects(permissions.create(project.id, { ...grantInput(project.baseVersionId, 'generation'), maxJobs: Number.POSITIVE_INFINITY }));
  await assert.rejects(permissions.create(project.id, { ...grantInput(project.baseVersionId, 'generation'), maxJobs: 1.5 }));
  await assert.rejects(permissions.create(project.id, { ...grantInput(project.baseVersionId), baseVersionId: 'other-version' }), /当前基准/);
});

it('atomically spends a bounded generation allowance once per project job key and restores usage', async () => {
  const { root, store, project, permissions } = await fixture();
  const input = grantInput(project.baseVersionId, 'generation');
  input.destination = 'http://127.0.0.1:8188/';
  const boundedInput = { ...input, maxJobs: 1 };
  const grant = await permissions.create(project.id, boundedInput);
  const snapshot = assertion(project.baseVersionId, grant.id, 'generation', 'qwen', 'http://127.0.0.1:8188');
  const keys = [crypto.randomUUID(), crypto.randomUUID()];
  const results = await Promise.allSettled(keys.map(key => permissions.consume(project.id, grant.id, key, withoutGrantId(snapshot))));
  const fulfilled = results.filter(result => result.status === 'fulfilled');
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(String((rejected[0] as PromiseRejectedResult).reason), /次数已用完/);

  const usedKey = keys[results.findIndex(result => result.status === 'fulfilled')]!;
  const retry = await permissions.consume(project.id, grant.id, usedKey, withoutGrantId(snapshot));
  assert.equal(retry.consumed, false);
  assert.equal(retry.grant.consumedJobs, 1);
  await assert.rejects(
    permissions.consume(project.id, '00000000-0000-4000-8000-000000000001', usedKey, withoutGrantId(snapshot)),
    (error: unknown) => error instanceof StoreError && error.code === 'GRANT_NOT_FOUND',
  );

  const restored = new ProjectPermissions(createStore({ dataDir: root }));
  assert.equal((await restored.get(project.id, grant.id)).consumedJobs, 1);
});

it('rejects reuse of an idempotency key against another grant without spending it', async () => {
  const { project, permissions } = await fixture();
  const first = await permissions.create(project.id, { ...grantInput(project.baseVersionId, 'generation'), destination: 'http://127.0.0.1:8188' });
  const second = await permissions.create(project.id, { ...grantInput(project.baseVersionId, 'generation'), destination: 'http://127.0.0.1:8189' });
  const key = crypto.randomUUID();
  await permissions.consume(project.id, first.id, key, withoutGrantId(assertion(project.baseVersionId, first.id, 'generation', 'qwen', 'http://127.0.0.1:8188')));
  await assert.rejects(
    permissions.consume(project.id, second.id, key, withoutGrantId(assertion(project.baseVersionId, second.id, 'generation', 'qwen', 'http://127.0.0.1:8189'))),
    (error: unknown) => error instanceof StoreError && error.code === 'PERMISSION_IDEMPOTENCY_CONFLICT' && error.status === 409,
  );
  assert.equal((await permissions.get(project.id, second.id)).consumedJobs, 0);
});

it('revokes immediately, scopes IDs to one project, and requires a new grant after base changes', async () => {
  const { store, project, permissions } = await fixture();
  const grant = await permissions.create(project.id, grantInput(project.baseVersionId));
  const other = await store.createProject({ name: 'Another photo', imageDataUrl: await imageDataUrl() });
  await assert.rejects(
    permissions.assertAllowed(other.id, assertion(other.baseVersionId, grant.id)),
    (error: unknown) => error instanceof StoreError && error.code === 'GRANT_NOT_FOUND',
  );

  const revoked = await permissions.revoke(project.id, grant.id);
  assert.ok(revoked.revokedAt);
  await assert.rejects(
    permissions.assertAllowed(project.id, assertion(project.baseVersionId, grant.id)),
    (error: unknown) => error instanceof StoreError && error.code === 'PERMISSION_REVOKED' && error.status === 403,
  );

  const fresh = await permissions.create(project.id, grantInput(project.baseVersionId));
  const edited = await store.saveRegions(project.id, { revision: project.revision, regions: [{
    id: 'edit', name: 'edit', kind: 'edit', intent: 'test', feather: 0, shapes: [{ type: 'rect', x: 0, y: 0, width: 1, height: 1 }],
  }] });
  const candidate = await store.importCandidate(project.id, {
    revision: edited.revision, baseVersionId: edited.baseVersionId, regionId: 'edit', imageDataUrl: await imageDataUrl(),
  });
  const version = candidate.versions.at(-1)!;
  const accepted = await store.accept(project.id, { revision: candidate.revision, versionId: version.id });
  await assert.rejects(
    permissions.assertAllowed(project.id, assertion(fresh.baseVersionId, fresh.id)),
    (error: unknown) => error instanceof StoreError && error.code === 'PERMISSION_STALE_BASE' && error.status === 409,
  );
  assert.notEqual(accepted.baseVersionId, fresh.baseVersionId);
});

it('assertAllowed only reads local project and permission files', async () => {
  const { project, permissions } = await fixture();
  const grant = await permissions.create(project.id, grantInput(project.baseVersionId));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network access is not allowed during grant assertion'); };
  try {
    assert.equal((await permissions.assertAllowed(project.id, assertion(project.baseVersionId, grant.id))).id, grant.id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maskcanvas-permissions-'));
  roots.push(root);
  const store = createStore({ dataDir: root });
  const project = await store.createProject({ name: 'permission test', imageDataUrl: await imageDataUrl() });
  return { root, store, project, permissions: new ProjectPermissions(store) };
}

function grantInput(baseVersionId: string, purpose: 'analysis' | 'generation' = 'analysis') {
  return {
    baseVersionId,
    purpose,
    backend: purpose === 'analysis' ? 'agent' as const : 'qwen' as const,
    destination: purpose === 'analysis' ? 'client:codex' : 'http://127.0.0.1:8188',
  };
}

function assertion(baseVersionId: string, grantId: string, purpose: 'analysis' | 'generation' = 'analysis', backend: 'agent' | 'qwen' | 'gpt' = 'agent', destination = 'client:codex') {
  return { grantId, baseVersionId, purpose, backend, destination };
}

function withoutGrantId(value: ReturnType<typeof assertion>) {
  const { grantId: _grantId, ...scope } = value;
  return scope;
}

async function imageDataUrl() {
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#667788' } }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}
