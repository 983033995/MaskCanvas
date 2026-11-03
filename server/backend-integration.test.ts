import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';
import sharp from 'sharp';
import { ProjectPermissions } from './permissions.js';
import { ProposalStore } from './proposals.js';
import { QwenJobs, comfyUrl, imageProcessingConfiguration } from './qwen.js';
import type { ImageProcessingConfiguration } from './qwen.js';
import { createStore, StoreError } from './store.js';

const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });

it('binds configured GPT permission destination to the actual Comfy upload origin', () => {
  for (const host of ['http://10.example.test', 'http://192.168.example.test', 'http://100.64.example.test']) assert.throws(() => comfyUrl(host), /不允许公网/);
  assert.equal(comfyUrl('http://100.123.176.90:8188'), 'http://100.123.176.90:8188');
  const env = { COMFYUI_IMAGE_SERVER_URL: 'http://127.0.0.1:8188', MASKCANVAS_GPT_DESTINATION: 'https://unrelated.example.test', MASKCANVAS_ALLOW_REMOTE_GENERATION: '1' };
  assert.throws(() => imageProcessingConfiguration(env), /实际上传/);
  const configured = imageProcessingConfiguration({ ...env, MASKCANVAS_GPT_DESTINATION: 'http://127.0.0.1:8188' });
  assert.equal(configured.remoteGenerationEnabled, true);
  assert.equal(configured.gpt?.destination, configured.qwen?.destination);
});

it('executes a confirmed GPT plan through the verified Comfy node schema, preserves scope and consumes one grant once', async t => {
  const fixture = await createFixture();
  t.after(() => { fixture.jobs.close(); fixture.mock.close(); });
  const correctGrant = await fixture.permissions.create(fixture.project.id, {
    baseVersionId: fixture.project.baseVersionId, purpose: 'generation', backend: 'gpt',
    destination: 'https://images.example.test', maxJobs: 1,
  });
  const noGrant = { proposalId: fixture.proposal.id, confirmationId: fixture.confirmation.confirmation!.id, idempotencyKey: crypto.randomUUID() };
  await assert.rejects(
    fixture.jobs.submitPlan(fixture.project.id, noGrant),
    (error: unknown) => error instanceof StoreError && error.code === 'GENERATION_PERMISSION_REQUIRED' && error.status === 403,
  );

  const analysisGrant = await fixture.permissions.create(fixture.project.id, {
    baseVersionId: fixture.project.baseVersionId, purpose: 'analysis', backend: 'agent', destination: 'client:codex',
  });
  await assert.rejects(
    fixture.jobs.submitPlan(fixture.project.id, { ...noGrant, idempotencyKey: crypto.randomUUID(), grantId: analysisGrant.id }),
    (error: unknown) => error instanceof StoreError && error.code === 'PERMISSION_SCOPE_MISMATCH',
  );
  const wrongDestinationGrant = await fixture.permissions.create(fixture.project.id, {
    baseVersionId: fixture.project.baseVersionId, purpose: 'generation', backend: 'gpt', destination: 'https://other.example.test',
  });
  await assert.rejects(
    fixture.jobs.submitPlan(fixture.project.id, { ...noGrant, idempotencyKey: crypto.randomUUID(), grantId: wrongDestinationGrant.id }),
    (error: unknown) => error instanceof StoreError && error.code === 'PERMISSION_SCOPE_MISMATCH',
  );
  assert.equal(fixture.mock.prompts.length, 0, 'missing or mismatched grants must not submit a prompt');

  const request = { ...noGrant, grantId: correctGrant.id };
  const job = await fixture.jobs.submitPlan(fixture.project.id, request);
  assert.equal(job.backend, 'gpt');
  assert.equal(job.destination, 'https://images.example.test');
  assert.equal(job.modelId, 'gpt-image-2.5-flare');
  assert.equal(job.grantId, correctGrant.id);
  assert.equal(job.stepCount, 1);
  const duplicate = await fixture.jobs.submitPlan(fixture.project.id, request);
  assert.equal(duplicate.id, job.id);
  assert.equal((await fixture.permissions.get(fixture.project.id, correctGrant.id)).consumedJobs, 1, 'retrying the same plan key does not spend another grant use');
  await assert.rejects(
    fixture.jobs.submitPlan(fixture.project.id, { ...request, idempotencyKey: crypto.randomUUID() }),
    (error: unknown) => error instanceof StoreError && error.code === 'PERMISSION_LIMIT_REACHED',
  );

  await fixture.jobs.tick();
  assert.equal(fixture.mock.prompts.length, 1);
  const prompt = fixture.mock.prompts[0]!.prompt;
  const edit = prompt['6']!.inputs;
  assert.equal(prompt['6']!.class_type, 'CLIProxyAPIGPTImage2');
  assert.equal(edit.provider_model, 'gpt-image-2.5-flare (OpenAI Commercial)');
  assert.equal(edit.mode, 'edit');
  assert.equal(edit.aspect_ratio, '1:1');
  assert.equal(edit.size_hint, '1K');
  assert.deepEqual(edit.image, ['5', 0]);
  const uploaded = await sharp(fixture.mock.uploads[0]!).metadata();
  assert.equal(uploaded.width, 1024, 'GPT input must be padded to the 1024 square context without scaling the 64px source');
  assert.equal(uploaded.height, 1024);
  const uploadedRaw = await sharp(fixture.mock.uploads[0]!).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([...uploadedRaw.data.subarray(0, 3)], [170, 170, 170]);
  assert.deepEqual([...uploadedRaw.data.subarray((500 * 1024 + 500) * 3, (500 * 1024 + 500) * 3 + 3)], [170, 170, 170]);

  fixture.mock.complete(0);
  await fixture.jobs.tick();
  const completed = await fixture.jobs.get(job.id);
  assert.equal(completed.status, 'candidate');
  const updated = await fixture.store.getProject(fixture.project.id);
  const candidate = updated.versions.find(version => version.id === completed.versionId)!;
  assert.deepEqual(candidate.regionIds, ['edit-one']);
  assert.equal(candidate.validation?.passed, true);
  assert.equal(candidate.validation?.protectedChangedPixels, 0);
  assert.equal(candidate.validation?.outsideEditChangedPixels, 0);
  assert.equal(candidate.validation?.changedPixels, 252);
  const pixels = await sharp(await fixture.store.readAsset(fixture.project.id, candidate.asset)).raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => [...pixels.data.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 3)];
  assert.deepEqual(pixel(9, 9), [220, 85, 34]);
  assert.deepEqual(pixel(10, 10), [170, 170, 170], 'keep pixels remain source-exact');
  assert.deepEqual(pixel(30, 30), [170, 170, 170], 'pixels outside the confirmed edit remain source-exact');
});

