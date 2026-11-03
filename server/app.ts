import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Capabilities, Job } from '../packages/shared/types.js';
import { createStore, Store, StoreError } from './store.js';
import { exportAnnotations, importAnnotations } from './annotations.js';
import { ProposalStore } from './proposals.js';
import { exportProposalDocument, importProposalDocument } from './proposal-document.js';
import { ProjectPermissions } from './permissions.js';
import type { ImageProcessingConfiguration } from './qwen.js';
import { rebindDocument } from './rebinding.js';
import { proposeRegionsFromImageBytes } from './segment-heuristics.js';

export interface CreateAppOptions {
  store?: Store;
  dataDir?: string;
  token?: string;
  capabilities?: Capabilities;
  staticDir?: string;
  jobs?: {
    capability(): Promise<{ available: boolean; reason: string }>;
    gptCapability?(): Promise<{ available: boolean; reason: string; destination?: string; modelId?: string }>;
    processing?: ImageProcessingConfiguration;
    list(projectId?: string): Promise<Job[]>;
    get(id: string): Promise<Job>;
    submit(projectId: string, body: unknown): Promise<Job>;
    submitPlan?(projectId: string, body: unknown): Promise<Job>;
  };
  proposals?: ProposalStore;
  permissions?: ProjectPermissions;
}

const idSchema = z.string().uuid();
const projectCreateSchema = z.object({ name: z.string().min(1).max(120), imageDataUrl: z.string().min(1) }).strict();
const regionsSchema = z.object({ revision: z.number().int().nonnegative(), regions: z.array(z.unknown()).max(200) }).strict();
const candidateSchema = z.object({
  revision: z.number().int().nonnegative(),
  baseVersionId: z.string().min(1).max(100),
  regionId: z.string().min(1).max(80),
  imageDataUrl: z.string().min(1),
  name: z.string().min(1).max(160).optional(),
}).strict();
const acceptSchema = z.object({ revision: z.number().int().nonnegative(), versionId: z.string().min(1).max(100) }).strict();
const packageImportSchema = z.object({ dataBase64: z.string().min(1) }).strict();

