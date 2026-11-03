import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { QwenJobs, buildQwenWorkflow, comfyUrl, cropForMask } from './qwen.js';
import { createStore } from './store.js';
import { ProposalStore } from './proposals.js';

test('Qwen workflow preserves image reference and 32-grid dimensions without resize', () => {
  const wf = buildQwenWorkflow('maskcanvas/test.png', 'remove twig', 4, 'test');
  assert.deepEqual(wf['6'].inputs.image_1, ['5', 0]);
  assert.equal(wf['6'].inputs.resolution, 0);
  const mask = new Uint8Array(100 * 60); mask[5999] = 255;
  const crop = cropForMask(mask, 100, 60);
  assert.equal(crop.left, 35); assert.equal(crop.width, 65); assert.equal(crop.paddedWidth, 96);
  assert.throws(() => cropForMask(new Uint8Array(4), 2, 2), /没有可修改/);
  assert.throws(() => comfyUrl('https://public.example/'), /不允许/);
  assert.throws(() => comfyUrl('http://127.0.0.1:8188/path'), /不允许/);
  assert.equal(comfyUrl('http://100.123.176.90:8188'), 'http://100.123.176.90:8188');
});

test('Qwen jobs persist, deduplicate, collect real pixels, and do not trust a display name', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maskcanvas-qwen-'));
  const store = createStore({ dataDir: root });
  const image = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#aaa' } }).png().toBuffer();
  let project = await store.createProject({ name: 'test', imageDataUrl: `data:image/png;base64,${image.toString('base64')}` });
  project = await store.saveRegions(project.id, { revision: project.revision, regions: [
    { id: 'edit', name: 'twig', kind: 'edit', intent: 'remove twig', feather: 0, shapes: [{ type: 'rect', x: 10, y: 10, width: 20, height: 20 }] },
    { id: 'keep', name: 'locked', kind: 'keep', intent: '', feather: 0, shapes: [{ type: 'rect', x: 15, y: 15, width: 2, height: 2 }] },
  ] });
  const output = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#dd5522' } }).png().toBuffer();
  let completed = false, posts = 0;
  const pending = new Set<string>();
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const route = req.url!;
    if (route.startsWith('/object_info/')) {
      const name = decodeURIComponent(route.slice('/object_info/'.length));
      return res.end(JSON.stringify({ [name]: { input: { required: { unet_name: [['qwen_image_2.1_turbo_int8_convrot.safetensors']], clip_name: [['qwen3vl_8b_int8_convrot.safetensors']], vae_name: [['qwen_image_2.1_vae_bf16.safetensors']] } } } }));
    }
    if (route === '/queue') return res.end(JSON.stringify({ queue_running: [...pending].map(id => [0, id]), queue_pending: [] }));
    if (route === '/upload/image') { for await (const _ of req) { /* drain upload */ } return res.end(JSON.stringify({ subfolder: 'maskcanvas', name: 'test.png' })); }
    if (route === '/prompt') {
      let data = ''; for await (const chunk of req) data += chunk;
      const body = JSON.parse(data); posts++; pending.add(body.prompt_id);
      return res.end(JSON.stringify({ prompt_id: body.prompt_id }));
    }
    if (route.startsWith('/history/')) {
      const id = route.split('/').pop()!;
      return res.end(JSON.stringify(completed ? { [id]: { status: { completed: true }, outputs: { '13': { images: [{ filename: 'test.png' }] } } } } : {}));
    }
    if (route.startsWith('/view?')) { res.setHeader('content-type', 'image/png'); return res.end(output); }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const host = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const jobs = new QwenJobs(store, { host, autoPoll: false });
  const input = { revision: project.revision, regionId: 'edit', idempotencyKey: crypto.randomUUID() };
  const job = await jobs.submit(project.id, input);
  assert.equal(job.submissionMode, 'manual-region');
  assert.equal(job.source, 'human');
  assert.equal((await jobs.submit(project.id, input)).id, job.id);
  await assert.rejects(jobs.submit(project.id, { ...input, revision: 8 }), /幂等键/);
  await jobs.tick(); assert.equal(posts, 1); assert.equal((await jobs.get(job.id)).status, 'running');
  await store.importCandidate(project.id, { revision: project.revision, baseVersionId: project.baseVersionId, regionId: 'edit', imageDataUrl: `data:image/png;base64,${image.toString('base64')}`, name: `Qwen · ${job.id}` });
  completed = true; pending.clear(); await jobs.tick();
  const collected = await jobs.get(job.id);
  assert.equal(collected.status, 'candidate'); assert.equal(collected.versionId, `candidate-${job.id}`);
  const after = await store.getProject(project.id);
  assert.equal(after.versions.length, 3);
  const version = after.versions.find(v => v.id === collected.versionId)!;
  assert.equal(version.validation?.protectedChangedPixels, 0); assert.equal(version.validation?.outsideEditChangedPixels, 0);
  assert.equal(version.validation?.changedPixels, 396);
  const restored = new QwenJobs(store, { host, autoPoll: false });
  assert.equal((await restored.get(job.id)).versionId, collected.versionId);
  await restored.tick(); assert.equal(posts, 1);

  // Simulate a crash between persisting a request and issuing /prompt. It is
  // never re-sent, but must not permanently prevent a distinct task.
  const records = JSON.parse(await readFile(path.join(root, 'jobs.json'), 'utf8'));
  records[0].status = 'reconciling'; records[0].externalId = crypto.randomUUID(); delete records[0].versionId;
  await writeFile(path.join(root, 'jobs.json'), JSON.stringify(records)); completed = false;
  const recovering = new QwenJobs(store, { host, autoPoll: false });
  await recovering.submit(project.id, { ...input, idempotencyKey: crypto.randomUUID() });
  await recovering.tick(); assert.equal(posts, 2);
  assert.equal((await recovering.get(job.id)).status, 'reconciling');
});

