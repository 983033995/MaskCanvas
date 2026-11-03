import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import sharp from 'sharp';
import { z } from 'zod';
import type { ImageBackend, Job, ProcessingTarget, Project, Region, RegionContext } from '../packages/shared/types.js';
import type { ProposalStore } from './proposals.js';
import { buildGptWorkflow, checkGptCapability, type GptProviderModel } from './gpt.js';
import type { ProjectPermissions } from './permissions.js';
import { Store, StoreError, rasterizeRegion } from './store.js';

const MODELS = {
  unet: 'qwen_image_2.1_turbo_int8_convrot.safetensors',
  clip: 'qwen3vl_8b_int8_convrot.safetensors',
  vae: 'qwen_image_2.1_vae_bf16.safetensors',
};
type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
interface Crop { left: number; top: number; width: number; height: number; paddedWidth: number; paddedHeight: number }
interface PlanStep {
  regionId: string;
  intent: string;
  input: 'base' | 'intermediate';
  status: 'queued' | 'running' | 'reconciling' | 'completed' | 'failed';
  crop: Crop;
  seed: number;
  workflow?: Workflow;
  externalId?: string;
  submissionStarted?: boolean;
  attempts?: number;
  retryAt?: number;
  outputFile?: string;
}
interface PlanExecution {
  proposalId: string;
  confirmationId: string;
  stepIndex: number;
  steps: PlanStep[];
}
interface RecordJob extends Job {
  idempotencyKey: string;
  regions: Region[];
  intent: string;
  seed: number;
  crop?: Crop;
  workflow?: Workflow;
  submissionStarted?: boolean;
  startAttempts?: number;
  retryAt?: number;
  plan?: PlanExecution;
}
const submission = z.object({
  revision: z.number().int().nonnegative(),
  regionId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  idempotencyKey: z.string().uuid(),
}).strict();
const planSubmission = z.object({
  proposalId: z.string().uuid(),
  confirmationId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  grantId: z.string().uuid().optional(),
}).strict();
const MAX_PRE_SUBMISSION_ATTEMPTS = 4;
const RETRY_BASE_MS = 250;

export interface ImageProcessingConfiguration {
  qwen?: ProcessingTarget;
  gpt?: ProcessingTarget;
  remoteGenerationEnabled: boolean;
}

export function imageProcessingConfiguration(env: Record<string, string | undefined> = process.env): ImageProcessingConfiguration {
  const host = comfyUrl(env.COMFYUI_IMAGE_SERVER_URL);
  const modelId = env.MASKCANVAS_GPT_MODEL ?? 'gpt-image-2.5-flare';
  if (!['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.5'].includes(modelId)) throw new Error('MASKCANVAS_GPT_MODEL 不是支持的 GPT Image 模型');
  let destination: string | undefined;
  if (env.MASKCANVAS_GPT_DESTINATION) {
    const url = new URL(env.MASKCANVAS_GPT_DESTINATION);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('MASKCANVAS_GPT_DESTINATION 必须是明确的无凭据 HTTP(S) origin');
    destination = url.origin;
    if (!host || destination !== host) throw new Error('GPT 处理目的地必须等于实际上传的 ComfyUI origin；最终云服务路由由该节点配置决定');
  }
  return {
    ...(host ? { qwen: { destination: host, modelId: 'qwen-image-2.1-turbo' } } : {}),
    ...(destination ? { gpt: { destination, modelId } } : {}),
    remoteGenerationEnabled: env.MASKCANVAS_ALLOW_REMOTE_GENERATION === '1' && Boolean(destination),
  };
}

export function comfyUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  const hostname = url.hostname;
  const privateHost = hostname === 'localhost' || isIP(hostname) === 4 && (hostname === '127.0.0.1'
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(hostname)
    || /^192\.168\./.test(hostname) || /^10\./.test(hostname)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname));
  if (url.protocol !== 'http:' || !privateHost || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('COMFYUI_IMAGE_SERVER_URL 必须是个人私网或本机的 HTTP 根地址，不允许公网/凭据/额外路径');
  }
  return url.origin;
}

export function buildQwenWorkflow(image: string, intent: string, seed: number, prefix: string): Workflow {
  const node = (class_type: string, inputs: Record<string, unknown>) => ({ class_type, inputs });
  return {
    '1': node('UNETLoader', { unet_name: MODELS.unet, weight_dtype: 'default' }),
    '2': node('CLIPLoader', { clip_name: MODELS.clip, type: 'qwen_image', device: 'default' }),
    '3': node('VAELoader', { vae_name: MODELS.vae }),
    '4': node('QwenImage21Cache', { model: ['1', 0], device: 'auto', dtype: 'int8' }),
    '5': node('LoadImage', { image }),
    '6': node('TextEncodeQwenImage21', {
      clip: ['2', 0], vae: ['3', 0], image_1: ['5', 0], resolution: 0,
      prompt: intent, negative_prompt: 'blurry, artifacts, distorted anatomy, plastic texture, double contours',
    }),
    '7': node('ManualSigmas', { sigmas: '1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0' }),
    '8': node('KSamplerSelect', { sampler_name: 'euler' }),
    '9': node('RandomNoise', { noise_seed: seed }),
    '10': node('CFGGuider', { model: ['4', 0], positive: ['6', 0], negative: ['6', 1], cfg: 1 }),
    '11': node('SamplerCustomAdvanced', { noise: ['9', 0], guider: ['10', 0], sampler: ['8', 0], sigmas: ['7', 0], latent_image: ['6', 2] }),
    '12': node('VAEDecode', { samples: ['11', 0], vae: ['3', 0] }),
    '13': node('SaveImage', { images: ['12', 0], filename_prefix: prefix }),
  };
}