export function createApp(options: CreateAppOptions = {}) {
  const app = express();
  const store = options.store ?? createStore({ dataDir: options.dataDir });
  const proposals = options.proposals ?? new ProposalStore(store);
  const permissions = options.permissions ?? new ProjectPermissions(store);
  const token = options.token ?? randomBytes(32).toString('base64url');
  const capabilities: Capabilities = options.capabilities ?? {
    localCore: true,
    qwen: { available: false, reason: 'Qwen 尚未连接' },
    gpt: { available: false, reason: '未配置 GPT Image 后端' },
    vision: { available: false, reason: '未配置本地图像观察服务' },
  };
  app.disable('x-powered-by');
  app.locals.store = store;
  app.locals.proposals = proposals;
  app.locals.permissions = permissions;
  app.locals.maskCanvasToken = token;
  const localApiRequest = requireLocalApiRequest();
  app.use((request, response, next) => request.path === '/api' || request.path.startsWith('/api/')
    ? localApiRequest(request, response, next)
    : next());
  app.use(express.json({ limit: '280mb', strict: true }));

  const api = express.Router();
  api.get('/session', (_request, response) => response.json({ token }));
  api.get('/capabilities', async (_request, response) => response.json({
    ...capabilities,
    qwen: options.jobs ? await options.jobs.capability() : capabilities.qwen,
    gpt: options.jobs?.gptCapability ? await options.jobs.gptCapability() : capabilities.gpt,
  }));
  api.get('/projects', async (_request, response) => response.json(await store.listProjects()));
  api.get('/jobs', async (request, response) => {
    const projectId = request.query.projectId;
    if (projectId !== undefined && (typeof projectId !== 'string' || !idSchema.safeParse(projectId).success)) throw new StoreError('INVALID_PROJECT_ID', 'projectId 无效');
    response.json(options.jobs ? await options.jobs.list(projectId as string | undefined) : []);
  });
  api.get('/jobs/:id', async (request, response) => {
    if (!options.jobs) throw new StoreError('JOB_NOT_FOUND', '作业不存在', 404);
    const id = stringParam(request, 'id');
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) throw new StoreError('INVALID_JOB_ID', '作业 ID 无效');
    response.json(await options.jobs.get(id));
  });

  api.post('/projects', requireLocalMutation(token), async (request, response) => {
    const body = parseBody(projectCreateSchema, request);
    response.status(201).json(await store.createProject(body));
  });
  api.get('/projects/:id', async (request, response) => {
    const id = parseProjectId(request);
    response.json(await store.getProject(id));
  });
  api.get('/projects/:id/permissions', async (request, response) => {
    const { remoteGenerationEnabled = false, ...processing } = options.jobs?.processing ?? {};
    response.json({ grants: await permissions.list(parseProjectId(request)), processing, remoteGenerationEnabled });
  });
  api.post('/projects/:id/permissions', requireLocalMutation(token), async (request, response) => {
    response.status(201).json(await permissions.create(parseProjectId(request), request.body));
  });
  api.post('/projects/:id/permissions/:grantId/revoke', requireLocalMutation(token), async (request, response) => {
    response.json(await permissions.revoke(parseProjectId(request), stringParam(request, 'grantId')));
  });
  api.post('/projects/:id/observe', requireLocalMutation(token), async (request, response) => {
    const id = parseProjectId(request);
    const body = parseBody(z.object({ grantId: z.string().uuid(), destination: z.string().min(1).max(300), versionId: z.string().min(1).max(100).optional() }).strict(), request);
    const project = await store.getProject(id);
    await permissions.assertAllowed(id, { grantId: body.grantId, baseVersionId: project.baseVersionId, purpose: 'analysis', backend: 'agent', destination: body.destination });
    const version = project.versions.find(item => item.id === (body.versionId ?? project.baseVersionId));
    if (!version || version.id !== project.baseVersionId && (version.baseVersionId !== project.baseVersionId || version.status !== 'candidate')) throw new StoreError('OBSERVATION_SCOPE_MISMATCH', '此授权仅覆盖当前基准及其候选，请对其他照片版本重新确认', 403);
    const bytes = await store.readAsset(id, version.asset);
    response.json({ versionId: version.id, width: project.width, height: project.height, mimeType: 'image/png', data: bytes.toString('base64') });
  });
  api.put('/projects/:id/regions', requireLocalMutation(token), async (request, response) => {
    const id = parseProjectId(request);
    const body = parseBody(regionsSchema, request) as { revision: number; regions: import('../packages/shared/types.js').Region[] };
    response.json(await store.saveRegions(id, body));
  });
  api.get('/projects/:id/annotations', async (request, response) => {
    response.json(await exportAnnotations(store, parseProjectId(request)));
  });
  api.post('/projects/:id/annotations', requireLocalMutation(token), async (request, response) => {
    const body = parseBody(z.object({ document: z.unknown() }).strict(), request);
    response.json(await importAnnotations(store, parseProjectId(request), body.document));
  });
  api.get('/projects/:id/proposals', async (request, response) => {
    response.json(await proposals.list(parseProjectId(request)));
  });
  api.post('/projects/:id/proposals', requireLocalMutation(token), async (request, response) => {
    response.status(201).json(await proposals.create(parseProjectId(request), request.body));
  });
  /** Agent autonomous segment → draft proposal only (never confirms). */
  api.post('/projects/:id/propose-regions', requireLocalMutation(token), async (request, response) => {
    const id = parseProjectId(request);
    const body = parseBody(z.object({
      title: z.string().min(1).max(160).optional(),
      goal: z.string().min(1).max(4000).optional(),
      backend: z.enum(['qwen', 'gpt']).default('qwen'),
      maxRegions: z.number().int().min(1).max(8).optional(),
      hints: z.array(z.object({
        x: z.number().finite().nonnegative(),
        y: z.number().finite().nonnegative(),
        label: z.union([z.literal(0), z.literal(1)]).default(1),
      }).strict()).max(32).optional(),
      colourTolerance: z.number().min(4).max(120).optional(),
      edgeBarrier: z.number().min(0.05).max(0.9).optional(),
    }).strict(), request);
    const project = await store.getProject(id);
    const version = project.versions.find(item => item.id === project.baseVersionId);
    if (!version) throw new StoreError('BASE_MISSING', '缺少规范基准图', 404);
    const bytes = await store.readAsset(id, version.asset);
    const found = await proposeRegionsFromImageBytes(bytes, {
      maxRegions: body.maxRegions,
      hints: body.hints,
      colourTolerance: body.colourTolerance,
      edgeBarrier: body.edgeBarrier,
    });
    if (!found.proposals.length) {
      response.status(200).json({
        proposal: null,
        regions: [],
        engine: found.engine,
        autoConfirmed: false,
        generationStarted: false,
        message: '未找到可用选区，请提供 hints 或在编辑器手工标注',
      });
      return;
    }
    const regions = found.proposals.map(item => item.region);
    const suggestions = found.proposals.map(item => ({
      regionId: item.region.id,
      reason: item.reason,
      enabled: true,
      confidence: item.confidence,
    }));
    const proposal = await proposals.create(id, {
      title: body.title ?? `Agent 选区建议（${regions.length}）`,
      goal: body.goal ?? '根据照片启发式提出的编辑区域，须人工审阅确认后方可生成。',
      backend: body.backend,
      source: 'agent',
      baseVersionId: project.baseVersionId,
      projectRevision: project.revision,
      regions,
      suggestions,
    });
    response.status(201).json({
      proposal,
      regions: found.proposals,
      engine: found.engine,
      autoConfirmed: false,
      generationStarted: false,
      url: `/?project=${id}&proposal=${proposal.id}`,
    });
  });
  api.post('/projects/:id/proposal-documents', requireLocalMutation(token), async (request, response) => {
    const body = parseBody(z.object({ document: z.unknown() }).strict(), request);
    response.status(201).json(await importProposalDocument(store, proposals, parseProjectId(request), body.document));
  });
  api.post('/projects/:id/rebind-json', requireLocalMutation(token), async (request, response) => {
    const body = parseBody(z.object({ document: z.unknown() }).strict(), request);
    response.status(201).json(await rebindDocument(store, proposals, body.document, parseProjectId(request)));
  });
  api.get('/projects/:id/proposals/:proposalId/document', async (request, response) => {
    response.json(await exportProposalDocument(store, proposals, parseProjectId(request), parseProposalId(request)));
  });
  api.get('/projects/:id/proposals/:proposalId', async (request, response) => {
    response.json(await proposals.get(parseProjectId(request), parseProposalId(request)));
  });
  api.patch('/projects/:id/proposals/:proposalId', requireLocalMutation(token), async (request, response) => {
    response.json(await proposals.update(parseProjectId(request), parseProposalId(request), request.body));
  });
  api.post('/projects/:id/proposals/:proposalId/confirm', requireLocalMutation(token), async (request, response) => {
    response.json(await proposals.confirm(parseProjectId(request), parseProposalId(request), request.body));
  });
  api.post('/projects/:id/proposals/:proposalId/cancel', requireLocalMutation(token), async (request, response) => {
    response.json(await proposals.cancel(parseProjectId(request), parseProposalId(request), request.body));
  });
  api.post('/projects/:id/candidates', requireLocalMutation(token), async (request, response) => {
    const id = parseProjectId(request);
    response.status(201).json(await store.importCandidate(id, parseBody(candidateSchema, request)));
  });
  api.post('/projects/:id/jobs', requireLocalMutation(token), async (request, response) => {
    const id = parseProjectId(request);
    await store.getProject(id);
    if (!options.jobs) throw new StoreError('QWEN_UNAVAILABLE', 'Qwen 生成后端尚未配置', 503);
    response.status(202).json(await options.jobs.submit(id, request.body));
  });
  api.post('/projects/:id/plan-jobs', requireLocalMutation(token), async (request, response) => {
    const id = parseProjectId(request);
    if (!options.jobs?.submitPlan) throw new StoreError('PLAN_JOBS_UNAVAILABLE', '确认计划的生成后端尚未配置', 503);
    response.status(202).json(await options.jobs.submitPlan(id, request.body));
  });
  api.post('/projects/:id/accept', requireLocalMutation(token), async (request, response) => {
    const id = parseProjectId(request);
    response.json(await store.accept(id, parseBody(acceptSchema, request)));
  });
  api.post('/projects/:id/reject', requireLocalMutation(token), async (request, response) => {
    response.json(await store.reject(parseProjectId(request), parseBody(acceptSchema, request)));
  });
  api.get('/projects/:id/assets/:asset', async (request, response) => {
    const id = parseProjectId(request);
    const asset = stringParam(request, 'asset');
    response.type('png').send(await store.readAsset(id, asset));
  });
  api.get('/projects/:id/masks/:regionId', async (request, response) => {
    const id = parseProjectId(request);
    response.type('png').send(await store.getMask(id, stringParam(request, 'regionId')));
  });
  api.get('/projects/:id/export', async (request, response) => {
    const id = parseProjectId(request);
    response.type('png').send(await store.exportAccepted(id));
  });
  api.get('/projects/:id/package', async (request, response) => {
    const id = parseProjectId(request);
    const archive = await store.exportPackage(id);
    response.status(200).type('zip').set('Content-Disposition', `attachment; filename="maskcanvas-${id}.zip"`).send(archive);
  });
  api.post('/import-package', requireLocalMutation(token), async (request, response) => {
    response.status(201).json(await store.importPackage(parseBody(packageImportSchema, request).dataBase64));
  });
  app.use('/api', api);
  app.use('/api', (_request, _response, next) => next(new StoreError('NOT_FOUND', 'API 路径不存在', 404)));

  if (options.staticDir) {
    const staticDir = path.resolve(options.staticDir);
    app.use(express.static(staticDir, { index: false, fallthrough: true }));
    app.get('*splat', (request, response, next) => {
      if (request.path.startsWith('/api/') || request.path === '/api') return next();
      const index = path.join(staticDir, 'index.html');
      if (!existsSync(index)) return next();
      response.sendFile(index);
    });
  }

  const handleError: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof StoreError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (isBodyTooLarge(error)) {
      response.status(413).json({ error: { code: 'REQUEST_TOO_LARGE', message: '请求超过大小限制' } });
      return;
    }
    if (isJsonParseError(error)) {
      response.status(400).json({ error: { code: 'INVALID_JSON', message: '请求 JSON 格式无效' } });
      return;
    }
    console.error('MaskCanvas request failed:', error instanceof Error ? error.message : 'unknown error');
    response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '服务端处理失败' } });
  };
  app.use(handleError);
  return app;
}