test('confirmed plans run edit steps in order, protect keep pixels, and accept one union-scoped candidate', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maskcanvas-plan-qwen-'));
  const store = createStore({ dataDir: root });
  const proposals = new ProposalStore(store);
  const original = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#aaaaaa' } }).png().toBuffer();
  const createdProject = await store.createProject({ name: 'confirmed multi-step plan', imageDataUrl: `data:image/png;base64,${original.toString('base64')}` });
  const project = await store.saveRegions(createdProject.id, {
    revision: createdProject.revision,
    regions: [planRegion('manual-edit-outside-plan', 'edit', 2, 48, 'previous manual annotation')],
  });
  const draft = await proposals.create(project.id, {
    title: 'two-area edit', goal: 'clean two independent details', source: 'agent', backend: 'qwen',
    baseVersionId: project.baseVersionId, projectRevision: project.revision,
    regions: [
      planRegion('edit-one', 'edit', 10, 10, 'replace first detail'),
      planRegion('protect-one', 'keep', 14, 14, ''),
      planRegion('edit-two', 'edit', 40, 40, 'replace second detail'),
    ],
    suggestions: [
      { regionId: 'edit-one', reason: 'first target', enabled: true },
      { regionId: 'edit-two', reason: 'second target', enabled: true },
    ],
  });
  const confirmed = await proposals.confirm(project.id, draft.id, { revision: draft.revision, projectRevision: project.revision });
  const generated = [
    await sharp({ create: { width: 64, height: 64, channels: 4, background: '#dd5522' } }).png().toBuffer(),
    await sharp({ create: { width: 64, height: 64, channels: 4, background: '#2255dd' } }).png().toBuffer(),
  ];
  const comfy = await planComfyMock(generated);
  t.after(() => comfy.close());
  const jobs = new QwenJobs(store, { host: comfy.host, autoPoll: false, proposals });
  const request = { proposalId: draft.id, confirmationId: confirmed.confirmation!.id, idempotencyKey: crypto.randomUUID() };
  const job = await jobs.submitPlan(project.id, request);
  assert.equal(job.submissionMode, 'confirmed-plan');
  assert.deepEqual(job.regionIds, ['edit-one', 'edit-two']);
  assert.equal(job.regionIds?.includes('manual-edit-outside-plan'), false);
  assert.equal((await jobs.submitPlan(project.id, request)).id, job.id);

  await jobs.tick();
  assert.equal(comfy.posts.length, 1);
  assert.match(comfy.posts[0].prompt['6'].inputs.prompt as string, /Overall editing goal:.*\nLocal instruction for this step: replace first detail/);
  comfy.complete(0);
  await jobs.tick();
  assert.equal(comfy.posts.length, 2);
  assert.match(comfy.posts[1].prompt['6'].inputs.prompt as string, /Overall editing goal:.*\nLocal instruction for this step: replace second detail/);
  assert.equal((await jobs.get(job.id)).stepIndex, 1);
  assert.equal((await jobs.get(job.id)).completedStepCount, 1);

  const secondInput = await sharp(comfy.uploads[1]).raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => [...secondInput.data.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 3)];
  assert.deepEqual(pixel(11, 11), [221, 85, 34], 'second prompt must see the first step in its input image');
  assert.deepEqual(pixel(15, 15), [170, 170, 170], 'keep pixels must stay unchanged in intermediate inputs');
  assert.deepEqual(pixel(41, 41), [170, 170, 170], 'the next edit region must not be changed by the first step');

  comfy.complete(1);
  await jobs.tick();
  const completed = await jobs.get(job.id);
  assert.equal(completed.status, 'candidate');
  assert.equal(completed.completedStepCount, 2);
  assert.equal(completed.stepIndex, 1);
  assert.equal(completed.stepCount, 2);
  const result = await store.getProject(project.id);
  const candidate = result.versions.find((version) => version.id === completed.versionId)!;
  assert.deepEqual(candidate.regionIds, ['edit-one', 'edit-two']);
  assert.equal(candidate.regionIds?.includes('manual-edit-outside-plan'), false);
  assert.equal(candidate.validation?.passed, true);
  assert.equal(candidate.validation?.protectedChangedPixels, 0);
  assert.equal(candidate.validation?.outsideEditChangedPixels, 0);
  const candidateRaw = await sharp(await store.readAsset(project.id, candidate.asset)).raw().toBuffer({ resolveWithObject: true });
  const finalPixel = (x: number, y: number) => [...candidateRaw.data.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 3)];
  assert.deepEqual(finalPixel(11, 11), [221, 85, 34]);
  assert.deepEqual(finalPixel(15, 15), [170, 170, 170]);
  assert.deepEqual(finalPixel(41, 41), [34, 85, 221]);
  await store.accept(project.id, { revision: result.revision, versionId: candidate.id });
  assert.equal((await store.getProject(project.id)).baseVersionId, candidate.id);
  jobs.close();
});