it('does not fall back to Qwen when GPT remote capability is disabled', async t => {
  const fixture = await createFixture({ remoteGenerationEnabled: false });
  t.after(() => { fixture.jobs.close(); fixture.mock.close(); });
  const grant = await fixture.permissions.create(fixture.project.id, {
    baseVersionId: fixture.project.baseVersionId, purpose: 'generation', backend: 'gpt',
    destination: 'https://images.example.test',
  });
  await assert.rejects(
    fixture.jobs.submitPlan(fixture.project.id, {
      proposalId: fixture.proposal.id, confirmationId: fixture.confirmation.confirmation!.id,
      idempotencyKey: crypto.randomUUID(), grantId: grant.id,
    }),
    (error: unknown) => error instanceof StoreError && error.code === 'GPT_UNAVAILABLE' && error.status === 503,
  );
  assert.equal(fixture.mock.prompts.length, 0);
  assert.equal(fixture.mock.routes.some(route => route.includes('/object_info/UNETLoader')), false, 'disabled GPT must not probe or fall back to Qwen');
});

it('recovers the same generation reservation after a job-file write failure without running an unpersisted job', async t => {
  const fixture = await createFixture();
  t.after(() => { fixture.jobs.close(); fixture.mock.close(); });
  const grant = await fixture.permissions.create(fixture.project.id, {
    baseVersionId: fixture.project.baseVersionId, purpose: 'generation', backend: 'gpt',
    destination: 'https://images.example.test', maxJobs: 1,
  });
  await fixture.jobs.list();
  const blockedPath = path.join(fixture.root, 'jobs.json');
  await mkdir(blockedPath);
  const input = { proposalId: fixture.proposal.id, confirmationId: fixture.confirmation.confirmation!.id, idempotencyKey: crypto.randomUUID(), grantId: grant.id };
  await assert.rejects(fixture.jobs.submitPlan(fixture.project.id, input));
  assert.deepEqual(await fixture.jobs.list(), []);
  await fixture.jobs.tick();
  assert.equal(fixture.mock.prompts.length, 0);
  assert.equal((await fixture.permissions.get(fixture.project.id, grant.id)).consumedJobs, 1);
  await rm(blockedPath, { recursive: true }); // Only our empty test directory.
  const job = await fixture.jobs.submitPlan(fixture.project.id, input);
  assert.equal(job.status, 'queued');
  assert.equal((await fixture.permissions.get(fixture.project.id, grant.id)).consumedJobs, 1);
  assert.equal((await fixture.jobs.submitPlan(fixture.project.id, input)).id, job.id);
});