function requireLocalMutation(token: string) {
  return (request: Request, _response: Response, next: (error?: unknown) => void) => {
    const supplied = request.get('x-maskcanvas-token') ?? '';
    const expected = Buffer.from(token);
    const actual = Buffer.from(supplied);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) { next(new StoreError('INVALID_SESSION', '会话令牌无效或已过期', 403)); return; }
    next();
  };
}

function requireLocalApiRequest() {
  return (request: Request, response: Response, next: (error?: unknown) => void) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const host = parseAuthority(request.get('host'));
    if (!host || !isAllowedApiHost(host.hostname)) { next(new StoreError('LOCAL_ONLY', '仅允许本机或已授权远程访问 API', 403)); return; }
    const origin = request.get('origin');
    if (origin !== undefined) {
      try {
        const parsed = new URL(origin);
        const originPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
        const allowedOriginPorts = new Set(['7317', '5173', host.port]);
        if (parsed.protocol !== 'http:' || !isAllowedApiHost(parsed.hostname.toLowerCase()) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || !allowedOriginPorts.has(originPort)) throw new Error('origin');
      } catch { next(new StoreError('INVALID_ORIGIN', 'Origin 必须来自本机 7317/5173 端口或当前 Host', 403)); return; }
    }
    next();
  };
}