test('plan execution requires server confirmation and stops before the next step when the plan becomes stale', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maskcanvas-plan-stale-'));
  const store = createStore({ dataDir: root });
  const proposals = new ProposalStore(store);
  const image = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#aaaaaa' } }).png().toBuffer();
  const project = await store.createProject({ name: 'stale plan', imageDataUrl: `data:image/png;base64,${image.toString('base64')}` });
  const draft = await proposals.create(project.id, planInput(project.baseVersionId, project.revision));
  const comfy = await planComfyMock([
    await sharp({ create: { width: 64, height: 64, channels: 4, background: '#dd5522' } }).png().toBuffer(),
    await sharp({ create: { width: 64, height: 64, channels: 4, background: '#2255dd' } }).png().toBuffer(),
  ]);
  t.after(() => comfy.close());
  const jobs = new QwenJobs(store, { host: comfy.host, autoPoll: false, proposals });
  const unconfirmed = { proposalId: draft.id, confirmationId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
  await assert.rejects(jobs.submitPlan(project.id, { ...unconfirmed, confirmed: true }), /计划作业需要有效/);
  await assert.rejects(jobs.submitPlan(project.id, unconfirmed), /确认已失效/);
  assert.equal(comfy.posts.length, 0);

  const confirmed = await proposals.confirm(project.id, draft.id, { revision: draft.revision, projectRevision: project.revision });
  const job = await jobs.submitPlan(project.id, { ...unconfirmed, confirmationId: confirmed.confirmation!.id });
  await jobs.tick();
  assert.equal(comfy.posts.length, 1);

  const latest = await store.getProject(project.id);
  await store.saveRegions(project.id, { revision: latest.revision, regions: [planRegion('manual-only', 'edit', 2, 2, 'manual change')] });
  comfy.complete(0);
  await jobs.tick();
  const stopped = await jobs.get(job.id);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.completedStepCount, 1);
  assert.equal(stopped.stepIndex, 0, 'terminal jobs retain the last completed zero-based step index');
  assert.match(stopped.error ?? '', /保留 1\/2 步/);
  assert.equal(comfy.posts.length, 1, 'staleness must prevent a second /prompt request');
  assert.ok(await readFile(path.join(root, '.job-results', job.id, 'step-0-output.png')));
  assert.ok(await readFile(path.join(root, '.job-results', job.id, 'step-0-composite.png')));
  jobs.close();
});