it('rechecks a generation grant before execution and submits no prompt after revocation', async t => {
  const fixture = await createFixture();
  t.after(() => { fixture.jobs.close(); fixture.mock.close(); });
  const grant = await fixture.permissions.create(fixture.project.id, {
    baseVersionId: fixture.project.baseVersionId, purpose: 'generation', backend: 'gpt',
    destination: 'https://images.example.test', maxJobs: 2,
  });
  const job = await fixture.jobs.submitPlan(fixture.project.id, {
    proposalId: fixture.proposal.id, confirmationId: fixture.confirmation.confirmation!.id,
    idempotencyKey: crypto.randomUUID(), grantId: grant.id,
  });
  await fixture.permissions.revoke(fixture.project.id, grant.id);
  await fixture.jobs.tick();
  const stopped = await fixture.jobs.get(job.id);
  assert.equal(stopped.status, 'cancelled');
  assert.match(stopped.error ?? '', /授权已失效/);
  assert.equal(fixture.mock.prompts.length, 0);
  assert.equal(fixture.mock.uploads.length, 0);
});

it('aligns GPT provider 1K native square output (e.g. 1254) back to the 1024 padded context without breaking protect masks', async t => {
  // CLIProxyAPIGPTImage2 size_hint=1K has been observed returning 1254² for a 1024 padded input.
  const fixture = await createFixture({ outputSize: 1254 });
  t.after(() => { fixture.jobs.close(); fixture.mock.close(); });
  const grant = await fixture.permissions.create(fixture.project.id, {
    baseVersionId: fixture.project.baseVersionId, purpose: 'generation', backend: 'gpt',
    destination: 'https://images.example.test',
  });
  const job = await fixture.jobs.submitPlan(fixture.project.id, {
    proposalId: fixture.proposal.id, confirmationId: fixture.confirmation.confirmation!.id,
    idempotencyKey: crypto.randomUUID(), grantId: grant.id,
  });
  await fixture.jobs.tick();
  assert.equal(fixture.mock.prompts.length, 1);
  fixture.mock.complete(0);
  await fixture.jobs.tick();
  const completed = await fixture.jobs.get(job.id);
  assert.equal(completed.status, 'candidate', completed.error ?? 'expected resize alignment to succeed');
  const updated = await fixture.store.getProject(fixture.project.id);
  const candidate = updated.versions.find(version => version.id === completed.versionId)!;
  assert.equal(candidate.validation?.passed, true);
  assert.equal(candidate.validation?.protectedChangedPixels, 0);
  assert.equal(candidate.validation?.outsideEditChangedPixels, 0);
  const pixels = await sharp(await fixture.store.readAsset(fixture.project.id, candidate.asset)).raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => [...pixels.data.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 3)];
  assert.deepEqual(pixel(10, 10), [170, 170, 170], 'keep pixels remain source-exact after GPT resize alignment');
  assert.deepEqual(pixel(30, 30), [170, 170, 170], 'pixels outside the confirmed edit remain source-exact');
});

it('rejects GPT output with a mismatched aspect ratio instead of anisotropic stretch', async t => {
  const fixture = await createFixture({ outputSize: 512, outputHeight: 768 });
  t.after(() => { fixture.jobs.close(); fixture.mock.close(); });
  const grant = await fixture.permissions.create(fixture.project.id, {
    baseVersionId: fixture.project.baseVersionId, purpose: 'generation', backend: 'gpt',
    destination: 'https://images.example.test',
  });
  const job = await fixture.jobs.submitPlan(fixture.project.id, {
    proposalId: fixture.proposal.id, confirmationId: fixture.confirmation.confirmation!.id,
    idempotencyKey: crypto.randomUUID(), grantId: grant.id,
  });
  await fixture.jobs.tick();
  fixture.mock.complete(0);
  await fixture.jobs.tick();
  const failed = await fixture.jobs.get(job.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /宽高比|尺寸/);
  assert.equal((await fixture.store.getProject(fixture.project.id)).versions.length, 1, 'bad-aspect GPT output must not become a candidate');
});

