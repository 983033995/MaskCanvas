import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';
import sharp from 'sharp';
import type { ProposalInput, Region } from '../packages/shared/types.js';
import { createApp } from './app.js';
import { ProposalStore } from './proposals.js';
import { createStore, StoreError } from './store.js';

const roots: string[] = [];
after(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

it('keeps a created and edited proposal separate from official annotations and restores it after restart', async () => {
  const { root, store, project, proposals } = await fixture();
  const input = proposalInput(project.baseVersionId, project.revision);
  const created = await proposals.create(project.id, input);
  assert.equal(created.status, 'draft');
  assert.deepEqual((await store.getProject(project.id)).regions, []);

  const edited = await proposals.update(project.id, created.id, { revision: created.revision, goal: '清理边缘并保留衣物纹理' });
  assert.equal(edited.revision, created.revision + 1);
  assert.equal(edited.confirmation, undefined);
  assert.deepEqual((await store.getProject(project.id)).regions, []);

  const restored = await new ProposalStore(store).get(project.id, created.id);
  assert.equal(restored.goal, '清理边缘并保留衣物纹理');
  assert.equal(restored.status, 'draft');
  assert.ok(await readFile(path.join(root, project.id, 'proposals.json'), 'utf8'));
});

it('confirms only enabled edits and all keep regions, and rejects forged confirmation fields', async () => {
  const { store, project, proposals } = await fixture();
  await assert.rejects(
    proposals.create(project.id, { ...proposalInput(project.baseVersionId, project.revision), confirmed: true, status: 'confirmed', confirmation: { id: crypto.randomUUID() } }),
    (error: unknown) => error instanceof StoreError && error.code === 'INVALID_PROPOSAL',
  );

  const draft = await proposals.create(project.id, proposalInput(project.baseVersionId, project.revision));
  const confirmed = await proposals.confirm(project.id, draft.id, { revision: draft.revision, projectRevision: project.revision });
  assert.equal(confirmed.status, 'confirmed');
  assert.ok(confirmed.confirmation);
  const assertion = await proposals.assertConfirmed(project.id, draft.id, confirmed.confirmation!.id, 'qwen');
  assert.deepEqual(assertion.regionIds, ['suggested-enabled', 'protect-face']);
  assert.deepEqual(assertion.project.regions.map((region) => region.id), ['suggested-enabled', 'protect-face']);
  assert.equal(assertion.project.revision, project.revision + 1);
  assert.equal((await store.getProject(project.id)).regions.some((region) => region.id === 'suggested-disabled'), false);
});

it('rejects a stale confirmation without overwriting newer annotations', async () => {
  const { store, project, proposals } = await fixture();
  const draft = await proposals.create(project.id, proposalInput(project.baseVersionId, project.revision));
  const manual = [region('manual-region', 'edit')];
  const changed = await store.saveRegions(project.id, { revision: project.revision, regions: manual });
  await assert.rejects(
    proposals.confirm(project.id, draft.id, { revision: draft.revision, projectRevision: project.revision }),
    (error: unknown) => error instanceof StoreError && error.code === 'PROPOSAL_STALE',
  );
  assert.deepEqual((await store.getProject(project.id)).regions, changed.regions);
  assert.equal((await proposals.get(project.id, draft.id)).status, 'stale');
});

it('confirmation preserves unrelated manual regions and inherited keep without authorizing other edits', async () => {
  const { store, project, proposals } = await fixture();
  const manual = await store.saveRegions(project.id, { revision: 0, regions: [region('manual-edit', 'edit'), region('manual-keep', 'keep')] });
  const input = proposalInput(manual.baseVersionId, manual.revision);
  const draft = await proposals.create(project.id, input);
  assert.ok(draft.regions.some(item => item.id === 'manual-keep'));
  const confirmed = await proposals.confirm(project.id, draft.id, { revision: draft.revision, projectRevision: manual.revision });
  const checked = await proposals.assertConfirmed(project.id, draft.id, confirmed.confirmation!.id);
  assert.ok(checked.project.regions.some(item => item.id === 'manual-edit'));
  assert.ok(!checked.regionIds.includes('manual-edit'));
  assert.ok(checked.regionIds.includes('manual-keep'));
  assert.ok(checked.regionIds.includes('protect-face'));
  assert.equal(confirmed.revision, draft.revision + 1);
  await assert.rejects(proposals.update(project.id, draft.id, { revision: draft.revision, goal: '迟到的修改' }), { code: 'PROPOSAL_REVISION_CONFLICT' });
  await assert.rejects(proposals.cancel(project.id, draft.id, { revision: draft.revision }), { code: 'PROPOSAL_REVISION_CONFLICT' });
  assert.equal((await proposals.get(project.id, draft.id)).status, 'confirmed');
});

it('refuses a plan with all suggestions disabled without changing project annotations', async () => {
  const { store, project, proposals } = await fixture();
  const input = proposalInput(project.baseVersionId, project.revision);
  input.suggestions = input.suggestions.map(item => ({ ...item, enabled: false }));
  const draft = await proposals.create(project.id, input);
  await assert.rejects(proposals.confirm(project.id, draft.id, { revision: draft.revision, projectRevision: project.revision }), { code: 'NO_ENABLED_EDITS' });
  assert.deepEqual(await store.getProject(project.id), project);
});

it('freezes the configured processing destination and model in confirmation', async () => {
  const { store, project } = await fixture();
  let target = { destination: 'http://127.0.0.1:8188', modelId: 'qwen-image-2.1-turbo' };
  const proposals = new ProposalStore(store, { processing: () => target });
  const draft = await proposals.create(project.id, proposalInput(project.baseVersionId, project.revision));
  const confirmed = await proposals.confirm(project.id, draft.id, { revision: draft.revision, projectRevision: project.revision });
  assert.deepEqual(confirmed.confirmation?.processing, target);
  await proposals.assertConfirmed(project.id, draft.id, confirmed.confirmation!.id);
  target = { ...target, destination: 'http://127.0.0.1:9999' };
  assert.equal((await proposals.get(project.id, draft.id)).status, 'stale');
  await assert.rejects(proposals.assertConfirmed(project.id, draft.id, confirmed.confirmation!.id), { code: 'CONFIRMATION_INVALID' });
});

it('rejects reusing a manual keep ID as an edit and reads stale snapshots without changing their geometry', async () => {
  const { store, project, proposals } = await fixture();
  const oldDraft = await proposals.create(project.id, proposalInput(project.baseVersionId, project.revision));
  const manual = await store.saveRegions(project.id, { revision: 0, regions: [region('suggested-enabled', 'keep')] });
  const input = proposalInput(manual.baseVersionId, manual.revision);
  await assert.rejects(proposals.create(project.id, input), { code: 'PROTECTION_CONFLICT' });
  const stale = await proposals.get(project.id, oldDraft.id);
  assert.equal(stale.status, 'stale');
  assert.deepEqual(stale.regions, oldDraft.regions);
  assert.deepEqual(await store.getProject(project.id), manual);
});

it('an interrupted confirmation remains a retryable draft and never grants generation permission', async () => {
  const { root, store, project, proposals } = await fixture();
  const draft = await proposals.create(project.id, proposalInput(project.baseVersionId, project.revision));
  const file = path.join(root, project.id, 'proposals.json');
  const originalSave = store.saveRegions.bind(store);
  let prepared = '';
  store.saveRegions = async () => { prepared = await readFile(file, 'utf8'); throw new Error('simulated project disk failure'); };
  await assert.rejects(proposals.confirm(project.id, draft.id, { revision: draft.revision, projectRevision: 0 }), /disk failure/);
  assert.deepEqual(await store.getProject(project.id), project);
  // Recreate the on-disk state of a process stopping after prepare, before the
  // project rename. A reopened ProposalStore must expose a draft, not a lease.
  await writeFile(file, prepared);
  const reopened = new ProposalStore(store);
  const recovered = await reopened.get(project.id, draft.id);
  assert.equal(recovered.status, 'draft'); assert.equal(recovered.confirmation, undefined);
  const pending = JSON.parse(prepared)[0];
  await assert.rejects(reopened.assertConfirmed(project.id, draft.id, pending.confirmation.id), { code: 'CONFIRMATION_INVALID' });
  store.saveRegions = originalSave;
  const confirmed = await reopened.confirm(project.id, draft.id, { revision: recovered.revision, projectRevision: project.revision });
  assert.equal(confirmed.status, 'confirmed');
  await reopened.assertConfirmed(project.id, draft.id, confirmed.confirmation!.id);
});

it('invalidates a confirmation after official annotations, base version, or proposal content changes', async () => {
  const { root, store, project, proposals } = await fixture();
  const draft = await proposals.create(project.id, proposalInput(project.baseVersionId, project.revision));
  const confirmed = await proposals.confirm(project.id, draft.id, { revision: draft.revision, projectRevision: project.revision });
  const confirmationId = confirmed.confirmation!.id;

  const current = await store.getProject(project.id);
  await store.saveRegions(project.id, { revision: current.revision, regions: [region('later-edit', 'edit')] });
  assert.equal((await proposals.get(project.id, draft.id)).status, 'stale');
  await assert.rejects(proposals.assertConfirmed(project.id, draft.id, confirmationId));

  const draftTwo = await proposals.create(project.id, proposalInput((await store.getProject(project.id)).baseVersionId, (await store.getProject(project.id)).revision));
  const confirmedTwo = await proposals.confirm(project.id, draftTwo.id, { revision: draftTwo.revision, projectRevision: draftTwo.projectRevision });
  const contentChanged = await proposals.update(project.id, draftTwo.id, { revision: confirmedTwo.revision, goal: '改写后的目标' });
  assert.equal(contentChanged.status, 'draft');
  await assert.rejects(proposals.assertConfirmed(project.id, draftTwo.id, confirmedTwo.confirmation!.id));

  const draftThree = await proposals.create(project.id, proposalInput((await store.getProject(project.id)).baseVersionId, (await store.getProject(project.id)).revision));
  const confirmedThree = await proposals.confirm(project.id, draftThree.id, { revision: draftThree.revision, projectRevision: draftThree.projectRevision });
  const pathToProject = path.join(root, project.id, 'project.json');
  const rawProject = JSON.parse(await readFile(pathToProject, 'utf8')) as {
    baseVersionId: string; revision: number; updatedAt: string;
    versions: Array<Record<string, unknown>>;
  };
  const nextBase = 'candidate-base-change';
  rawProject.versions.push({
    id: nextBase, name: '测试新基准', asset: `${nextBase}.png`, status: 'candidate',
    createdAt: new Date().toISOString(), baseVersionId: rawProject.baseVersionId,
    annotationRevision: rawProject.revision, regionId: 'suggested-enabled',
  });
  rawProject.baseVersionId = nextBase;
  rawProject.revision += 1;
  rawProject.updatedAt = new Date().toISOString();
  await writeFile(pathToProject, JSON.stringify(rawProject, null, 2));
  assert.equal((await proposals.get(project.id, draftThree.id)).status, 'stale');
  await assert.rejects(proposals.assertConfirmed(project.id, draftThree.id, confirmedThree.confirmation!.id));
});

it('cancels a confirmed proposal and does not leave it executable', async () => {
  const { project, proposals } = await fixture();
  const draft = await proposals.create(project.id, proposalInput(project.baseVersionId, project.revision));
  const confirmed = await proposals.confirm(project.id, draft.id, { revision: draft.revision, projectRevision: project.revision });
  const cancelled = await proposals.cancel(project.id, draft.id, { revision: confirmed.revision });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.revision, confirmed.revision + 1);
  await assert.rejects(proposals.assertConfirmed(project.id, draft.id, confirmed.confirmation!.id));
});