test('a final result already accepted by Comfy is retained as a stale non-acceptable candidate after revocation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maskcanvas-plan-final-stale-'));
  const store = createStore({ dataDir: root });
  const proposals = new ProposalStore(store);
  const image = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#aaaaaa' } }).png().toBuffer();
  const project = await store.createProject({ name: 'final stale output', imageDataUrl: `data:image/png;base64,${image.toString('base64')}` });
  const draft = await proposals.create(project.id, planInput(project.baseVersionId, project.revision));
  const confirmed = await proposals.confirm(project.id, draft.id, { revision: draft.revision, projectRevision: project.revision });
  const comfy = await planComfyMock([
    await sharp({ create: { width: 64, height: 64, channels: 4, background: '#dd5522' } }).png().toBuffer(),
    await sharp({ create: { width: 64, height: 64, channels: 4, background: '#2255dd' } }).png().toBuffer(),
  ]);
  t.after(() => comfy.close());
  const jobs = new QwenJobs(store, { host: comfy.host, autoPoll: false, proposals });
  const job = await jobs.submitPlan(project.id, { proposalId: draft.id, confirmationId: confirmed.confirmation!.id, idempotencyKey: crypto.randomUUID() });
  await jobs.tick(); comfy.complete(0); await jobs.tick();
  assert.equal(comfy.posts.length, 2, 'step two is the only in-flight Comfy operation');
  const latest = await store.getProject(project.id);
  await store.saveRegions(project.id, { revision: latest.revision, regions: [planRegion('late-manual-change', 'edit', 2, 2, 'new user scope')] });
  comfy.complete(1); await jobs.tick();
  const terminal = await jobs.get(job.id);
  assert.equal(terminal.status, 'candidate');
  assert.equal(terminal.completedStepCount, 2);
  assert.match(terminal.error ?? '', /不可接受的过期候选/);
  const current = await store.getProject(project.id);
  const candidate = current.versions.find((version) => version.id === terminal.versionId)!;
  assert.equal(candidate.stale, true);
  assert.ok(await store.readAsset(project.id, candidate.asset));
  await assert.rejects(store.accept(project.id, { revision: current.revision, versionId: candidate.id }), /确认已失效/);
  assert.equal(comfy.posts.length, 2);
  jobs.close();
});

test('plan jobs recover a persisted step and never duplicate its Comfy prompt', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maskcanvas-plan-recover-'));
  const store = createStore({ dataDir: root });
  const proposals = new ProposalStore(store);
  const image = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#aaaaaa' } }).png().toBuffer();
  const project = await store.createProject({ name: 'recover plan', imageDataUrl: `data:image/png;base64,${image.toString('base64')}` });
  const draft = await proposals.create(project.id, planInput(project.baseVersionId, project.revision));
  const confirmed = await proposals.confirm(project.id, draft.id, { revision: draft.revision, projectRevision: project.revision });
  const comfy = await planComfyMock([
    await sharp({ create: { width: 64, height: 64, channels: 4, background: '#dd5522' } }).png().toBuffer(),
    await sharp({ create: { width: 64, height: 64, channels: 4, background: '#2255dd' } }).png().toBuffer(),
  ]);
  t.after(() => comfy.close());
  const request = { proposalId: draft.id, confirmationId: confirmed.confirmation!.id, idempotencyKey: crypto.randomUUID() };
  const first = new QwenJobs(store, { host: comfy.host, autoPoll: false, proposals });
  const job = await first.submitPlan(project.id, request);
  await first.tick();
  assert.equal(comfy.posts.length, 1);

  const recovered = new QwenJobs(store, { host: comfy.host, autoPoll: false, proposals });
  assert.equal((await recovered.submitPlan(project.id, request)).id, job.id);
  await recovered.tick();
  assert.equal(comfy.posts.length, 1, 'restart must query the saved externalId rather than submit again');
  comfy.complete(0);
  await recovered.tick();
  assert.equal(comfy.posts.length, 2, 'only the next confirmed plan step may be submitted');
  assert.equal((await recovered.get(job.id)).stepIndex, 1);
  comfy.complete(1);
  const importCandidate = store.importCandidate.bind(store);
  let simulateCrash = true;
  store.importCandidate = async (...args: Parameters<typeof store.importCandidate>) => {
    if (simulateCrash) { simulateCrash = false; throw new Error('simulated process interruption after step composite persistence'); }
    return importCandidate(...args);
  };
  await recovered.tick();
  const interrupted = await recovered.get(job.id);
  assert.equal(interrupted.status, 'reconciling');
  const stableCompositePath = path.join(root, '.job-results', job.id, 'step-1-composite.png');
  const compositeBeforeReplay = await readFile(stableCompositePath);
  store.importCandidate = importCandidate;

  // The immutable second-step composite is durable, but the candidate and
  // terminal job checkpoint have not been written. Reconcile the same history.
  const replay = new QwenJobs(store, { host: comfy.host, autoPoll: false, proposals });
  await replay.tick();
  assert.equal(comfy.posts.length, 2, 'reconciliation reuses the accepted prompt');
  const candidateJob = await recovered.get(job.id);
  assert.equal(candidateJob.status, 'reconciling');
  const recoveredJob = await replay.get(job.id);
  assert.equal(recoveredJob.status, 'candidate');
  const projectAfterCandidate = await store.getProject(project.id);
  const candidate = projectAfterCandidate.versions.find((version) => version.id === recoveredJob.versionId)!;
  const candidateBytes = await store.readAsset(project.id, candidate.asset);
  assert.deepEqual(await readFile(stableCompositePath), compositeBeforeReplay, 'a recovered step reads its prior composite and does not feather twice');
  assert.deepEqual(await store.readAsset(project.id, candidate.asset), candidateBytes, 'replaying a step cannot feather its output twice');
  first.close(); recovered.close(); replay.close();
});

