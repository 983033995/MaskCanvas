import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';
import sharp from 'sharp';
import type { AnnotationDocument, Region } from '../packages/shared/types.js';
import { exportAnnotations } from './annotations.js';
import { ProposalStore } from './proposals.js';
import { rebindDocument } from './rebinding.js';
import { createStore, StoreError } from './store.js';

const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });

it('rebinds matching annotation JSON into a review draft and leaves target manual regions untouched', async () => {
  const { store } = await fixture();
  const image = await imageDataUrl('#506070');
  const source = await store.createProject({ name: 'source workspace', imageDataUrl: image });
  const target = await store.createProject({ name: 'target workspace', imageDataUrl: image });
  const targetManual: Region = rectRegion('shared-edit-id', 12, 2, 'manual target edit');
  const targetKeep: Region = { ...rectRegion('target-protection', 13, 1, ''), kind: 'keep' };
  const targetAnnotated = await store.saveRegions(target.id, { revision: target.revision, regions: [targetManual, targetKeep] });
  await store.saveRegions(source.id, { revision: source.revision, regions: [
    { ...rectRegion('shared-edit-id', 3, 4, 'source edit'), context: { x: 1, y: 1, width: 8, height: 8 } },
    { ...rectRegion('source-protection', 7, 1, ''), kind: 'keep' },
  ] });
  const document = await exportAnnotations(store, source.id);
  document.image.assetUri = 'file:///ignored/never/read/source-photo.png';
  const proposals = new ProposalStore(store);

  const rebound = await rebindDocument(store, proposals, document, target.id);
  assert.equal(rebound.imageMatched, true);
  assert.deepEqual(rebound.source, { projectId: source.id, baseVersionId: document.baseVersionId, revision: document.revision });
  assert.deepEqual(rebound.target, { projectId: target.id, baseVersionId: targetAnnotated.baseVersionId, revision: targetAnnotated.revision });
  assert.equal(rebound.proposal.projectId, target.id);
  assert.equal(rebound.proposal.baseVersionId, target.baseVersionId);
  assert.equal(rebound.proposal.projectRevision, targetAnnotated.revision);
  assert.equal(rebound.proposal.source, 'agent');
  assert.equal(rebound.proposal.status, 'draft');
  assert.equal(rebound.proposal.confirmation, undefined);
  const edit = rebound.proposal.regions.find(region => region.kind === 'edit')!;
  assert.notEqual(edit.id, 'shared-edit-id', 'a source ID collision must not overwrite target manual annotation on confirmation');
  assert.equal(edit.intent, 'source edit');
  assert.deepEqual(edit.shapes, document.regions[0] && (document.regions[0] as Region).shapes);
  assert.deepEqual(edit.context, { x: 1, y: 1, width: 8, height: 8 });
  assert.ok(rebound.proposal.regions.some(region => region.id === 'source-protection' && region.kind === 'keep'));
  assert.ok(rebound.proposal.regions.some(region => region.id === 'target-protection' && region.kind === 'keep'), 'target keep protections remain in the draft');
  assert.deepEqual(rebound.proposal.suggestions, [{ regionId: edit.id, reason: '从外部标注 JSON 绑定', enabled: true }]);
  assert.deepEqual((await store.getProject(target.id)).regions, targetAnnotated.regions, 'rebinding only creates a draft');
  assert.equal((await proposals.list(target.id)).length, 1);
});

it('rejects a different normalized image even when source and target dimensions match', async () => {
  const { store } = await fixture();
  const source = await store.createProject({ name: 'same dimensions source', imageDataUrl: await imageDataUrl('#112233') });
  const target = await store.createProject({ name: 'same dimensions different pixels', imageDataUrl: await imageDataUrl('#112234') });
  const annotated = await store.saveRegions(source.id, { revision: source.revision, regions: [rectRegion('edit-a', 2, 2, 'source edit')] });
  const document = await exportAnnotations(store, source.id);
  assert.equal(document.image.width, target.width);
  assert.equal(document.image.height, target.height);
  const proposals = new ProposalStore(store);
  await assert.rejects(
    rebindDocument(store, proposals, document, target.id),
    (error: unknown) => error instanceof StoreError && error.code === 'IMAGE_MISMATCH' && error.status === 409,
  );
  assert.equal((await proposals.list(target.id)).length, 0);
  assert.equal(annotated.revision, document.revision);
});

