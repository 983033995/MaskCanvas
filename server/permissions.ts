import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ImageBackend } from '../packages/shared/types.js';
import { Store, StoreError } from './store.js';

export type GrantPurpose = 'analysis' | 'generation';
export type GrantBackend = 'agent' | ImageBackend;
export interface GrantInput {
  baseVersionId: string;
  purpose: GrantPurpose;
  backend: GrantBackend;
  destination: string;
  expiresAt?: string;
  maxJobs?: number;
}
export interface Grant extends GrantInput {
  id: string;
  projectId: string;
  createdAt: string;
  consumedJobs: number;
  revokedAt?: string;
}
export interface GrantDocument {
  format: 'maskcanvas.permissions';
  schemaVersion: 1;
  projectId: string;
  grants: Grant[];
  consumptions: Array<{
    grantId: string;
    idempotencyKey: string;
    snapshotFingerprint: string;
    consumedAt: string;
  }>;
}
export type GrantAssertion = Pick<GrantInput, 'baseVersionId' | 'purpose' | 'backend' | 'destination'> & { grantId: string };
export interface ConsumeResult { grant: Grant; consumed: boolean }

const CLIENT_DESTINATIONS = ['client:codex', 'client:workbuddy', 'client:qoder', 'client:external-agent'] as const;
const projectIdSchema = z.string().uuid();
const grantIdSchema = z.string().uuid();
const idempotencyKeySchema = z.string().uuid();
const grantInputSchema: z.ZodType<GrantInput> = z.object({
  baseVersionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  purpose: z.enum(['analysis', 'generation']),
  backend: z.enum(['agent', 'qwen', 'gpt']),
  destination: z.string().trim().min(1).max(300),
  expiresAt: z.string().datetime().optional(),
  maxJobs: z.number().finite().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict().superRefine((input, context) => {
  if (input.purpose === 'analysis' && input.backend !== 'agent') context.addIssue({ code: 'custom', message: 'analysis 授权必须使用 agent 后端' });
  if (input.purpose === 'generation' && input.backend === 'agent') context.addIssue({ code: 'custom', message: 'generation 授权必须使用 qwen 或 gpt 后端' });
  if (input.purpose === 'analysis' && input.maxJobs !== undefined) context.addIssue({ code: 'custom', message: 'maxJobs 仅用于 generation 授权' });
});
const grantSchema: z.ZodType<Grant> = z.object({
  id: grantIdSchema,
  projectId: projectIdSchema,
  baseVersionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  purpose: z.enum(['analysis', 'generation']),
  backend: z.enum(['agent', 'qwen', 'gpt']),
  destination: z.string().min(1).max(300),
  expiresAt: z.string().datetime().optional(),
  maxJobs: z.number().finite().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  createdAt: z.string().datetime(),
  consumedJobs: z.number().int().nonnegative(),
  revokedAt: z.string().datetime().optional(),
}).strict().superRefine((grant, context) => {
  const checked = grantInputSchema.safeParse({
    baseVersionId: grant.baseVersionId, purpose: grant.purpose, backend: grant.backend,
    destination: grant.destination, expiresAt: grant.expiresAt, maxJobs: grant.maxJobs,
  });
  if (!checked.success) context.addIssue({ code: 'custom', message: '授权字段无效' });
  try {
    if (normalizeDestination(grant.destination, grant.purpose) !== grant.destination) context.addIssue({ code: 'custom', message: '目的地未规范化' });
  } catch { context.addIssue({ code: 'custom', message: '目的地无效' }); }
  if (grant.maxJobs !== undefined && grant.consumedJobs > grant.maxJobs) context.addIssue({ code: 'custom', message: '已消费授权次数超过上限' });
});
const grantDocumentSchema: z.ZodType<GrantDocument> = z.object({
  format: z.literal('maskcanvas.permissions'),
  schemaVersion: z.literal(1),
  projectId: projectIdSchema,
  grants: z.array(grantSchema).max(1_000),
  consumptions: z.array(z.object({
    grantId: grantIdSchema,
    idempotencyKey: idempotencyKeySchema,
    snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    consumedAt: z.string().datetime(),
  }).strict()).max(1_000_000),
}).strict().superRefine((document, context) => {
  if (document.grants.some(grant => grant.projectId !== document.projectId)) context.addIssue({ code: 'custom', message: '授权项目 ID 不一致' });
  if (new Set(document.grants.map(grant => grant.id)).size !== document.grants.length) context.addIssue({ code: 'custom', message: '授权 ID 不能重复' });
  if (new Set(document.consumptions.map(item => item.idempotencyKey)).size !== document.consumptions.length) context.addIssue({ code: 'custom', message: '幂等键不能重复' });
  const grantIds = new Set(document.grants.map(grant => grant.id));
  if (document.consumptions.some(item => !grantIds.has(item.grantId))) context.addIssue({ code: 'custom', message: '授权消费记录找不到对应授权' });
  for (const grant of document.grants) {
    const used = document.consumptions.filter(item => item.grantId === grant.id).length;
    if (grant.consumedJobs !== used) context.addIssue({ code: 'custom', message: '授权消费次数与记录不一致' });
  }
});

/** Project-scoped, fail-closed authorization records. This class never makes remote requests. */
export class ProjectPermissions {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(readonly store: Store) {}

  async list(projectId: string): Promise<Grant[]> {
    return this.withLock(projectId, async () => {
      const project = await this.store.getProject(projectId);
      return (await this.read(projectId)).grants.map(grant => this.copy(grant));
    });
  }

  async get(projectId: string, grantId: string): Promise<Grant> {
    return this.withLock(projectId, async () => {
      await this.store.getProject(projectId);
      const document = await this.read(projectId);
      return this.copy(this.find(document, projectId, grantId));
    });
  }

  async create(projectId: string, value: GrantInput | unknown): Promise<Grant> {
    return this.withLock(projectId, async () => {
      const project = await this.store.getProject(projectId);
      const input = this.parseInput(value);
      if (input.baseVersionId !== project.baseVersionId) throw new StoreError('PERMISSION_STALE_BASE', '授权必须绑定项目当前基准照片', 409);
      if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) throw new StoreError('INVALID_GRANT', 'expiresAt 必须晚于当前时间');
      const document = await this.read(projectId);
      if (document.grants.length >= 1_000) throw new StoreError('PERMISSION_LIMIT', '项目授权数量已达上限');
      const grant: Grant = {
        ...input,
        id: randomUUID(), projectId,
        createdAt: new Date().toISOString(), consumedJobs: 0,
      };
      document.grants.push(grant);
      await this.write(projectId, document);
      return this.copy(grant);
    });
  }

  async revoke(projectId: string, grantId: string): Promise<Grant> {
    return this.withLock(projectId, async () => {
      await this.store.getProject(projectId);
      const document = await this.read(projectId);
      const grant = this.find(document, projectId, grantId);
      if (!grant.revokedAt) {
        grant.revokedAt = new Date().toISOString();
        await this.write(projectId, document);
      }
      return this.copy(grant);
    });
  }

  async assertAllowed(projectId: string, assertion: GrantAssertion | unknown): Promise<Grant> {
    return this.withLock(projectId, async () => {
      const project = await this.store.getProject(projectId);
      const checked = this.parseAssertion(assertion);
      const grant = this.find(await this.read(projectId), projectId, checked.grantId);
      this.assertMatches(grant, checked, project.baseVersionId);
      return this.copy(grant);
    });
  }

  /**
   * Atomically consumes one generation allowance. Repeating the same key with
   * the same grant/snapshot is safe and does not spend another allowance.
   */
  async consume(projectId: string, grantId: string, idempotencyKey: string, assertion: Omit<GrantAssertion, 'grantId'> | unknown): Promise<ConsumeResult> {
    return this.withLock(projectId, async () => {
      const project = await this.store.getProject(projectId);
      const grantAssertion = this.parseAssertion({ ...(this.parseAssertionFields(assertion)), grantId });
      const key = idempotencyKeySchema.safeParse(idempotencyKey);
      if (!key.success) throw new StoreError('INVALID_PERMISSION_KEY', '授权消费幂等键必须是 UUID');
      const document = await this.read(projectId);
      const grant = this.find(document, projectId, grantId);
      this.assertMatches(grant, grantAssertion, project.baseVersionId);
      if (grant.purpose !== 'generation') throw new StoreError('PERMISSION_PURPOSE_MISMATCH', '只有 generation 授权可以消费作业额度', 403);
      const snapshotFingerprint = fingerprint(grantAssertion);
      const previous = document.consumptions.find(item => item.idempotencyKey === idempotencyKey);
      if (previous) {
        if (previous.grantId !== grant.id || previous.snapshotFingerprint !== snapshotFingerprint) {
          throw new StoreError('PERMISSION_IDEMPOTENCY_CONFLICT', '同一幂等键已绑定到另一授权或快照', 409);
        }
        return { grant: this.copy(grant), consumed: false };
      }
      if (grant.maxJobs !== undefined && grant.consumedJobs >= grant.maxJobs) throw new StoreError('PERMISSION_LIMIT_REACHED', '生成授权作业次数已用完', 403);
      grant.consumedJobs++;
      document.consumptions.push({ grantId: grant.id, idempotencyKey, snapshotFingerprint, consumedAt: new Date().toISOString() });
      await this.write(projectId, document);
      return { grant: this.copy(grant), consumed: true };
    });
  }

  private parseInput(value: unknown): GrantInput {
    const parsed = grantInputSchema.safeParse(value);
    if (!parsed.success) throw new StoreError('INVALID_GRANT', '授权数据格式无效');
    return { ...parsed.data, destination: normalizeDestination(parsed.data.destination, parsed.data.purpose) };
  }

  private parseAssertion(value: unknown): GrantAssertion {
    const parsed = z.object({
      grantId: grantIdSchema,
      baseVersionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
      purpose: z.enum(['analysis', 'generation']),
      backend: z.enum(['agent', 'qwen', 'gpt']),
      destination: z.string().trim().min(1).max(300),
    }).strict().safeParse(value);
    if (!parsed.success) throw new StoreError('INVALID_GRANT_ASSERTION', '授权检查数据格式无效');
    return { ...parsed.data, destination: normalizeDestination(parsed.data.destination, parsed.data.purpose) };
  }

  private parseAssertionFields(value: unknown): Omit<GrantAssertion, 'grantId'> {
    const parsed = z.object({
      baseVersionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
      purpose: z.enum(['analysis', 'generation']),
      backend: z.enum(['agent', 'qwen', 'gpt']),
      destination: z.string().trim().min(1).max(300),
    }).strict().safeParse(value);
    if (!parsed.success) throw new StoreError('INVALID_GRANT_ASSERTION', '授权检查数据格式无效');
    return { ...parsed.data, destination: normalizeDestination(parsed.data.destination, parsed.data.purpose) };
  }

  private assertMatches(grant: Grant, assertion: GrantAssertion, currentBaseVersionId: string): void {
    if (grant.revokedAt) throw new StoreError('PERMISSION_REVOKED', '项目授权已撤销', 403);
    if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) throw new StoreError('PERMISSION_EXPIRED', '项目授权已过期', 403);
    if (grant.baseVersionId !== currentBaseVersionId || assertion.baseVersionId !== currentBaseVersionId) {
      throw new StoreError('PERMISSION_STALE_BASE', '授权对应的照片基准已变化，请对当前照片重新授权', 409);
    }
    if (grant.purpose !== assertion.purpose || grant.backend !== assertion.backend || grant.destination !== assertion.destination) {
      throw new StoreError('PERMISSION_SCOPE_MISMATCH', '授权用途、后端或目的地不匹配', 403);
    }
  }

  private find(document: GrantDocument, projectId: string, grantId: string): Grant {
    if (!grantIdSchema.safeParse(grantId).success) throw new StoreError('INVALID_GRANT_ID', '授权 ID 无效');
    const grant = document.grants.find(item => item.projectId === projectId && item.id === grantId);
    if (!grant) throw new StoreError('GRANT_NOT_FOUND', '项目授权不存在', 404);
    return grant;
  }

  private async read(projectId: string): Promise<GrantDocument> {
    let raw: string;
    try { raw = await readFile(this.filePath(projectId), 'utf8'); }
    catch (error) {
      if (isCode(error, 'ENOENT')) return { format: 'maskcanvas.permissions', schemaVersion: 1, projectId, grants: [], consumptions: [] };
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { throw new StoreError('CORRUPT_PERMISSIONS', '项目授权文件不是有效 JSON', 500); }
    const parsed = grantDocumentSchema.safeParse(value);
    if (!parsed.success || parsed.data.projectId !== projectId) throw new StoreError('CORRUPT_PERMISSIONS', '项目授权文件格式无效', 500);
    return parsed.data;
  }

  private async write(projectId: string, document: GrantDocument): Promise<void> {
    const parsed = grantDocumentSchema.safeParse(document);
    if (!parsed.success || parsed.data.projectId !== projectId) throw new StoreError('INVALID_GRANT', '授权记录未通过存储校验', 500);
    const file = this.filePath(projectId);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, Buffer.from(JSON.stringify(document, null, 2)), { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private filePath(projectId: string): string {
    if (!projectIdSchema.safeParse(projectId).success) throw new StoreError('INVALID_PROJECT_ID', '项目 ID 无效');
    return path.join(this.store.dataDir, projectId, 'permissions.json');
  }

  private copy(grant: Grant): Grant { return structuredClone(grant); }

  private async withLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    if (!projectIdSchema.safeParse(projectId).success) throw new StoreError('INVALID_PROJECT_ID', '项目 ID 无效');
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => current);
    this.locks.set(projectId, tail);
    await previous;
    try { return await operation(); }
    finally { release(); if (this.locks.get(projectId) === tail) this.locks.delete(projectId); }
  }
}

function normalizeDestination(value: string, purpose: GrantPurpose): string {
  if ((CLIENT_DESTINATIONS as readonly string[]).includes(value)) {
    if (purpose !== 'analysis') throw new StoreError('INVALID_DESTINATION', '生成授权目的地必须是明确的服务 origin');
    return value;
  }
  let url: URL;
  try { url = new URL(value); }
  catch { throw new StoreError('INVALID_DESTINATION', '目的地必须是已登记的 Agent 客户端或服务 origin'); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || !url.hostname
    || url.username
    || url.password
    || (url.pathname !== '' && url.pathname !== '/')
    || url.search
    || url.hash) {
    throw new StoreError('INVALID_DESTINATION', '服务目的地只能是 HTTP(S) origin，不得包含凭据、路径、查询或片段');
  }
  if (purpose === 'analysis') throw new StoreError('INVALID_DESTINATION', 'Agent 分析目的地必须使用已登记的客户端标识');
  return url.origin;
}

function fingerprint(assertion: GrantAssertion): string {
  // Importing crypto hash at module scope keeps this assertion deterministic;
  // destination has already been canonicalized.
  return createSha256(JSON.stringify({
    grantId: assertion.grantId,
    baseVersionId: assertion.baseVersionId,
    purpose: assertion.purpose,
    backend: assertion.backend,
    destination: assertion.destination,
  }));
}

function createSha256(value: string): string {
  // Use the platform crypto API without exposing a credential or destination
  // outside this process.
  return createHash('sha256').update(value).digest('hex');
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}