test('a temporary Comfy queue failure uses a finite backoff instead of failing the plan immediately', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maskcanvas-plan-retry-'));
  const store = createStore({ dataDir: root });
  const proposals = new ProposalStore(store);
  const image = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#aaaaaa' } }).png().toBuffer();
  const project = await store.createProject({ name: 'retry plan', imageDataUrl: `data:image/png;base64,${image.toString('base64')}` });
  const draft = await proposals.create(project.id, planInput(project.baseVersionId, project.revision));
  const confirmed = await proposals.confirm(project.id, draft.id, { revision: draft.revision, projectRevision: project.revision });
  const comfy = await planComfyMock([
    await sharp({ create: { width: 64, height: 64, channels: 4, background: '#dd5522' } }).png().toBuffer(),
    await sharp({ create: { width: 64, height: 64, channels: 4, background: '#2255dd' } }).png().toBuffer(),
  ]);
  t.after(() => comfy.close());
  comfy.failQueues(1);
  const jobs = new QwenJobs(store, { host: comfy.host, autoPoll: false, proposals });
  const job = await jobs.submitPlan(project.id, { proposalId: draft.id, confirmationId: confirmed.confirmation!.id, idempotencyKey: crypto.randomUUID() });
  await jobs.tick();
  const retrying = await jobs.get(job.id);
  assert.equal(retrying.status, 'queued');
  assert.match(retrying.error ?? '', /有限重试 \(1\/4\)/);
  assert.equal(comfy.posts.length, 0);
  await jobs.tick();
  assert.equal(comfy.posts.length, 0, 'the retry timestamp must prevent a tight loop');
  await new Promise((resolve) => setTimeout(resolve, 300));
  await jobs.tick();
  assert.equal(comfy.posts.length, 1);
  assert.equal((await jobs.get(job.id)).status, 'running');
  jobs.close();
});

test('automatic polling explains an external GPU wait and completes the original plan without another submit', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maskcanvas-auto-continue-'));
  const store = createStore({ dataDir: root });
  const proposals = new ProposalStore(store);
  const image = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#aaa' } }).png().toBuffer();
  const project = await store.createProject({ name: 'automatic continuation', imageDataUrl: `data:image/png;base64,${image.toString('base64')}` });
  const draft = await proposals.create(project.id, planInput(project.baseVersionId, 0));
  const confirmed = await proposals.confirm(project.id, draft.id, { revision: 0, projectRevision: 0 });
  const comfy = await planComfyMock([image, image]);
  t.after(() => comfy.close());
  comfy.externalBusy(true);
  const jobs = new QwenJobs(store, { host: comfy.host, proposals, pollMs: 20 });
  t.after(() => jobs.close());
  const job = await jobs.submitPlan(project.id, { proposalId: draft.id, confirmationId: confirmed.confirmation!.id, idempotencyKey: crypto.randomUUID() });
  const until = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 5000;
    while (!await check()) {
      if (Date.now() > deadline) throw new Error('automatic polling did not reach the expected state');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  await until(async () => Boolean((await jobs.get(job.id)).waitReason));
  assert.match((await jobs.get(job.id)).waitReason!, /ComfyUI 空闲.*1 个运行任务/);
  assert.equal((await jobs.get(job.id)).status, 'queued');
  assert.equal(comfy.posts.length, 0);
  const persisted = JSON.parse(await readFile(path.join(root, 'jobs.json'), 'utf8'));
  assert.match(persisted[0].waitReason, /无需再次提交/);
  comfy.externalBusy(false);
  await until(async () => (await jobs.get(job.id)).status === 'running');
  assert.equal((await jobs.get(job.id)).waitReason, undefined);
  assert.equal(comfy.posts.length, 1);
  comfy.complete(0);
  await until(async () => comfy.posts.length === 2);
  comfy.complete(1);
  await until(async () => (await jobs.get(job.id)).status === 'candidate');
  assert.equal(comfy.posts.length, 2, 'each original plan step is submitted once without another client action');
  assert.equal((await jobs.list(project.id)).length, 1);
});