function parseBody<T extends z.ZodType>(schema: T, request: Request): z.infer<T> {
  const result = schema.safeParse(request.body);
  if (!result.success) throw new StoreError('INVALID_REQUEST', '请求数据格式无效');
  return result.data;
}
function parseProjectId(request: Request): string {
  const id = stringParam(request, 'id');
  const result = idSchema.safeParse(id);
  if (!result.success) throw new StoreError('INVALID_PROJECT_ID', '项目 ID 无效');
  return id;
}
function parseProposalId(request: Request): string {
  const id = stringParam(request, 'proposalId');
  const result = idSchema.safeParse(id);
  if (!result.success) throw new StoreError('INVALID_PROPOSAL_ID', '提议 ID 无效');
  return id;
}
function stringParam(request: Request, key: string): string {
  const value = request.params[key];
  if (typeof value !== 'string') throw new StoreError('INVALID_REQUEST', '路径参数无效');
  return value;
}
function parseAuthority(host: string | undefined): { hostname: string; port: string } | undefined {
  if (!host || /[/?#@\\]/.test(host)) return undefined;
  try {
    const parsed = new URL(`http://${host}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return undefined;
    return { hostname: parsed.hostname.toLowerCase(), port: parsed.port || '80' };
  } catch { return undefined; }
}
function isLoopbackName(hostname: string): boolean { return hostname === '127.0.0.1' || hostname === 'localhost'; }
function isTailscaleHost(hostname: string): boolean {
  if (hostname.endsWith('.ts.net')) return true;
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  // Tailscale CGNAT 100.64.0.0/10
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}
function isAllowedApiHost(hostname: string): boolean {
  if (isLoopbackName(hostname)) return true;
  return process.env.MASKCANVAS_ALLOW_REMOTE_BROWSER === '1' && isTailscaleHost(hostname);
}
function isBodyTooLarge(error: unknown): boolean { return typeof error === 'object' && error !== null && 'type' in error && (error as { type?: string }).type === 'entity.too.large'; }
function isJsonParseError(error: unknown): boolean { return error instanceof SyntaxError && typeof error === 'object' && error !== null && 'body' in error; }