async function createFixture(options: { remoteGenerationEnabled?: boolean; outputSize?: number; outputHeight?: number } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maskcanvas-backend-integration-'));
  roots.push(root);
  const store = createStore({ dataDir: root });
  const original = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#aaaaaa' } }).png().toBuffer();
  const project = await store.createProject({ name: 'GPT integration synthetic', imageDataUrl: `data:image/png;base64,${original.toString('base64')}` });
  const processing: ImageProcessingConfiguration = {
    remoteGenerationEnabled: options.remoteGenerationEnabled ?? true,
    gpt: { destination: 'https://images.example.test', modelId: 'gpt-image-2.5-flare' },
  };
  const proposals = new ProposalStore(store, { processing: backend => processing[backend] });
  const proposal = await proposals.create(project.id, {
    title: 'synthetic local edit', goal: 'replace only the target patch', source: 'agent', backend: 'gpt',
    baseVersionId: project.baseVersionId, projectRevision: project.revision,
    regions: [
      { id: 'edit-one', name: 'edit-one', kind: 'edit', intent: 'replace target patch', feather: 0,
        shapes: [{ type: 'rect', x: 8, y: 8, width: 16, height: 16 }] },
      { id: 'keep-one', name: 'keep-one', kind: 'keep', intent: '', feather: 0,
        shapes: [{ type: 'rect', x: 10, y: 10, width: 2, height: 2 }] },
    ],
    suggestions: [{ regionId: 'edit-one', reason: 'test patch', enabled: true }],
  });
  const confirmation = await proposals.confirm(project.id, proposal.id, { revision: proposal.revision, projectRevision: project.revision });
  const permissions = new ProjectPermissions(store);
  const outputSize = options.outputSize ?? 1024;
  const outputHeight = options.outputHeight ?? outputSize;
  const output = await sharp({ create: { width: outputSize, height: outputHeight, channels: 4, background: '#dc5522' } }).png().toBuffer();
  const mock = await createComfyMock(output);
  const jobs = new QwenJobs(store, {
    host: mock.host,
    autoPoll: false,
    proposals,
    permissions,
    processing,
  });
  return { root, store, project, proposals, proposal, confirmation, permissions, jobs, mock };
}

async function createComfyMock(output: Buffer) {
  const prompts: Array<{ prompt_id: string; prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> }> = [];
  const completed = new Set<string>();
  const uploads: Buffer[] = [];
  const routes: string[] = [];
  let uploadIndex = 0;
  const server = createServer(async (request, response) => {
    const route = request.url ?? '/';
    routes.push(route);
    response.setHeader('content-type', 'application/json');
    if (route === '/object_info/CLIProxyAPIGPTImage2') {
      return response.end(JSON.stringify({ CLIProxyAPIGPTImage2: { input: {
        required: {
          provider_model: [['gpt-image-2.5-flare (OpenAI Commercial)']],
          prompt: ['STRING'], mode: [['edit']], aspect_ratio: [['1:1']], size_hint: [['1K']], seed: ['INT'],
        },
        optional: { image: ['IMAGE'] },
      } } }));
    }
    if (route === '/queue') return response.end(JSON.stringify({ queue_running: [], queue_pending: [] }));
    if (route === '/upload/image') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const marker = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const start = body.indexOf(marker);
      const end = body.indexOf(Buffer.from('\r\n--'), start);
      assert.ok(start >= 0 && end > start, 'uploaded multipart request must include a PNG input');
      uploads.push(body.subarray(start, end));
      return response.end(JSON.stringify({ subfolder: 'maskcanvas', name: `synthetic-${uploadIndex++}.png` }));
    }
    if (route === '/prompt') {
      let body = ''; for await (const chunk of request) body += chunk;
      prompts.push(JSON.parse(body));
      return response.end(JSON.stringify({ prompt_id: prompts.at(-1)!.prompt_id }));
    }
    if (route.startsWith('/history/')) {
      const id = decodeURIComponent(route.slice('/history/'.length));
      if (!completed.has(id)) return response.end('{}');
      const index = prompts.findIndex(prompt => prompt.prompt_id === id);
      return response.end(JSON.stringify({ [id]: { status: { completed: true }, outputs: { '13': { images: [{ filename: `synthetic-result-${index}.png` }] } } } }));
    }
    if (route.startsWith('/view?')) {
      response.setHeader('content-type', 'image/png');
      return response.end(output);
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    host: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    prompts,
    uploads,
    routes,
    complete(index: number) { const prompt = prompts[index]; if (prompt) completed.add(prompt.prompt_id); },
    close() { server.close(); },
  };
}