export function cropForMask(mask: Uint8Array, width: number, height: number, context?: RegionContext): Crop {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (mask[y * width + x]) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
  }
  if (right < 0) throw new StoreError('EMPTY_EDIT', '没有可修改的像素，或全部被保护区覆盖');
  if (context) {
    const bounds = { left: Math.floor(context.x), top: Math.floor(context.y), right: Math.ceil(context.x + context.width) - 1, bottom: Math.ceil(context.y + context.height) - 1 };
    if (bounds.left < 0 || bounds.top < 0 || bounds.right >= width || bounds.bottom >= height || left < bounds.left || top < bounds.top || right > bounds.right || bottom > bounds.bottom) throw new StoreError('CONTEXT_MISMATCH', '上下文必须在原图内并包含全部有效编辑像素');
    ({ left, top, right, bottom } = bounds);
  } else {
    left = Math.max(0, left - 64); top = Math.max(0, top - 64);
    right = Math.min(width - 1, right + 64); bottom = Math.min(height - 1, bottom + 64);
  }
  const w = right - left + 1, h = bottom - top + 1;
  const paddedWidth = Math.ceil(w / 32) * 32, paddedHeight = Math.ceil(h / 32) * 32;
  if (paddedWidth * paddedHeight > 1_600_000) throw new StoreError('CROP_TOO_LARGE', '首版精确编辑限约 160 万像素上下文；请缩小区域分步处理，不自动缩放整图');
  return { left, top, width: w, height: h, paddedWidth, paddedHeight };
}

