import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Store } from './store.js';
import { ProposalStore } from './proposals.js';
import { exportProposalDocument, importProposalDocument } from './proposal-document.js';

test('plan JSON is image-bound, does not import confirmation and preserves manual annotations', async () => {
  const store = new Store({ dataDir: await mkdtemp(path.join(os.tmpdir(), 'maskcanvas-plan-json-')) });
  const proposals = new ProposalStore(store);
  const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#abc' } }).png().toBuffer();
  const project = await store.createProject({ name: 'JSON boundary', imageDataUrl: `data:image/png;base64,${png.toString('base64')}` });
  const proposal = await proposals.create(project.id, {
    title: '局部清理', goal: '保留整体结构', source: 'agent', backend: 'qwen',
    projectRevision: project.revision, baseVersionId: project.baseVersionId,
    regions: [{ id: 'e', name: '区域', kind: 'edit', intent: '清理', feather: 1, shapes: [{ type: 'rect', x: 2, y: 3, width: 10, height: 10 }] }],
    suggestions: [{ regionId: 'e', reason: '测试建议', enabled: true }],
  });
  const document = await exportProposalDocument(store, proposals, project.id, proposal.id);
  const forged = structuredClone(document);
  forged.proposal.status = 'confirmed';
  forged.proposal.confirmation = { id: crypto.randomUUID(), confirmedAt: new Date().toISOString(), fingerprint: '0'.repeat(64), proposalRevision: 0, projectRevision: 0, baseVersionId: project.baseVersionId };
  const clone = await importProposalDocument(store, proposals, project.id, forged);
  assert.equal(clone.status, 'draft'); assert.equal(clone.confirmation, undefined); assert.notEqual(clone.id, proposal.id);
  assert.deepEqual(await store.getProject(project.id), project);
  const wrongHash = structuredClone(document); wrongHash.image.sha256 = '0'.repeat(64);
  await assert.rejects(importProposalDocument(store, proposals, project.id, wrongHash), { code: 'IMAGE_MISMATCH' });
  const wrongProject = structuredClone(document); wrongProject.projectId = crypto.randomUUID();
  await assert.rejects(importProposalDocument(store, proposals, project.id, wrongProject), { code: 'PROJECT_MISMATCH' });
  await store.saveRegions(project.id, { revision: 0, regions: [] });
  await assert.rejects(importProposalDocument(store, proposals, project.id, document), { code: 'REVISION_CONFLICT' });
});