it('serves proposal routes while requiring the local session token for every mutation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maskcanvas-proposal-http-'));
  roots.push(root);
  const store = createStore({ dataDir: root });
  const project = await store.createProject({ name: '提议 HTTP', imageDataUrl: await imageDataUrl() });
  const app = createApp({ store, token: 'proposal-test-token' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const url = `${baseUrl}/api/projects/${project.id}/proposals`;
  const input = proposalInput(project.baseVersionId, project.revision);
  try {
    const denied = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(denied.status, 403);
    const created = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-maskcanvas-token': 'proposal-test-token' }, body: JSON.stringify(input),
    });
    assert.equal(created.status, 201);
    const proposal = await created.json() as { id: string; revision: number };
    const listed = await fetch(url);
    assert.equal(listed.status, 200);
    assert.equal((await listed.json() as Array<{ id: string }>)[0].id, proposal.id);
    const deniedCancel = await fetch(`${url}/${proposal.id}/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: proposal.revision }),
    });
    assert.equal(deniedCancel.status, 403);
    const cancelled = await fetch(`${url}/${proposal.id}/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-maskcanvas-token': 'proposal-test-token' }, body: JSON.stringify({ revision: proposal.revision }),
    });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json() as { status: string }).status, 'cancelled');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maskcanvas-proposals-'));
  roots.push(root);
  const store = createStore({ dataDir: root });
  const project = await store.createProject({ name: 'Agent 提议测试', imageDataUrl: await imageDataUrl() });
  return { root, store, project, proposals: new ProposalStore(store) };
}

function proposalInput(baseVersionId: string, projectRevision: number): ProposalInput {
  return {
    title: '清理局部边缘', goal: '修整杂乱边缘并保护五官', source: 'agent', backend: 'qwen', baseVersionId, projectRevision,
    regions: [region('suggested-enabled', 'edit'), region('suggested-disabled', 'edit'), region('protect-face', 'keep')],
    suggestions: [
      { regionId: 'suggested-enabled', reason: '边缘有零散碎发', enabled: true, confidence: 0.82 },
      { regionId: 'suggested-disabled', reason: '可选的小幅修饰', enabled: false },
    ],
  };
}

function region(id: string, kind: Region['kind']): Region {
  return { id, name: id, kind, intent: kind === 'keep' ? '保护不变' : '局部修饰', feather: 0, shapes: [{ type: 'rect', x: kind === 'keep' ? 1 : 0, y: 0, width: 1, height: 1 }] };
}

async function imageDataUrl(): Promise<string> {
  const png = await sharp(Buffer.from([20, 30, 40, 255, 50, 60, 70, 255, 80, 90, 100, 255, 110, 120, 130, 255]), { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}
