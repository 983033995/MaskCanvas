import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, it } from 'node:test';
import * as archiver from 'archiver';
import sharp from 'sharp';
import yauzl from 'yauzl';
import type { Region } from '../packages/shared/types.js';
import { ProposalStore } from './proposals.js';
import { createStore, StoreError } from './store.js';

const roots: string[] = [];
after(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

async function newStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maskcanvas-store-'));
  roots.push(root);
  return createStore({ dataDir: root });
}

async function pngDataUrl(width: number, height: number, color: [number, number, number, number]) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) pixels.set(color, pixel * 4);
  const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

function editRegion(shapes: Region['shapes'], feather = 0): Region {
  return { id: 'edit-region', name: '局部修改', kind: 'edit', intent: '测试候选合成', feather, shapes };
}
function rect(x: number, y: number, width: number, height: number, subtract?: boolean): Region['shapes'][number] {
  return { type: 'rect', x, y, width, height, ...(subtract ? { subtract: true } : {}) };
}

describe('Store image compositing and persistence', () => {
  it('composites only the selected region, keeps protected pixels exact, and preserves the source asset', async () => {
    const store = await newStore();
    const project = await store.createProject({ name: '保护测试', imageDataUrl: await pngDataUrl(8, 8, [10, 20, 30, 255]) });
    const source = project.versions[0];
    assert.ok(source);
    const sourceBytes = await store.readAsset(project.id, source.asset);
    const annotated = await store.saveRegions(project.id, {
      revision: project.revision,
      regions: [
        editRegion([rect(1, 1, 4, 4)]),
        { id: 'keep-region', name: '保护区', kind: 'keep', intent: '', feather: 0, shapes: [rect(2, 2, 2, 2)] },
      ],
    });
    const candidate = await store.importCandidate(project.id, {
      revision: annotated.revision,
      baseVersionId: annotated.baseVersionId,
      regionId: 'edit-region',
      imageDataUrl: await pngDataUrl(8, 8, [240, 180, 90, 255]),
    });
    const version = candidate.versions.at(-1);
    assert.equal(version?.status, 'candidate');
    assert.deepEqual(version?.validation, {
      protectedChangedPixels: 0,
      outsideEditChangedPixels: 0,
      changedPixels: 12,
      maxChannelDelta: 230,
      passed: true,
    });
    const result = await sharp(await store.readAsset(project.id, version!.asset)).raw().toBuffer();
    const input = await sharp(sourceBytes).raw().toBuffer();
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const offset = (y * 8 + x) * 4;
      const isEditable = x >= 1 && x < 5 && y >= 1 && y < 5;
      const isProtected = x >= 2 && x < 4 && y >= 2 && y < 4;
      assert.equal(result[offset], isEditable && !isProtected ? 240 : input[offset]);
    }
    assert.deepEqual(await store.readAsset(project.id, source.asset), sourceBytes);
  });

  it('stores and accepts a multi-region candidate without treating unrelated edits as authorized', async () => {
    const store = await newStore();
    const project = await store.createProject({ name: '多区计划验收', imageDataUrl: await pngDataUrl(8, 8, [0, 0, 0, 255]) });
    const annotated = await store.saveRegions(project.id, {
      revision: project.revision,
      regions: [
        { ...editRegion([rect(0, 0, 2, 2)]), id: 'edit-one' },
        { ...editRegion([rect(5, 5, 2, 2)]), id: 'edit-two' },
        { id: 'protect-one', name: '硬保护', kind: 'keep', intent: '', feather: 0, shapes: [rect(1, 1, 1, 1)] },
        { ...editRegion([rect(3, 3, 1, 1)]), id: 'manual-edit-outside-plan' },
      ],
    });
    const candidateProject = await store.importCandidate(project.id, {
      revision: annotated.revision, baseVersionId: annotated.baseVersionId,
      regionId: 'edit-one', regionIds: ['edit-one', 'edit-two'],
      imageDataUrl: await pngDataUrl(8, 8, [255, 255, 255, 255]),
    });
    const candidate = candidateProject.versions.at(-1)!;
    assert.deepEqual(candidate.regionIds, ['edit-one', 'edit-two']);
    assert.equal(candidate.validation?.passed, true);
    assert.equal(candidate.validation?.protectedChangedPixels, 0);
    assert.equal(candidate.validation?.outsideEditChangedPixels, 0);
    const result = await sharp(await store.readAsset(project.id, candidate.asset)).raw().toBuffer();
    assert.equal(result[(1 * 8 + 1) * 4], 0, 'keep pixel remains unchanged');
    assert.equal(result[(3 * 8 + 3) * 4], 0, 'manual edit outside the plan remains unchanged');
    assert.equal(result[(0 * 8 + 0) * 4], 255, 'first authorized edit is composited');
    assert.equal(result[(5 * 8 + 5) * 4], 255, 'second authorized edit is composited');
    const accepted = await store.accept(project.id, { revision: candidateProject.revision, versionId: candidate.id });
    assert.equal(accepted.baseVersionId, candidate.id);
  });

  it('validates context against clipped additive edit bounds without treating it as edit permission', async () => {
    const store = await newStore();
    const project = await store.createProject({ name: '上下文与编辑范围', imageDataUrl: await pngDataUrl(8, 8, [0, 0, 0, 255]) });
    const regions: Region[] = [
      { ...editRegion([rect(2, 2, 2, 2)]), context: { x: 0, y: 0, width: 8, height: 8 } },
      { ...editRegion([
        { type: 'brush', points: [{ x: 0, y: 0 }], radius: 3 },
        rect(6, 6, 2, 2, true),
      ]), id: 'edge-brush', context: { x: 0, y: 0, width: 3, height: 3 } },
    ];
    const saved = await store.saveRegions(project.id, { revision: project.revision, regions });
    assert.deepEqual(saved.regions[0]?.context, { x: 0, y: 0, width: 8, height: 8 });
    assert.deepEqual(saved.regions[1]?.context, { x: 0, y: 0, width: 3, height: 3 }, 'clipped brush footprint is contained, and subtract does not enlarge context');
    assert.deepEqual((await store.getProject(project.id)).regions, regions, 'project JSON round-trips context');

    await assert.rejects(store.saveRegions(project.id, {
      revision: saved.revision,
      regions: [{ ...editRegion([rect(2, 2, 2, 2)]), context: { x: 2, y: 2, width: 1, height: 1 } }],
    }), (error) => error instanceof StoreError && error.code === 'INVALID_REGIONS');
    await assert.rejects(store.saveRegions(project.id, {
      revision: saved.revision,
      regions: [{ ...editRegion([rect(2, 2, 1, 1)]), context: { x: 7, y: 0, width: 2, height: 2 } }],
    }), (error) => error instanceof StoreError && error.code === 'INVALID_REGIONS');
    await assert.rejects(store.saveRegions(project.id, {
      revision: saved.revision,
      regions: [{ ...editRegion([rect(2, 2, 1, 1)]), context: { x: 0, y: 0, width: Number.NaN, height: 4 } }],
    }), (error) => error instanceof StoreError && error.code === 'INVALID_REGIONS');
    await assert.rejects(store.saveRegions(project.id, {
      revision: saved.revision,
      regions: [{ ...editRegion([rect(2, 2, 1, 1)]), context: { x: 0, y: 0, width: 4, height: 4, token: 'unexpected' } } as Region],
    }), (error) => error instanceof StoreError && error.code === 'INVALID_REGIONS');
    await assert.rejects(store.saveRegions(project.id, {
      revision: saved.revision,
      regions: [{ id: 'keep-context', name: '保护', kind: 'keep', intent: '', feather: 0, shapes: [rect(2, 2, 1, 1)], context: { x: 0, y: 0, width: 4, height: 4 } }],
    }), (error) => error instanceof StoreError && error.code === 'INVALID_REGIONS');

    const candidate = await store.importCandidate(project.id, {
      revision: saved.revision, baseVersionId: saved.baseVersionId, regionId: 'edit-region',
      imageDataUrl: await pngDataUrl(8, 8, [255, 255, 255, 255]),
    });
    const version = candidate.versions.at(-1)!;
    assert.equal(version.validation?.changedPixels, 4, 'context does not expand the formal edit mask');
    assert.equal(version.validation?.outsideEditChangedPixels, 0);
  });

  it('allows a one-pixel selection and applies feather only inside its shape', async () => {
    const store = await newStore();
    const project = await store.createProject({ name: '1px', imageDataUrl: await pngDataUrl(8, 8, [0, 0, 0, 255]) });
    let annotated = await store.saveRegions(project.id, { revision: project.revision, regions: [editRegion([rect(3, 4, 1, 1)])] });
    let result = await store.importCandidate(project.id, { revision: annotated.revision, baseVersionId: annotated.baseVersionId, regionId: 'edit-region', imageDataUrl: await pngDataUrl(8, 8, [255, 255, 255, 255]) });
    assert.equal(result.versions.at(-1)?.validation?.changedPixels, 1);

    annotated = await store.saveRegions(project.id, { revision: annotated.revision, regions: [editRegion([rect(1, 1, 6, 6)], 2)] });
    result = await store.importCandidate(project.id, { revision: annotated.revision, baseVersionId: annotated.baseVersionId, regionId: 'edit-region', imageDataUrl: await pngDataUrl(8, 8, [255, 255, 255, 255]) });
    const asset = result.versions.at(-1)!.asset;
    const pixels = await sharp(await store.readAsset(project.id, asset)).raw().toBuffer();
    const edge = pixels[(1 * 8 + 1) * 4];
    const center = pixels[(3 * 8 + 3) * 4];
    const outside = pixels[(0 * 8 + 0) * 4];
    assert.ok(edge > 0 && edge < center, `expected feathered edge ${edge} below center ${center}`);
    assert.equal(center, 255);
    assert.equal(outside, 0);
    assert.equal(result.versions.at(-1)?.validation?.outsideEditChangedPixels, 0);
  });

  it('applies subtract shapes in order and rejects invalid coordinates and NaN', async () => {
    const store = await newStore();
    const project = await store.createProject({ name: '减选', imageDataUrl: await pngDataUrl(8, 8, [0, 0, 0, 255]) });
    const annotated = await store.saveRegions(project.id, {
      revision: project.revision,
      regions: [editRegion([rect(1, 1, 5, 5), rect(2, 2, 2, 2, true)])],
    });
    const candidate = await store.importCandidate(project.id, { revision: annotated.revision, baseVersionId: annotated.baseVersionId, regionId: 'edit-region', imageDataUrl: await pngDataUrl(8, 8, [255, 255, 255, 255]) });
    assert.equal(candidate.versions.at(-1)?.validation?.changedPixels, 21);

    await assert.rejects(store.saveRegions(project.id, { revision: annotated.revision, regions: [editRegion([rect(7, 7, 2, 2)])] }), (error) => error instanceof StoreError && error.code === 'INVALID_REGIONS');
    const bad = editRegion([{ type: 'rect', x: Number.NaN, y: 0, width: 1, height: 1 } as Region['shapes'][number]]);
    await assert.rejects(store.saveRegions(project.id, { revision: annotated.revision, regions: [bad] }), (error) => error instanceof StoreError && error.code === 'INVALID_REGIONS');
  });

  it('clips brush and eraser footprints at the photo boundary without moving the stroke centre', async () => {
    const store = await newStore();
    const project = await store.createProject({ name: '边缘笔刷', imageDataUrl: await pngDataUrl(10, 10, [0, 0, 0, 255]) });
    const region = editRegion([
      { type: 'brush', points: [{ x: 0, y: 5 }], radius: 3 },
      { type: 'brush', points: [{ x: 0, y: 5 }], radius: 1, subtract: true },
    ]);
    const annotated = await store.saveRegions(project.id, { revision: 0, regions: [region] });
    const result = await store.importCandidate(project.id, { revision: annotated.revision, baseVersionId: annotated.baseVersionId, regionId: region.id, imageDataUrl: await pngDataUrl(10, 10, [255, 255, 255, 255]) });
    const png = await store.readAsset(project.id, result.versions.at(-1)!.asset);
    const raw = await sharp(png).ensureAlpha().raw().toBuffer();
    assert.equal(raw[(5 * 10) * 4], 0, 'erase stays under original centre x=0');
    assert.equal(raw[(5 * 10 + 2) * 4], 255, 'the clipped brush reaches two pixels into the photo');
    assert.equal(raw[(5 * 10 + 4) * 4], 0, 'the brush must not be shifted to fit inside the photo');
    assert.equal(result.versions.at(-1)?.validation?.outsideEditChangedPixels, 0);
  });

  it('rejects stale candidates and never overwrites the source version', async () => {
    const store = await newStore();
    const project = await store.createProject({ name: '过期候选', imageDataUrl: await pngDataUrl(5, 5, [4, 5, 6, 255]) });
    const sourceVersion = project.versions[0]!;
    const original = await store.readAsset(project.id, sourceVersion.asset);
    const annotated = await store.saveRegions(project.id, { revision: project.revision, regions: [editRegion([rect(1, 1, 2, 2)])] });
    const candidate = await store.importCandidate(project.id, { revision: annotated.revision, baseVersionId: annotated.baseVersionId, regionId: 'edit-region', imageDataUrl: await pngDataUrl(5, 5, [200, 100, 50, 255]) });
    const version = candidate.versions.at(-1)!;
    const changed = await store.saveRegions(project.id, { revision: candidate.revision, regions: [editRegion([rect(2, 2, 2, 2)])] });
    await assert.rejects(store.accept(project.id, { revision: changed.revision, versionId: version.id }), (error) => error instanceof StoreError && error.status === 409 && error.code === 'STALE_CANDIDATE');
    assert.deepEqual(await store.readAsset(project.id, sourceVersion.asset), original);
    assert.equal((await store.getProject(project.id)).baseVersionId, project.baseVersionId);
    const imported = await store.importPackage((await store.exportPackage(project.id)).toString('base64'));
    assert.equal(imported.versions.find((item) => item.id === version.id)?.validation, undefined);
  });

  it('rejects a candidate idempotently without moving the base, changing revision, or deleting its asset', async () => {
    const store = await newStore();
    const project = await store.createProject({ name: '拒绝候选', imageDataUrl: await pngDataUrl(6, 6, [5, 10, 15, 255]) });
    const annotated = await store.saveRegions(project.id, { revision: project.revision, regions: [editRegion([rect(1, 1, 2, 2)])] });
    const withCandidate = await store.importCandidate(project.id, {
      revision: annotated.revision, baseVersionId: annotated.baseVersionId, regionId: 'edit-region',
      imageDataUrl: await pngDataUrl(6, 6, [220, 180, 90, 255]),
    });
    const candidate = withCandidate.versions.at(-1)!;
    const assetBefore = await store.readAsset(project.id, candidate.asset);
    const rejected = await store.reject(project.id, { revision: withCandidate.revision, versionId: candidate.id });
    assert.equal(rejected.baseVersionId, withCandidate.baseVersionId);
    assert.equal(rejected.revision, withCandidate.revision);
    assert.equal(rejected.versions.find(version => version.id === candidate.id)?.status, 'rejected');
    assert.deepEqual(await store.readAsset(project.id, candidate.asset), assetBefore);

    const repeated = await store.reject(project.id, { revision: rejected.revision, versionId: candidate.id });
    assert.deepEqual(repeated, rejected, 'a repeated reject with the current revision returns the unchanged project');
    assert.deepEqual(await store.readAsset(project.id, candidate.asset), assetBefore);
  });

  it('rejects stale candidates while preserving a current proposal confirmation and its base', async () => {
    const store = await newStore();
    const project = await store.createProject({ name: '拒绝不影响确认', imageDataUrl: await pngDataUrl(8, 8, [12, 34, 56, 255]) });
    const annotated = await store.saveRegions(project.id, { revision: project.revision, regions: [editRegion([rect(1, 1, 2, 2)])] });
    const candidateProject = await store.importCandidate(project.id, {
      revision: annotated.revision, baseVersionId: annotated.baseVersionId, regionId: 'edit-region',
      imageDataUrl: await pngDataUrl(8, 8, [200, 100, 50, 255]),
    });
    const candidate = candidateProject.versions.at(-1)!;
    const proposals = new ProposalStore(store);
    const draft = await proposals.create(project.id, {
      title: 'current plan', goal: 'small local edit', source: 'agent', backend: 'qwen',
      baseVersionId: candidateProject.baseVersionId, projectRevision: candidateProject.revision,
      regions: [editRegion([rect(1, 1, 2, 2)])],
      suggestions: [{ regionId: 'edit-region', reason: 'reviewed intent', enabled: true }],
    });
    const confirmed = await proposals.confirm(project.id, draft.id, { revision: draft.revision, projectRevision: candidateProject.revision });
    const beforeReject = await store.getProject(project.id);
    assert.equal(beforeReject.revision, candidateProject.revision + 1);
    assert.equal(candidate.annotationRevision, candidateProject.revision);
    const candidateBytes = await store.readAsset(project.id, candidate.asset);

    const rejected = await store.reject(project.id, { revision: beforeReject.revision, versionId: candidate.id });
    assert.equal(rejected.revision, beforeReject.revision);
    assert.equal(rejected.baseVersionId, confirmed.baseVersionId);
    assert.equal(rejected.versions.find(version => version.id === candidate.id)?.status, 'rejected');
    assert.ok(candidate.annotationRevision < rejected.revision, 'the candidate is stale against the still-confirmed project annotations');
    assert.deepEqual(await store.readAsset(project.id, candidate.asset), candidateBytes);
    const stillConfirmed = await proposals.assertConfirmed(project.id, draft.id, confirmed.confirmation!.id, 'qwen');
    assert.equal(stillConfirmed.project.revision, rejected.revision);
    assert.equal(stillConfirmed.project.baseVersionId, rejected.baseVersionId);
  });

  it('rejects original and accepted versions, and rejects a stale project revision', async () => {
    const store = await newStore();
    const project = await store.createProject({ name: '不可拒绝原图或已接受版', imageDataUrl: await pngDataUrl(6, 6, [7, 8, 9, 255]) });
    const annotated = await store.saveRegions(project.id, { revision: project.revision, regions: [editRegion([rect(1, 1, 2, 2)])] });
    const candidateProject = await store.importCandidate(project.id, {
      revision: annotated.revision, baseVersionId: annotated.baseVersionId, regionId: 'edit-region',
      imageDataUrl: await pngDataUrl(6, 6, [220, 180, 90, 255]),
    });
    const candidate = candidateProject.versions.at(-1)!;
    await assert.rejects(
      store.reject(project.id, { revision: candidateProject.revision - 1, versionId: candidate.id }),
      (error: unknown) => error instanceof StoreError && error.code === 'REVISION_CONFLICT' && error.status === 409,
    );
    await assert.rejects(
      store.reject(project.id, { revision: candidateProject.revision, versionId: project.baseVersionId }),
      (error: unknown) => error instanceof StoreError && error.code === 'CANDIDATE_NOT_REJECTABLE' && error.status === 409,
    );

    const accepted = await store.accept(project.id, { revision: candidateProject.revision, versionId: candidate.id });
    const baseVersionId = accepted.baseVersionId;
    const revision = accepted.revision;
    const versions = accepted.versions.map(version => ({ ...version }));
    const candidateBytes = await store.readAsset(project.id, candidate.asset);
    await assert.rejects(
      store.reject(project.id, { revision, versionId: candidate.id }),
      (error: unknown) => error instanceof StoreError && error.code === 'CANDIDATE_NOT_REJECTABLE' && error.status === 409,
    );
    assert.equal((await store.getProject(project.id)).baseVersionId, baseVersionId);
    assert.deepEqual((await store.getProject(project.id)).versions, versions);
    assert.deepEqual(await store.readAsset(project.id, candidate.asset), candidateBytes);
  });

  it('can retain a stale job result against its frozen region snapshot while accept still conflicts', async () => {
    const store = await newStore();
    const project = await store.createProject({ name: '冻结快照', imageDataUrl: await pngDataUrl(6, 6, [5, 10, 15, 255]) });
    const originalRegions = [editRegion([rect(1, 1, 2, 2)])];
    const annotated = await store.saveRegions(project.id, { revision: project.revision, regions: originalRegions });
    const changed = await store.saveRegions(project.id, { revision: annotated.revision, regions: [editRegion([rect(3, 3, 2, 2)])] });
    const stale = await store.importCandidate(project.id, {
      revision: annotated.revision,
      baseVersionId: annotated.baseVersionId,
      regionId: 'edit-region',
      imageDataUrl: await pngDataUrl(6, 6, [240, 240, 240, 255]),
    }, { allowStale: true, snapshotRegions: originalRegions });
    const candidate = stale.versions.at(-1)!;
    assert.equal(candidate.annotationRevision, annotated.revision);
    await assert.rejects(store.accept(project.id, { revision: changed.revision, versionId: candidate.id }), (error) => error instanceof StoreError && error.code === 'STALE_CANDIDATE');
  });

  it('deduplicates stable job candidate IDs without using a normal candidate name as its ID', async () => {
    const store = await newStore();
    const project = await store.createProject({ name: '作业幂等', imageDataUrl: await pngDataUrl(6, 6, [5, 10, 15, 255]) });
    const annotated = await store.saveRegions(project.id, {
      revision: project.revision,
      regions: [editRegion([rect(1, 1, 2, 2)]), { ...editRegion([rect(3, 3, 2, 2)]), id: 'second-edit' }],
    });
    const jobId = 'candidate-123e4567-e89b-42d3-a456-426614174000';
    const ordinary = await store.importCandidate(project.id, {
      revision: annotated.revision,
      baseVersionId: annotated.baseVersionId,
      regionId: 'edit-region',
      imageDataUrl: await pngDataUrl(6, 6, [200, 200, 200, 255]),
      name: jobId,
    });
    assert.notEqual(ordinary.versions.at(-1)?.id, jobId);
    const stable = await store.importCandidate(project.id, {
      revision: annotated.revision,
      baseVersionId: annotated.baseVersionId,
      regionId: 'second-edit',
      imageDataUrl: await pngDataUrl(6, 6, [200, 200, 200, 255]),
    }, { candidateId: jobId });
    assert.equal(stable.versions.at(-1)?.id, jobId);
    const repeated = await store.importCandidate(project.id, {
      revision: annotated.revision,
      baseVersionId: annotated.baseVersionId,
      regionId: 'second-edit',
      imageDataUrl: 'ignored-after-idempotent-match',
    }, { candidateId: jobId });
    assert.equal(repeated.versions.length, stable.versions.length);
    assert.equal(repeated.versions.filter((version) => version.id === jobId).length, 1);
    await assert.rejects(store.importCandidate(project.id, {
      revision: annotated.revision,
      baseVersionId: annotated.baseVersionId,
      regionId: 'edit-region',
      imageDataUrl: await pngDataUrl(6, 6, [200, 200, 200, 255]),
    }, { candidateId: jobId }), (error) => error instanceof StoreError && error.status === 409 && error.code === 'CANDIDATE_ID_CONFLICT');
  });

  it('recomputes reports when importing a current candidate and refuses a forged whole-image candidate at accept', async () => {
    const store = await newStore();
    const project = await store.createProject({ name: '伪造候选', imageDataUrl: await pngDataUrl(4, 4, [0, 0, 0, 255]) });
    const annotated = await store.saveRegions(project.id, { revision: project.revision, regions: [editRegion([rect(1, 1, 1, 1)])] });
    const candidateProject = await store.importCandidate(project.id, {
      revision: annotated.revision,
      baseVersionId: annotated.baseVersionId,
      regionId: 'edit-region',
      imageDataUrl: await pngDataUrl(4, 4, [255, 255, 255, 255]),
    });
    const candidate = candidateProject.versions.at(-1)!;
    assert.equal(candidate.validation?.passed, true);

    const archive = await store.exportPackage(project.id);
    const entries = await unzipEntries(archive);
    const forgedPng = Buffer.from((await pngDataUrl(4, 4, [255, 255, 255, 255])).split(',')[1]!, 'base64');
    const candidatePath = `assets/${candidate.asset}`;
    entries.set(candidatePath, forgedPng);
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as { files: Array<{ path: string; bytes: number; sha256: string }> };
    const manifestFile = manifest.files.find((file) => file.path === candidatePath)!;
    manifestFile.bytes = forgedPng.length;
    manifestFile.sha256 = createHash('sha256').update(forgedPng).digest('hex');
    entries.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));

    const forgedPackage = await zipMap(entries);
    const imported = await store.importPackage(forgedPackage.toString('base64'));
    const importedCandidate = imported.versions.find((version) => version.id === candidate.id)!;
    assert.equal(importedCandidate.validation?.passed, false);
    assert.ok(importedCandidate.validation!.outsideEditChangedPixels > 0);
    await assert.rejects(store.accept(imported.id, { revision: imported.revision, versionId: importedCandidate.id }), (error) => error instanceof StoreError && error.status === 409 && error.code === 'VALIDATION_FAILED');
    assert.equal((await store.getProject(imported.id)).baseVersionId, imported.baseVersionId);
  });

  it('keeps prior accepted versions historical while advancing the active base', async () => {
    const store = await newStore();
    const project = await store.createProject({ name: '版本历史', imageDataUrl: await pngDataUrl(5, 5, [1, 2, 3, 255]) });
    let annotated = await store.saveRegions(project.id, { revision: project.revision, regions: [editRegion([rect(1, 1, 2, 2)])] });
    let next = await store.importCandidate(project.id, { revision: annotated.revision, baseVersionId: annotated.baseVersionId, regionId: 'edit-region', imageDataUrl: await pngDataUrl(5, 5, [150, 150, 150, 255]) });
    const first = next.versions.at(-1)!;
    next = await store.accept(project.id, { revision: next.revision, versionId: first.id });
    annotated = await store.saveRegions(project.id, { revision: next.revision, regions: [editRegion([rect(2, 2, 2, 2)])] });
    next = await store.importCandidate(project.id, { revision: annotated.revision, baseVersionId: annotated.baseVersionId, regionId: 'edit-region', imageDataUrl: await pngDataUrl(5, 5, [220, 220, 220, 255]) });
    const second = next.versions.at(-1)!;
    next = await store.accept(project.id, { revision: next.revision, versionId: second.id });
    assert.equal(next.baseVersionId, second.id);
    assert.equal(next.versions.find((version) => version.id === first.id)?.status, 'accepted');
    assert.equal(next.versions.find((version) => version.id === second.id)?.status, 'accepted');
    assert.equal(next.versions[0]?.status, 'source');
    const imported = await store.importPackage((await store.exportPackage(project.id)).toString('base64'));
    const importedBase = imported.versions.find((version) => version.id === imported.baseVersionId)!;
    assert.equal(importedBase.status, 'accepted');
    assert.equal(importedBase.validation, undefined);
  });

  it('exports a hash-checked package and imports a new project while rejecting ZIP traversal', async () => {
    const store = await newStore();
    const project = await store.createProject({ name: '可移交', imageDataUrl: await pngDataUrl(4, 4, [10, 20, 30, 255]) });
    await store.saveRegions(project.id, { revision: project.revision, regions: [{ ...editRegion([rect(1, 1, 2, 2)]), context: { x: 0, y: 0, width: 4, height: 4 } }] });
    const archive = await store.exportPackage(project.id);
    const imported = await store.importPackage(archive.toString('base64'));
    assert.notEqual(imported.id, project.id);
    assert.equal(imported.name, project.name);
    assert.deepEqual(imported.regions, (await store.getProject(project.id)).regions);
    assert.equal(imported.versions.length, project.versions.length);

    const badHash = await makePackageWithBadHash();
    await assert.rejects(store.importPackage(badHash.toString('base64')), (error) => error instanceof StoreError && error.code === 'PACKAGE_HASH_MISMATCH');

    const traversal = await makeZip('../evil.js', Buffer.from('console.log("bad")'));
    await assert.rejects(store.importPackage(traversal.toString('base64')), (error) => error instanceof StoreError && error.code === 'INVALID_PACKAGE');
  });

  it('restores project state from disk after the Store is reopened', async () => {
    const store = await newStore();
    const project = await store.createProject({ name: '恢复', imageDataUrl: await pngDataUrl(3, 3, [1, 2, 3, 255]) });
    const fileBefore = await readFile(path.join(store.dataDir, project.id, 'project.json'), 'utf8');
    const reopened = createStore({ dataDir: store.dataDir });
    assert.deepEqual(await reopened.getProject(project.id), JSON.parse(fileBefore));
  });
});