function planRegion(id: string, kind: 'edit' | 'keep', x: number, y: number, intent: string) {
  return { id, name: id, kind, intent, feather: 0, shapes: [{ type: 'rect' as const, x, y, width: 16, height: 16 }] };
}

function planInput(baseVersionId: string, projectRevision: number) {
  return {
    title: 'two-step plan', goal: 'edit two areas in sequence', source: 'agent' as const, backend: 'qwen' as const,
    baseVersionId, projectRevision,
    regions: [planRegion('edit-one', 'edit', 10, 10, 'step one'), planRegion('protect-one', 'keep', 14, 14, ''), planRegion('edit-two', 'edit', 40, 40, 'step two')],
    suggestions: [{ regionId: 'edit-one', reason: 'one', enabled: true }, { regionId: 'edit-two', reason: 'two', enabled: true }],
  };
}

async function planComfyMock(outputs: Buffer[]) {
  const prompts: Array<{ prompt_id: string; prompt: ReturnType<typeof buildQwenWorkflow> }> = [];
  const completed = new Set<string>();
  const uploads: Buffer[] = [];
  let uploadCount = 0;
  let queueFailures = 0;
  let externalBusy = false;
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    const route = request.url ?? '';
    if (route.startsWith('/object_info/')) {
      const name = decodeURIComponent(route.slice('/object_info/'.length));
      return response.end(JSON.stringify({ [name]: { input: { required: { unet_name: [['qwen_image_2.1_turbo_int8_convrot.safetensors']], clip_name: [['qwen3vl_8b_int8_convrot.safetensors']], vae_name: [['qwen_image_2.1_vae_bf16.safetensors']] } } } }));
    }
    if (route === '/queue') {
      if (queueFailures > 0) { queueFailures--; response.statusCode = 503; return response.end('{}'); }
      return response.end(JSON.stringify({ queue_running: [...(externalBusy ? [[0, 'another-project-job']] : []), ...prompts.filter((prompt) => !completed.has(prompt.prompt_id)).map((prompt) => [0, prompt.prompt_id])], queue_pending: [] }));
    }
    if (route === '/upload/image') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const marker = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const start = body.indexOf(marker);
      const end = body.indexOf(Buffer.from('\r\n--'), start);
      assert.ok(start >= 0 && end > start, 'multipart upload must contain the PNG input image');
      uploads.push(body.subarray(start, end));
      return response.end(JSON.stringify({ subfolder: 'maskcanvas', name: `upload-${uploadCount++}.png` }));
    }
    if (route === '/prompt') {
      let body = ''; for await (const chunk of request) body += chunk;
      prompts.push(JSON.parse(body));
      return response.end(JSON.stringify({ prompt_id: prompts.at(-1)!.prompt_id }));
    }
    if (route.startsWith('/history/')) {
      const id = decodeURIComponent(route.slice('/history/'.length));
      if (!completed.has(id)) return response.end('{}');
      const index = prompts.findIndex((prompt) => prompt.prompt_id === id);
      return response.end(JSON.stringify({ [id]: { status: { completed: true }, outputs: { '13': { images: [{ filename: `result-${index}.png` }] } } } }));
    }
    if (route.startsWith('/view?')) {
      response.setHeader('content-type', 'image/png');
      const filename = new URL(`http://127.0.0.1${route}`).searchParams.get('filename') ?? '';
      const index = Number(filename.match(/result-(\d+)\.png/)?.[1]);
      return response.end(outputs[index]);
    }
    response.statusCode = 404; return response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    host: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    posts: prompts,
    uploads,
    failQueues(count: number) { queueFailures = count; },
    externalBusy(value: boolean) { externalBusy = value; },
    complete(index: number) { if (prompts[index]) completed.add(prompts[index].prompt_id); },
    close() { server.close(); },
  };
}