export class QwenJobs {
  private records: RecordJob[] = [];
  private readonly host: string | undefined;
  private readonly ready: Promise<void>;
  private locked: Promise<unknown> = Promise.resolve();
  private ticking = false;
  private timer?: ReturnType<typeof setInterval>;
  private cachedCapability?: { at: number; result: { available: boolean; reason: string } };
  constructor(private readonly store: Store, options: { host?: string; pollMs?: number; autoPoll?: boolean; proposals?: ProposalStore; permissions?: ProjectPermissions; processing?: ImageProcessingConfiguration } = {}) {
    this.host = comfyUrl(options.host ?? process.env.COMFYUI_IMAGE_SERVER_URL);
    this.proposals = options.proposals;
    this.permissions = options.permissions;
    this.processing = options.processing ?? imageProcessingConfiguration();
    this.ready = this.load();
    if (options.autoPoll !== false) {
      this.timer = setInterval(() => { void this.tick().catch((error: unknown) => console.error('Qwen 作业状态保存失败:', error instanceof Error ? error.message : 'unknown')); }, options.pollMs ?? 4000);
      this.timer.unref();
    }
  }
  private readonly proposals?: ProposalStore;
  private readonly permissions?: ProjectPermissions;
  readonly processing: ImageProcessingConfiguration;
  close() { if (this.timer) clearInterval(this.timer); }
  private async load() {
    try { this.records = JSON.parse(await readFile(path.join(this.store.dataDir, 'jobs.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('jobs.json 无法读取，停止作业恢复以避免重复生成'); }
    if (!Array.isArray(this.records)) throw new Error('jobs.json 格式错误');
  }
  private async save() {
    await mkdir(this.store.dataDir, { recursive: true });
    const file = path.join(this.store.dataDir, 'jobs.json');
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(this.records, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.locked.then(async () => { await this.ready; return fn(); });
    this.locked = result.catch(() => undefined);
    return result;
  }
  private publicJob(job: RecordJob): Job {
    const completedStepCount = job.plan?.steps.filter((step) => step.status === 'completed').length;
    const { id, projectId, regionId, baseVersionId, annotationRevision, status, externalId, versionId, error, waitReason, createdAt, updatedAt, proposalId, confirmationId, regionIds, stepIndex, stepCount, source, submissionMode, backend, destination, modelId, grantId } = job;
    return { id, projectId, regionId, baseVersionId, annotationRevision, status, externalId, versionId, error, waitReason, createdAt, updatedAt, proposalId, confirmationId, regionIds, stepIndex, stepCount, completedStepCount, source, submissionMode, backend: backend ?? 'qwen', destination, modelId, grantId };
  }
  async gptCapability() {
    const target = this.processing.gpt;
    if (!this.processing.remoteGenerationEnabled || !target || !this.host) return { ...checkGptCapability(undefined, false), ...(target ?? {}) };
    try {
      const info = await this.json('/object_info/CLIProxyAPIGPTImage2', undefined, 8000);
      return { ...checkGptCapability(info, true, target.modelId as GptProviderModel), ...target };
    } catch (error) { return { available: false, reason: `GPT 节点预检失败：${error instanceof Error ? error.message : '未知错误'}`, ...target }; }
  }
  async capability() {
    if (!this.host) return { available: false, reason: '未配置本地 Qwen 地址；可标注、导入候选与导出编辑包' };
    if (this.cachedCapability && Date.now() - this.cachedCapability.at < 15_000) return this.cachedCapability.result;
    let result: { available: boolean; reason: string };
    try {
      const wf = buildQwenWorkflow('preflight.png', 'preflight', 1, 'maskcanvas/preflight');
      const classes = [...new Set(Object.values(wf).map((item) => item.class_type))];
      const info: Record<string, any> = {};
      for (let offset = 0; offset < classes.length; offset += 4) {
        const batch = classes.slice(offset, offset + 4);
        const responses = await Promise.all(batch.map(async (name) => [name, await this.json(`/object_info/${encodeURIComponent(name)}`, undefined, 8000)] as const));
        for (const [name, response] of responses) {
          const node = response?.[name] ?? (response && typeof response === 'object' && 'input' in response ? response : undefined);
          if (!node) throw new Error(`缺少节点 ${name}`);
          info[name] = node;
        }
      }
      for (const [node, field, model] of [['UNETLoader', 'unet_name', MODELS.unet], ['CLIPLoader', 'clip_name', MODELS.clip], ['VAELoader', 'vae_name', MODELS.vae]]) {
        const options = info[node]?.input?.required?.[field]?.[0];
        if (!Array.isArray(options) || !options.includes(model)) throw new Error(`缺少模型 ${model}`);
      }
      result = { available: true, reason: '本地 Qwen 节点/模型预检通过；候选仍需实际生成与验收' };
    } catch (error) { result = { available: false, reason: `Qwen 预检失败：${error instanceof Error ? error.message : '未知错误'}` }; }
    this.cachedCapability = { at: Date.now(), result };
    return result;
  }
  async list(projectId?: string) { await this.ready; return this.records.filter((j) => !projectId || j.projectId === projectId).map((j) => this.publicJob(j)); }
  async get(id: string) {
    await this.ready;
    const job = this.records.find((j) => j.id === id);
    if (!job) throw new StoreError('JOB_NOT_FOUND', '作业不存在', 404);
    return this.publicJob(job);
  }
  async submit(projectId: string, body: unknown) {
    const parsed = submission.safeParse(body);
    if (!parsed.success) throw new StoreError('INVALID_JOB', '作业需要有效 revision、regionId 与 UUID 幂等键');
    return this.serial(async () => {
      const existing = this.records.find((j) => j.projectId === projectId && j.idempotencyKey === parsed.data.idempotencyKey);
      if (existing) {
        if (existing.regionId !== parsed.data.regionId || existing.annotationRevision !== parsed.data.revision) throw new StoreError('IDEMPOTENCY_CONFLICT', '相同幂等键不能更改任务内容', 409);
        return this.publicJob(existing);
      }
      const capability = await this.capability();
      if (!capability.available) throw new StoreError('QWEN_UNAVAILABLE', capability.reason, 503);
      const project = await this.store.getProject(projectId);
      if (project.revision !== parsed.data.revision) throw new StoreError('REVISION_CONFLICT', '标注已更新，请刷新后再提交', 409);
      const region = project.regions.find((r) => r.id === parsed.data.regionId);
      if (!region || region.kind !== 'edit' || !region.intent.trim()) throw new StoreError('INVALID_EDIT', '请选择有意图的编辑区域，保护区不能生成');
      const mask = await rasterizeRegion(region, project.width, project.height);
      for (const keep of project.regions.filter((r) => r.kind === 'keep')) {
        const k = await rasterizeRegion(keep, project.width, project.height);
        for (let i = 0; i < mask.length; i++) if (k[i]) mask[i] = 0;
      }
      const crop = cropForMask(mask, project.width, project.height, region.context);
      const now = new Date().toISOString();
      const record: RecordJob = { id: randomUUID(), projectId, regionId: region.id, baseVersionId: project.baseVersionId, annotationRevision: project.revision, status: 'queued', createdAt: now, updatedAt: now, idempotencyKey: parsed.data.idempotencyKey, regions: structuredClone(project.regions), intent: region.intent, seed: Math.floor(Math.random() * 2 ** 32), crop, source: 'human', submissionMode: 'manual-region' };
      this.records.push(record);
      try { await this.save(); }
      catch (error) { this.records = this.records.filter(item => item.id !== record.id); throw error; }
      return this.publicJob(record);
    });
  }
  async submitPlan(projectId: string, body: unknown) {
    const parsed = planSubmission.safeParse(body);
    if (!parsed.success) throw new StoreError('INVALID_JOB', '计划作业需要有效 proposalId、confirmationId 与 UUID 幂等键');
    return this.serial(async () => {
      const existing = this.records.find((job) => job.projectId === projectId && job.idempotencyKey === parsed.data.idempotencyKey);
      if (existing) {
        if (existing.plan?.proposalId !== parsed.data.proposalId || existing.plan?.confirmationId !== parsed.data.confirmationId || existing.grantId !== parsed.data.grantId) {
          throw new StoreError('IDEMPOTENCY_CONFLICT', '相同幂等键不能更改计划或确认', 409);
        }
        return this.publicJob(existing);
      }
      if (!this.proposals) throw new StoreError('PROPOSALS_UNAVAILABLE', '计划执行未连接提议确认存储', 503);
      let confirmed = await this.proposals.assertConfirmed(projectId, parsed.data.proposalId, parsed.data.confirmationId);
      const backend = confirmed.proposal.backend;
      const capability = backend === 'gpt' ? await this.gptCapability() : await this.capability();
      if (!capability.available) throw new StoreError(backend === 'gpt' ? 'GPT_UNAVAILABLE' : 'QWEN_UNAVAILABLE', capability.reason, 503);
      // Capability probes can take time. Recheck before persisting the queued
      // plan so a changed authorization never creates a runnable snapshot.
      confirmed = await this.proposals.assertConfirmed(projectId, parsed.data.proposalId, parsed.data.confirmationId, backend);
      const project = confirmed.project;
      const target = this.processing[backend];
      if (backend === 'gpt' && (!this.permissions || !parsed.data.grantId || !target)) throw new StoreError('GENERATION_PERMISSION_REQUIRED', 'GPT 远端生成需要当前照片、用途与处理目的地匹配的项目授权', 403);
      if (parsed.data.grantId && (!this.permissions || !target)) throw new StoreError('GENERATION_PERMISSION_REQUIRED', '授权检查服务或处理目的地未配置', 403);
      if (parsed.data.grantId) await this.permissions!.assertAllowed(projectId, { grantId: parsed.data.grantId, baseVersionId: project.baseVersionId, purpose: 'generation', backend, destination: target!.destination });
      const editRegions = confirmed.regions.filter((region) => region.kind === 'edit');
      const regionIds = editRegions.map((region) => region.id);
      const enabledIds = new Set(confirmed.proposal.suggestions.filter((suggestion) => suggestion.enabled).map((suggestion) => suggestion.regionId));
      const expectedEditIds = confirmed.proposal.regions.filter((region) => region.kind === 'edit' && enabledIds.has(region.id)).map((region) => region.id);
      if (!regionIds.length || editRegions.some((region) => !enabledIds.has(region.id))
        || JSON.stringify(regionIds) !== JSON.stringify(expectedEditIds)) {
        throw new StoreError('INVALID_EDIT', '确认计划没有有效的启用编辑区域');
      }
      const keepRegions = confirmed.regions.filter((region) => region.kind === 'keep');
      const steps: PlanStep[] = [];
      for (const region of editRegions) {
        const mask = await rasterizeRegion(region, project.width, project.height);
        for (const keep of keepRegions) {
          const keepMask = await rasterizeRegion(keep, project.width, project.height);
          for (let i = 0; i < mask.length; i++) if (keepMask[i]) mask[i] = 0;
        }
        steps.push({
          regionId: region.id,
          intent: `Overall editing goal: ${confirmed.proposal.goal}\nLocal instruction for this step: ${region.intent}\nPreserve the original composition, identity, geometry, colour and texture except for the explicitly requested local correction.`,
          input: steps.length === 0 ? 'base' : 'intermediate',
          status: 'queued',
          crop: this.cropForBackend(mask, project.width, project.height, backend, region.context),
          seed: Math.floor(Math.random() * 2 ** 32),
        });
      }
      const now = new Date().toISOString();
      const job: RecordJob = {
        id: randomUUID(), projectId, regionId: regionIds[0], regionIds,
        baseVersionId: project.baseVersionId, annotationRevision: project.revision,
        proposalId: parsed.data.proposalId, confirmationId: parsed.data.confirmationId,
        source: confirmed.proposal.source, submissionMode: 'confirmed-plan',
        backend, ...(target ?? {}), ...(parsed.data.grantId ? { grantId: parsed.data.grantId } : {}),
        stepIndex: 0, stepCount: steps.length,
        status: 'queued', createdAt: now, updatedAt: now,
        idempotencyKey: parsed.data.idempotencyKey,
        regions: structuredClone(confirmed.regions), intent: confirmed.proposal.goal,
        seed: steps[0].seed,
        plan: { proposalId: parsed.data.proposalId, confirmationId: parsed.data.confirmationId, stepIndex: 0, steps },
      };
      if (parsed.data.grantId) await this.permissions!.consume(projectId, parsed.data.grantId, parsed.data.idempotencyKey, { baseVersionId: project.baseVersionId, purpose: 'generation', backend, destination: target!.destination });
      this.records.push(job);
      try { await this.save(); }
      catch (error) { this.records = this.records.filter(item => item.id !== job.id); throw error; }
      return this.publicJob(job);
    });
  }
  private cropForBackend(mask: Uint8Array, width: number, height: number, backend: ImageBackend, context?: RegionContext): Crop {
    const crop = cropForMask(mask, width, height, context);
    if (backend === 'gpt') {
      if (crop.width > 1024 || crop.height > 1024) throw new StoreError('GPT_CROP_TOO_LARGE', 'GPT 首版使用不缩放原像素的 1024 方形上下文；请缩小区域或明确拆分', 409);
      return { ...crop, paddedWidth: 1024, paddedHeight: 1024 };
    }
    return crop;
  }
  async tick() {
    if (this.ticking || !this.host) return;
    this.ticking = true;
    try { await this.serial(async () => {
      for (const job of this.records.filter((r) => r.status === 'running' || r.status === 'reconciling')) {
        try { await this.collect(job); }
        catch (error) { job.status = 'reconciling'; job.error = `状态待核对，不会重发：${error instanceof Error ? error.message : '未知错误'}`; }
        job.updatedAt = new Date().toISOString(); await this.save();
      }
      // Unknown submission is never re-sent. It must not block unrelated jobs forever:
      // the shared ComfyUI queue below remains the authority for GPU occupancy.
      if (this.records.some((r) => r.status === 'running')) {
        let changed = false;
        for (const queued of this.records.filter(record => record.status === 'queued')) {
          const reason = '等待 MaskCanvas 前序生成完成；空闲后会自动继续，无需再次提交。';
          if (queued.waitReason !== reason) { queued.waitReason = reason; queued.updatedAt = new Date().toISOString(); changed = true; }
        }
        if (changed) await this.save();
        return;
      }
      const next = this.records.find((r) => r.status === 'queued' && ((r.plan?.steps[r.plan.stepIndex]?.retryAt ?? r.retryAt) ?? 0) <= Date.now());
      if (!next) return;
      try {
        const queue = await this.json('/queue');
        if (queue.queue_running?.length || queue.queue_pending?.length) {
          const reason = `等待 ComfyUI 空闲：当前有 ${queue.queue_running?.length ?? 0} 个运行任务、${queue.queue_pending?.length ?? 0} 个排队任务。本步骤尚未提交，空闲后会自动继续，无需再次提交。`;
          if (next.waitReason !== reason) { next.waitReason = reason; next.updatedAt = new Date().toISOString(); await this.save(); }
          return;
        }
        delete next.waitReason;
        await this.start(next);
      } catch (error) {
        this.recordStartFailure(next, error);
        await this.save();
      }
    }); } finally { this.ticking = false; }
  }
  private async start(job: RecordJob) {
    if (job.plan) return this.startPlanStep(job);
    const project = await this.store.getProject(job.projectId);
    const version = project.versions.find((v) => v.id === job.baseVersionId);
    if (!version || !job.crop) throw new Error('作业基准或上下文丢失');
    const crop = job.crop;
    const image = await sharp(this.store.assetPath(project.id, version.asset)).extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
      .extend({ right: crop.paddedWidth - crop.width, bottom: crop.paddedHeight - crop.height, left: 0, top: 0, extendWith: 'copy' }).png().toBuffer();
    const form = new FormData();
    form.set('image', new Blob([new Uint8Array(image)], { type: 'image/png' }), `${job.id}.png`);
    form.set('subfolder', 'maskcanvas'); form.set('overwrite', 'false');
    const uploaded = await this.json('/upload/image', { method: 'POST', body: form }, 120_000);
    if (typeof uploaded.name !== 'string') throw new Error('ComfyUI 上传未返回文件名');
    const imageName = [uploaded.subfolder, uploaded.name].filter(Boolean).join('/');
    job.workflow = buildQwenWorkflow(imageName, job.intent, job.seed, `maskcanvas/${job.id}`);
    job.externalId = randomUUID();
    job.submissionStarted = true; job.status = 'reconciling';
    await this.save(); // Persist BEFORE the potentially ambiguous /prompt POST.
    const response = await fetch(`${this.host}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: job.workflow, prompt_id: job.externalId, client_id: job.id }), redirect: 'error', signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      job.status = 'reconciling';
      throw new Error(`ComfyUI 拒绝工作流 HTTP ${response.status}`);
    }
    const submitted = await response.json() as { prompt_id?: string; node_errors?: Record<string, unknown> };
    if (!submitted.prompt_id || Object.keys(submitted.node_errors ?? {}).length) {
      job.status = 'failed';
      throw new Error('ComfyUI 未接受完整工作流，请核对节点输入');
    }
    job.externalId = submitted.prompt_id; job.status = 'running'; delete job.error;
    job.updatedAt = new Date().toISOString(); await this.save();
  }
  private async startPlanStep(job: RecordJob) {
    const plan = job.plan;
    if (!plan || !this.proposals) throw new StoreError('PROPOSALS_UNAVAILABLE', '计划执行未连接提议确认存储', 503);
    const index = plan.stepIndex;
    const step = plan.steps[index];
    if (!step || !step.crop) throw new StoreError('CORRUPT_JOB', '计划步骤或区域快照缺失', 500);
    const authorization = await this.currentPlanAuthorization(job);
    if (!authorization) { this.stopStalePlan(job); return; }
    const version = authorization.project.versions.find((candidate) => candidate.id === job.baseVersionId);
    if (!version) throw new StoreError('STALE_BASE', '计划照片基准已不存在', 409);
    const inputPath = step.input === 'base'
      ? this.store.assetPath(job.projectId, version.asset)
      : path.join(this.planDirectory(job), `step-${index - 1}-composite.png`);
    const crop = step.crop;
    const image = await sharp(inputPath, { limitInputPixels: 40_000_000 }).extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
      .extend({ right: crop.paddedWidth - crop.width, bottom: crop.paddedHeight - crop.height, left: 0, top: 0, extendWith: 'copy' }).png().toBuffer();
    const form = new FormData();
    form.set('image', new Blob([new Uint8Array(image)], { type: 'image/png' }), `${job.id}-step-${index}-${step.attempts ?? 0}.png`);
    form.set('subfolder', 'maskcanvas'); form.set('overwrite', 'false');
    const uploaded = await this.json('/upload/image', { method: 'POST', body: form }, 120_000);
    if (typeof uploaded.name !== 'string') throw new Error('ComfyUI 上传未返回文件名');
    const imageName = [uploaded.subfolder, uploaded.name].filter(Boolean).join('/');
    step.workflow = job.backend === 'gpt'
      ? buildGptWorkflow(imageName, step.intent, step.seed, `maskcanvas/${job.id}/step-${index}`, { providerModel: job.modelId as GptProviderModel })
      : buildQwenWorkflow(imageName, step.intent, step.seed, `maskcanvas/${job.id}/step-${index}`);
    step.externalId = randomUUID();
    step.status = 'queued';
    step.submissionStarted = false;
    job.externalId = step.externalId;
    job.submissionStarted = false;
    job.status = 'queued';
    job.stepIndex = index;
    job.updatedAt = new Date().toISOString();
    await this.save(); // Input and workflow are durable; no external prompt exists yet.

    // Uploading is not execution. Recheck after it and immediately before
    // /prompt so revoked or edited plans cannot start another model step.
    if (!await this.currentPlanAuthorization(job)) {
      delete step.externalId;
      job.status = 'cancelled'; job.submissionStarted = false; delete job.externalId;
      this.stopStalePlan(job);
      await this.save();
      return;
    }
    step.status = 'reconciling'; step.submissionStarted = true;
    job.status = 'reconciling'; job.submissionStarted = true;
    await this.save(); // Persist BEFORE the potentially ambiguous /prompt POST.
    if (!await this.currentPlanAuthorization(job)) {
      step.status = 'queued'; step.submissionStarted = false; delete step.externalId;
      job.status = 'cancelled'; job.submissionStarted = false; delete job.externalId;
      this.stopStalePlan(job);
      await this.save();
      return;
    }
    const response = await fetch(`${this.host}/prompt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: step.workflow, prompt_id: step.externalId, client_id: job.id }),
      redirect: 'error', signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`ComfyUI 拒绝计划步骤 HTTP ${response.status}；任务保留核对，不会重发`);
    const submitted = await response.json() as { prompt_id?: string; node_errors?: Record<string, unknown> };
    if (!submitted.prompt_id || Object.keys(submitted.node_errors ?? {}).length) {
      step.status = 'failed'; job.status = 'failed';
      throw new Error('ComfyUI 未接受完整计划步骤，请核对节点输入');
    }
    step.externalId = submitted.prompt_id;
    step.status = 'running';
    job.externalId = submitted.prompt_id;
    job.status = 'running';
    job.updatedAt = new Date().toISOString();
    delete job.error;
    await this.save();
  }

  private async currentPlanAuthorization(job: RecordJob) {
    const plan = job.plan;
    if (!plan || !this.proposals) return undefined;
    try {
      const backend = job.backend ?? 'qwen';
      const authorization = await this.proposals.assertConfirmed(job.projectId, plan.proposalId, plan.confirmationId, backend);
      const target = this.processing[backend];
      if (backend === 'gpt' && (!this.processing.remoteGenerationEnabled || !this.permissions || !job.grantId || !target)) return undefined;
      if (job.destination && (target?.destination !== job.destination || target.modelId !== job.modelId)) return undefined;
      if (job.grantId) await this.permissions!.assertAllowed(job.projectId, { grantId: job.grantId, baseVersionId: job.baseVersionId, purpose: 'generation', backend, destination: job.destination! });
      const authorizedEditIds = authorization.regions.filter((region) => region.kind === 'edit').map((region) => region.id);
      if (authorization.project.baseVersionId !== job.baseVersionId
        || authorization.project.revision !== job.annotationRevision
        || JSON.stringify(authorizedEditIds) !== JSON.stringify(job.regionIds)
        || JSON.stringify(authorization.regions) !== JSON.stringify(job.regions)) return undefined;
      return authorization;
    } catch (error) {
      if (error instanceof StoreError && (error.code === 'CONFIRMATION_INVALID' || ['PERMISSION_REVOKED', 'PERMISSION_EXPIRED', 'PERMISSION_STALE_BASE', 'PERMISSION_SCOPE_MISMATCH', 'GRANT_NOT_FOUND'].includes(error.code))) return undefined;
      throw error;
    }
  }

  private stopStalePlan(job: RecordJob) {
    delete job.waitReason;
    const done = job.plan?.steps.filter((step) => step.status === 'completed').length ?? 0;
    const total = job.plan?.steps.length ?? job.stepCount ?? 0;
    job.status = 'cancelled';
    job.stepIndex = Math.max(0, done - 1);
    job.error = `计划确认或图片处理授权已失效；已保留 ${done}/${total} 步的结果，不再开始新步骤`;
    job.updatedAt = new Date().toISOString();
  }

  private recordStartFailure(job: RecordJob, error: unknown) {
    delete job.waitReason;
    const message = error instanceof Error ? error.message : '提交失败';
    const step = job.plan?.steps[job.plan.stepIndex];
    if (job.status === 'failed') {
      job.error = message;
      job.updatedAt = new Date().toISOString();
      return;
    }
    if (step?.submissionStarted || job.submissionStarted) {
      if (step) step.status = 'reconciling';
      job.status = 'reconciling';
      job.error = `${message}；请求可能已受理，需按原外部 ID 核对，不会重发`;
    } else {
      const attempts = step ? (step.attempts = (step.attempts ?? 0) + 1) : (job.startAttempts = (job.startAttempts ?? 0) + 1);
      if (attempts >= MAX_PRE_SUBMISSION_ATTEMPTS) {
        if (step) step.status = 'failed';
        job.status = 'failed';
        if (step) job.stepIndex = Math.max(0, job.plan!.steps.filter((candidate) => candidate.status === 'completed').length - 1);
        job.error = `${message}；已达到 ${MAX_PRE_SUBMISSION_ATTEMPTS} 次提交前重试上限`;
      } else {
        const delay = Math.min(RETRY_BASE_MS * (2 ** (attempts - 1)), 4_000);
        const retryAt = Date.now() + delay;
        if (step) step.retryAt = retryAt;
        else job.retryAt = retryAt;
        job.status = 'queued';
        job.error = `${message}；${delay}ms 后有限重试 (${attempts}/${MAX_PRE_SUBMISSION_ATTEMPTS})`;
      }
    }
    job.updatedAt = new Date().toISOString();
  }

  private planDirectory(job: RecordJob): string { return path.join(this.store.dataDir, '.job-results', job.id); }

  private async atomicWrite(file: string, bytes: Buffer) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
  }

  private async collect(job: RecordJob) {
    if (job.plan) return this.collectPlanStep(job);
    if (!job.externalId || !job.crop) { job.error = '受理记录不完整，需要人工核对；不会自动重发'; return; }
    const history = await this.json(`/history/${encodeURIComponent(job.externalId)}`);
    const entry = history[job.externalId];
    if (!entry) {
      const queue = await this.json('/queue');
      const queued = [...(queue.queue_running ?? []), ...(queue.queue_pending ?? [])].some((item: unknown[]) => item[1] === job.externalId);
      if (!queued) {
        job.status = 'reconciling';
        job.error = '原任务在队列与历史中暂无记录，需要人工核对；不会重发，也不会阻塞其他任务';
      }
      return;
    }
    if (entry.status?.status_str === 'error' || entry.status?.messages?.some((m: unknown[]) => m[0] === 'execution_error' || m[0] === 'execution_interrupted')) {
      job.status = 'failed'; job.error = 'ComfyUI 执行失败或被中断；已保留输入与工作流'; return;
    }
    if (!entry.status?.completed) return;
    const output = entry.outputs?.['13']?.images?.[0];
    if (!output) { job.status = 'failed'; job.error = '工作流已结束但没有图像产物'; return; }
    const params = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder ?? '', type: output.type ?? 'output' });
    const response = await fetch(`${this.host}/view?${params}`, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`产物获取失败 HTTP ${response.status}`);
    const image = Buffer.from(await response.arrayBuffer());
    const meta = await sharp(image, { limitInputPixels: 1_600_000 }).metadata();
    const c = job.crop;
    if (meta.width !== c.paddedWidth || meta.height !== c.paddedHeight) {
      job.status = 'failed'; job.error = '模型返回尺寸与上下文不一致，停止拼回，未自动拉伸'; return;
    }
    const current = await this.store.getProject(job.projectId);
    // A previous process may have committed the candidate just before jobs.json save.
    const name = `Qwen · ${job.id}`;
    const candidateId = `candidate-${job.id}`;
    const previous = current.versions.find((v) => v.id === candidateId);
    if (previous) { job.versionId = previous.id; job.status = 'candidate'; delete job.error; return; }
    const cropImage = await sharp(image).extract({ left: 0, top: 0, width: c.width, height: c.height }).png().toBuffer();
    const base = current.versions.find((v) => v.id === job.baseVersionId);
    if (!base) throw new Error('基准版本丢失');
    const fullImage = await sharp(this.store.assetPath(job.projectId, base.asset)).composite([{ input: cropImage, left: c.left, top: c.top }]).png().toBuffer();
    const project = await this.store.importCandidate(job.projectId, { revision: job.annotationRevision, baseVersionId: job.baseVersionId, regionId: job.regionId, imageDataUrl: `data:image/png;base64,${fullImage.toString('base64')}`, name }, { allowStale: true, snapshotRegions: job.regions, candidateId });
    const candidate = project.versions.find((v) => v.id === candidateId);
    if (!candidate) throw new Error('候选写入后未能读取');
    job.versionId = candidate.id; job.status = 'candidate'; delete job.error;
  }