async function makeZip(name: string, bytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = new archiver.ZipArchive();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    output.on('error', reject);
    archive.on('error', reject);
    output.on('end', () => resolve(Buffer.concat(chunks)));
    archive.pipe(output);
    archive.append(bytes, { name });
    archive.finalize().catch(reject);
  });
}

async function makePackageWithBadHash(): Promise<Buffer> {
  const project = Buffer.from('{"not":"a project"}');
  const manifest = Buffer.from(JSON.stringify({
    format: 'maskcanvas-package',
    schemaVersion: 1,
    projectId: 'd3b07384-d9a0-4d22-8b30-1c8c6f5d6e72',
    files: [{ path: 'project.json', bytes: project.length, sha256: '0'.repeat(64) }],
  }));
  return new Promise((resolve, reject) => {
    const archive = new archiver.ZipArchive();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    output.on('error', reject);
    archive.on('error', reject);
    output.on('end', () => resolve(Buffer.concat(chunks)));
    archive.pipe(output);
    archive.append(project, { name: 'project.json' });
    archive.append(manifest, { name: 'manifest.json' });
    archive.finalize().catch(reject);
  });
}

function unzipEntries(input: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(input, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) { reject(error ?? new Error('Unable to open ZIP')); return; }
      const output = new Map<string, Buffer>();
      zip.on('error', reject);
      zip.on('end', () => resolve(output));
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { reject(streamError ?? new Error('Unable to read ZIP entry')); return; }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => { output.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}

function zipMap(entries: Map<string, Buffer>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = new archiver.ZipArchive();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    output.on('error', reject);
    archive.on('error', reject);
    output.on('end', () => resolve(Buffer.concat(chunks)));
    archive.pipe(output);
    for (const [name, bytes] of entries) archive.append(bytes, { name });
    archive.finalize().catch(reject);
  });
}