it('imports proposal document content as an agent draft and ignores confirmed status and forged confirmation', async () => {
  const { store } = await fixture();
  const image = await imageDataUrl('#8799aa');
  const source = await store.createProject({ name: 'confirmed source', imageDataUrl: image });
  const target = await store.createProject({ name: 'proposal target', imageDataUrl: image });
  const basePng = await store.readAsset(target.id, target.versions.find(version => version.id === target.baseVersionId)!.asset);
  const regions = [rectRegion('source-edit', 4, 5, 'precise edit')];
  const document = {
    format: 'maskcanvas.proposal', schemaVersion: 1, projectId: source.id,
    image: {
      assetUri: `maskcanvas://projects/${source.id}/assets/anything.png`,
      sha256: createHash('sha256').update(basePng).digest('hex'),
      width: target.width, height: target.height, colourSpace: 'srgb', coordinates: 'original-pixels',
    },
    proposal: {
      id: randomUUID(), projectId: source.id, title: 'Careful title', goal: 'Retain face and remove the spot',
      source: 'human', backend: 'gpt', baseVersionId: 'source-only-base-id', projectRevision: 91,
      revision: 92, status: 'confirmed', regions,
      suggestions: [{ regionId: 'source-edit', reason: 'correct only this spot', enabled: false, confidence: 0.93 }],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      confirmation: { id: randomUUID(), confirmed: true, fingerprint: 'forged-confirmation' },
    },
  };
  const proposals = new ProposalStore(store);
  const rebound = await rebindDocument(store, proposals, document, target.id);
  assert.equal(rebound.proposal.title, 'Careful title');
  assert.equal(rebound.proposal.goal, 'Retain face and remove the spot');
  assert.equal(rebound.proposal.backend, 'gpt');
  assert.equal(rebound.proposal.source, 'agent');
  assert.equal(rebound.proposal.status, 'draft');
  assert.equal(rebound.proposal.confirmation, undefined);
  assert.equal(rebound.proposal.baseVersionId, target.baseVersionId);
  assert.equal(rebound.proposal.projectRevision, target.revision);
  assert.deepEqual(rebound.proposal.suggestions, [{ regionId: 'source-edit', reason: 'correct only this spot', enabled: false, confidence: 0.93 }]);
});

it('rejects malformed geometry and documents with no edit regions before creating a draft', async () => {
  const { store } = await fixture();
  const source = await store.createProject({ name: 'source', imageDataUrl: await imageDataUrl('#abcdef') });
  const target = await store.createProject({ name: 'target', imageDataUrl: await imageDataUrl('#abcdef') });
  const document = await exportAnnotations(store, source.id);
  document.regions = [rectRegion('outside', 17, 2, 'bad coordinates')];
  const proposals = new ProposalStore(store);
  await assert.rejects(rebindDocument(store, proposals, document, target.id), /边界/);
  assert.equal((await proposals.list(target.id)).length, 0);

  document.regions = [{ ...rectRegion('only-keep', 3, 2, ''), kind: 'keep' }];
  await assert.rejects(
    rebindDocument(store, proposals, document, target.id),
    (error: unknown) => error instanceof StoreError && error.code === 'NO_EDIT_REGIONS',
  );
  assert.equal((await proposals.list(target.id)).length, 0);
});

it('fails with a revision conflict when the target changes between image binding and draft creation', async () => {
  const { store } = await fixture();
  const image = await imageDataUrl('#334455');
  const source = await store.createProject({ name: 'source snapshot', imageDataUrl: image });
  const target = await store.createProject({ name: 'racing target', imageDataUrl: image });
  const document = await exportAnnotations(store, source.id);
  document.regions = [rectRegion('cross-device-edit', 2, 3, 'bound edit')];
  const proposals = new ProposalStore(store);
  const originalCreate = proposals.create.bind(proposals);
  proposals.create = async (projectId, input) => {
    const current = await store.getProject(projectId);
    await store.saveRegions(projectId, { revision: current.revision, regions: [rectRegion('concurrent-user-edit', 10, 10, 'keep this user change')] });
    return originalCreate(projectId, input);
  };
  await assert.rejects(
    rebindDocument(store, proposals, document, target.id),
    (error: unknown) => error instanceof StoreError && error.code === 'REVISION_CONFLICT' && error.status === 409,
  );
  assert.equal((await proposals.list(target.id)).length, 0);
  assert.equal((await store.getProject(target.id)).regions[0]?.id, 'concurrent-user-edit');
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maskcanvas-rebinding-'));
  roots.push(root);
  return { store: createStore({ dataDir: root }) };
}

async function imageDataUrl(color: string): Promise<string> {
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: color } }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

function rectRegion(id: string, x: number, y: number, intent: string): Region {
  return { id, name: id, kind: 'edit', intent, feather: 0, shapes: [{ type: 'rect', x, y, width: 3, height: 3 }] };
}