  private async collectPlanStep(job: RecordJob) {
    const plan = job.plan!;
    const index = plan.stepIndex;
    const step = plan.steps[index];
    if (!step?.externalId || !step.crop) {
      step && (step.status = 'reconciling');
      job.status = 'reconciling';
      job.error = '计划步骤受理记录不完整；需要人工核对，不会重发';
      return;
    }
    const history = await this.json(`/history/${encodeURIComponent(step.externalId)}`);
    const entry = history[step.externalId];
    if (!entry) {
      const queue = await this.json('/queue');
      const queued = [...(queue.queue_running ?? []), ...(queue.queue_pending ?? [])].some((item: unknown[]) => item[1] === step.externalId);
      if (!queued) {
        step.status = 'reconciling'; job.status = 'reconciling';
        job.error = '原计划步骤在队列与历史中暂无记录；结果保留，需人工核对且不会重发';
      }
      return;
    }
    if (entry.status?.status_str === 'error' || entry.status?.messages?.some((message: unknown[]) => message[0] === 'execution_error' || message[0] === 'execution_interrupted')) {
      step.status = 'failed'; job.status = 'failed'; job.error = `计划第 ${index + 1} 步执行失败或被中断；已保留此前完成步骤与工作流`; return;
    }
    if (!entry.status?.completed) return;
    const output = entry.outputs?.['13']?.images?.[0];
    if (!output || typeof output.filename !== 'string') {
      step.status = 'failed'; job.status = 'failed'; job.error = `计划第 ${index + 1} 步结束但没有可识别图像产物`; return;
    }
    const params = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder ?? '', type: output.type ?? 'output' });
    const response = await fetch(`${this.host}/view?${params}`, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`计划步骤产物获取失败 HTTP ${response.status}`);
    const image = Buffer.from(await response.arrayBuffer());
    const crop = step.crop;
    const directory = this.planDirectory(job);
    const outputFile = `step-${index}-output.png`;
    await this.atomicWrite(path.join(directory, outputFile), image);
    step.outputFile = outputFile;
    const meta = await sharp(image, { limitInputPixels: 1_600_000 }).metadata();
    if (meta.width !== crop.paddedWidth || meta.height !== crop.paddedHeight) {
      step.status = 'failed'; job.status = 'failed'; job.error = `计划第 ${index + 1} 步图像尺寸与上下文不一致；已保留原始产物且未拉伸`; return;
    }
    const inputPath = step.input === 'base'
      ? this.store.assetPath(job.projectId, (await this.store.getProject(job.projectId)).versions.find((version) => version.id === job.baseVersionId)!.asset)
      : path.join(directory, `step-${index - 1}-composite.png`);
    const basePng = await readFile(inputPath);
    const cropImage = await sharp(image).extract({ left: 0, top: 0, width: crop.width, height: crop.height }).png().toBuffer();
    const candidatePng = await sharp(basePng, { limitInputPixels: 40_000_000 }).composite([{ input: cropImage, left: crop.left, top: crop.top }]).png().toBuffer();
    const intermediate = await this.store.compositeCandidatePreview(job.projectId, basePng, candidatePng, job.regions, [step.regionId]);
    await this.atomicWrite(path.join(directory, `step-${index}-composite.png`), intermediate);
    // A convenience preview is kept separate; replay always reads the
    // immutable previous-step composite and recomputes this step deterministically.
    await this.atomicWrite(path.join(directory, 'intermediate.png'), intermediate);
    step.status = 'completed';
    job.stepIndex = index;
    job.updatedAt = new Date().toISOString();
    delete job.error;

    if (index + 1 < plan.steps.length) {
      plan.stepIndex = index + 1;
      job.stepIndex = index + 1;
      job.status = 'queued';
      job.submissionStarted = false;
      job.startAttempts = 0;
      delete job.retryAt;
      delete job.error;
      return;
    }

    // The final image is retained as a stale candidate if approval changed
    // after the last prompt was accepted. It can be inspected, but Store.accept
    // will reject the stale marker and no official base is advanced.
    const stillAuthorized = Boolean(await this.currentPlanAuthorization(job));
    const projectNow = await this.store.getProject(job.projectId);
    const candidateId = `candidate-${job.id}`;
    const previous = projectNow.versions.find((version) => version.id === candidateId);
    if (previous) {
      job.versionId = previous.id; job.status = 'candidate';
      if (previous.stale) job.error = '计划确认已失效；最终产物保留为不可接受的过期候选';
      return;
    }
    const finalImage = await readFile(path.join(directory, `step-${index}-composite.png`));
    const result = await this.store.importCandidate(job.projectId, {
      revision: job.annotationRevision,
      baseVersionId: job.baseVersionId,
      regionId: job.regionIds![0],
      regionIds: job.regionIds,
      imageDataUrl: `data:image/png;base64,${finalImage.toString('base64')}`,
      name: `${job.backend === 'gpt' ? 'GPT Image' : 'Qwen'} 计划 · ${job.id}`,
    }, {
      allowStale: true, snapshotRegions: job.regions, candidateId, precomposited: true, stale: !stillAuthorized,
    });
    const candidate = result.versions.find((version) => version.id === candidateId);
    if (!candidate) throw new Error('计划候选写入后未能读取');
    job.versionId = candidate.id;
    job.status = 'candidate';
    if (candidate.stale) job.error = '计划确认已失效；最终产物保留为不可接受的过期候选';
    else delete job.error;
  }
  private async json(route: string, options?: RequestInit, timeout = 15_000): Promise<any> {
    const response = await fetch(`${this.host}${route}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error(`ComfyUI HTTP ${response.status}`);
    return response.json();
  }
}
