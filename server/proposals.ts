import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { EditProposal, ImageBackend, ProcessingTarget, Project, ProposalInput, ProposalSuggestion, Region } from '../packages/shared/types.js';
import { Store, StoreError, validateRegionList } from './store.js';

const MAX_PROPOSALS = 200;
const uuidSchema = z.string().uuid();
const proposalInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  goal: z.string().trim().min(1).max(4_000),
  backend: z.enum(['qwen', 'gpt']),
  source: z.enum(['agent', 'human']),
  baseVersionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  projectRevision: z.number().int().nonnegative(),
  regions: z.array(z.unknown()).max(200),
  suggestions: z.array(z.unknown()).max(200),
}).strict();
const suggestionSchema: z.ZodType<ProposalSuggestion> = z.object({
  regionId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  reason: z.string().trim().min(1).max(2_000),
  enabled: z.boolean(),
  confidence: z.number().finite().min(0).max(1).optional(),
}).strict();
const confirmationSchema = z.object({
  id: uuidSchema,
  confirmedAt: z.string().datetime(),
  proposalRevision: z.number().int().nonnegative(),
  projectRevision: z.number().int().nonnegative(),
  baseVersionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  processing: z.object({ destination: z.string().min(1).max(300), modelId: z.string().min(1).max(160) }).strict().optional(),
}).strict();
const editProposalSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  title: z.string().trim().min(1).max(160),
  goal: z.string().trim().min(1).max(4_000),
  source: z.enum(['agent', 'human']),
  backend: z.enum(['qwen', 'gpt']),
  baseVersionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  projectRevision: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  status: z.enum(['draft', 'confirmed', 'stale', 'cancelled']),
  regions: z.array(z.unknown()).max(200),
  suggestions: z.array(suggestionSchema).max(200),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  confirmation: confirmationSchema.optional(),
}).strict();
const updateSchema = z.object({
  revision: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(160).optional(),
  goal: z.string().trim().min(1).max(4_000).optional(),
  backend: z.enum(['qwen', 'gpt']).optional(),
  regions: z.array(z.unknown()).max(200).optional(),
  suggestions: z.array(z.unknown()).max(200).optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== 'revision'), '至少要修改一个计划字段');
const confirmSchema = z.object({ revision: z.number().int().nonnegative(), projectRevision: z.number().int().nonnegative() }).strict();
const cancelSchema = z.object({ revision: z.number().int().nonnegative() }).strict();

export type ProposalUpdate = {
  revision: number;
  title?: string;
  goal?: string;
  backend?: ImageBackend;
  regions?: Region[];
  suggestions?: ProposalSuggestion[];
};
export interface ProposalConfirmationInput { revision: number; projectRevision: number }
export interface ProposalCancelInput { revision: number }
export interface ConfirmedProposal { proposal: EditProposal; project: Project; regionIds: string[]; regions: Region[] }

/**
 * Persists agent/human proposal drafts separately from the project's official
 * annotations. Only `confirm` copies a validated snapshot into Store.
 */
export class ProposalStore {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(readonly store: Store, private readonly options: { processing?: (backend: ImageBackend) => ProcessingTarget | undefined } = {}) {}

  async list(projectId: string): Promise<EditProposal[]> {
    return this.withLock(projectId, async () => {
      const project = await this.store.getProject(projectId);
      const proposals = await this.read(projectId, project);
      return proposals.map((proposal) => this.withDerivedStatus(proposal, project));
    });
  }

  async get(projectId: string, proposalId: string): Promise<EditProposal> {
    return this.withLock(projectId, async () => {
      const project = await this.store.getProject(projectId);
      const proposal = await this.find(projectId, proposalId, project);
      return this.withDerivedStatus(proposal, project);
    });
  }

  async create(projectId: string, input: ProposalInput | unknown): Promise<EditProposal> {
    return this.withLock(projectId, async () => {
      const project = await this.store.getProject(projectId);
      const parsed = this.parseInput(input, project);
      this.assertFreshInput(parsed, project);
      const now = new Date().toISOString();
      const proposal: EditProposal = {
        ...parsed,
        id: randomUUID(),
        projectId,
        revision: 0,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      };
      const proposals = await this.read(projectId, project);
      if (proposals.length >= MAX_PROPOSALS) throw new StoreError('PROPOSAL_LIMIT', '项目提议数量已达上限');
      await this.write(projectId, [...proposals, proposal]);
      return proposal;
    });
  }

  async update(projectId: string, proposalId: string, input: ProposalUpdate | unknown): Promise<EditProposal> {
    return this.withLock(projectId, async () => {
      const project = await this.store.getProject(projectId);
      const patch = this.parse(updateSchema, input, 'INVALID_PROPOSAL');
      const proposals = await this.read(projectId, project);
      const index = this.indexOf(proposals, projectId, proposalId);
      const current = proposals[index];
      this.assertProposalRevision(current, patch.revision);
      const status = this.derivedStatus(current, project);
      if (status === 'cancelled') throw new StoreError('PROPOSAL_CANCELLED', '已取消的提议不能修改', 409);
      if (status === 'stale') throw new StoreError('PROPOSAL_STALE', '照片基准或项目修订已变化；请基于最新项目重新创建提议', 409);

      // A confirmed plan may be explicitly edited back into a fresh draft. Its
      // new snapshot starts from the current project revision, and confirmation
      // is always removed before persisting the edited plan.
      const parsed = this.parseInput({
        title: patch.title ?? current.title,
        goal: patch.goal ?? current.goal,
        backend: patch.backend ?? current.backend,
        source: current.source,
        baseVersionId: project.baseVersionId,
        projectRevision: project.revision,
        regions: patch.regions ?? current.regions,
        suggestions: patch.suggestions ?? current.suggestions,
      }, project);
      const next: EditProposal = {
        ...current,
        ...parsed,
        revision: current.revision + 1,
        status: 'draft',
        updatedAt: new Date().toISOString(),
        confirmation: undefined,
      };
      proposals[index] = next;
      await this.write(projectId, proposals);
      return next;
    });
  }

  async confirm(projectId: string, proposalId: string, input: ProposalConfirmationInput | unknown): Promise<EditProposal> {
    return this.withLock(projectId, async () => {
      const request = this.parse(confirmSchema, input, 'INVALID_PROPOSAL');
      const project = await this.store.getProject(projectId);
      const proposals = await this.read(projectId, project);
      const index = this.indexOf(proposals, projectId, proposalId);
      const proposal = proposals[index];
      this.assertProposalRevision(proposal, request.revision);
      if (this.derivedStatus(proposal, project) === 'cancelled') throw new StoreError('PROPOSAL_CANCELLED', '已取消的提议不能确认', 409);
      if (this.derivedStatus(proposal, project) !== 'draft' || project.revision !== request.projectRevision || project.revision !== proposal.projectRevision || project.baseVersionId !== proposal.baseVersionId) {
        throw new StoreError('PROPOSAL_STALE', '项目或提议已变化；请刷新并基于当前版本重新确认', 409);
      }

      const selected = confirmedRegions(proposal);
      if (!selected.some(region => region.kind === 'edit')) throw new StoreError('NO_ENABLED_EDITS', '没有启用的编辑建议，无需确认或生成', 409);
      // Retain unrelated manual annotations. Only the explicitly reviewed
      // selected IDs are replaced; they alone authorize generated changes.
      const merged = new Map(project.regions.map(region => [region.id, region]));
      for (const region of selected) merged.set(region.id, region);
      const nextRevision = proposal.revision + 1;
      const snapshot = { ...proposal, revision: nextRevision };
      const processing = this.options.processing?.(proposal.backend);
      const confirmation = {
        id: randomUUID(),
        confirmedAt: new Date().toISOString(),
        proposalRevision: nextRevision,
        projectRevision: project.revision + 1,
        baseVersionId: project.baseVersionId,
        fingerprint: fingerprint(snapshot, project.revision + 1, selected, processing),
        ...(processing ? { processing } : {}),
      };
      const next: EditProposal = {
        ...snapshot,
        status: 'confirmed',
        updatedAt: confirmation.confirmedAt,
        confirmation,
      };
      proposals[index] = next;
      // Prepare confirmation BEFORE touching annotations. A crash here is
      // recognized as an uncommitted draft by derivedStatus; it can be reviewed
      // and confirmed again. A successful project write completes the commit.
      await this.write(projectId, proposals);
      try {
        await this.store.saveRegions(projectId, { revision: request.projectRevision, regions: [...merged.values()] });
      } catch (error) {
        proposals[index] = { ...proposal, revision: nextRevision, status: 'draft', confirmation: undefined };
        await this.write(projectId, proposals);
        throw error;
      }
      const latest = await this.store.getProject(projectId);
      return this.withDerivedStatus(next, latest);
    });
  }

  async cancel(projectId: string, proposalId: string, input: ProposalCancelInput | unknown): Promise<EditProposal> {
    return this.withLock(projectId, async () => {
      const request = this.parse(cancelSchema, input, 'INVALID_PROPOSAL');
      const project = await this.store.getProject(projectId);
      const proposals = await this.read(projectId, project);
      const index = this.indexOf(proposals, projectId, proposalId);
      const proposal = proposals[index];
      this.assertProposalRevision(proposal, request.revision);
      if (this.derivedStatus(proposal, project) === 'cancelled') return this.withDerivedStatus(proposal, project);
      const next: EditProposal = { ...proposal, revision: proposal.revision + 1, status: 'cancelled', updatedAt: new Date().toISOString(), confirmation: undefined };
      proposals[index] = next;
      await this.write(projectId, proposals);
      return next;
    });
  }

  async assertConfirmed(projectId: string, proposalId: string, confirmationId: string, backend?: ImageBackend): Promise<ConfirmedProposal> {
    return this.withLock(projectId, async () => {
      if (!uuidSchema.safeParse(confirmationId).success) throw new StoreError('INVALID_CONFIRMATION', '确认 ID 无效');
      const project = await this.store.getProject(projectId);
      const proposal = await this.find(projectId, proposalId, project);
      const confirmation = proposal.confirmation;
      const selected = confirmedRegions(proposal);
      const valid = this.derivedStatus(proposal, project) === 'confirmed'
        && confirmation !== undefined
        && confirmation.id === confirmationId
        && (backend === undefined || proposal.backend === backend)
        && confirmation.proposalRevision === proposal.revision
        && confirmation.projectRevision === project.revision
        && confirmation.baseVersionId === project.baseVersionId
        && proposal.baseVersionId === project.baseVersionId
        && containsRegions(project.regions, selected)
        && confirmation.fingerprint === fingerprint(proposal, confirmation.projectRevision, selected, confirmation.processing)
        && (!this.options.processing || sameJson(confirmation.processing, this.options.processing(proposal.backend)));
      if (!valid) throw new StoreError('CONFIRMATION_INVALID', '提议确认已失效或与当前项目不匹配', 409);
      const regions = [...selected.filter(region => region.kind === 'edit'), ...project.regions.filter(region => region.kind === 'keep')];
      return { proposal: this.withDerivedStatus(proposal, project), project, regionIds: regions.map((region) => region.id), regions };
    });
  }

  private parseInput(value: unknown, project: Project, inheritProtection = true): ProposalInput {
    const input = this.parse(proposalInputSchema, value, 'INVALID_PROPOSAL');
    const regions = validateRegionList(input.regions, project.width, project.height);
    // Existing protection is visible in every new/revised draft. Removing an
    // inherited keep requires editing its explicit geometry, not omitting it.
    for (const keep of inheritProtection ? project.regions.filter(region => region.kind === 'keep') : []) {
      const supplied = regions.find(region => region.id === keep.id);
      if (supplied && supplied.kind !== 'keep') throw new StoreError('PROTECTION_CONFLICT', '建议不能把已有保护区域改为编辑区域；请先在正式标注中明确调整保护', 409);
      if (!supplied) regions.push(structuredClone(keep));
    }
    validateRegionList(regions, project.width, project.height);
    const suggestionsParsed = z.array(suggestionSchema).max(200).safeParse(input.suggestions);
    if (!suggestionsParsed.success) throw new StoreError('INVALID_PROPOSAL', '提议建议格式无效');
    const suggestions = suggestionsParsed.data;
    const edits = regions.filter((region) => region.kind === 'edit');
    const editIds = new Set(edits.map((region) => region.id));
    if (new Set(suggestions.map((suggestion) => suggestion.regionId)).size !== suggestions.length
      || suggestions.length !== edits.length
      || suggestions.some((suggestion) => !editIds.has(suggestion.regionId))) {
      throw new StoreError('INVALID_PROPOSAL', '每个 edit 区域必须有且仅有一条建议，keep 区域不能包含建议');
    }
    return { ...input, regions, suggestions };
  }

  private assertFreshInput(input: ProposalInput, project: Project): void {
    if (input.baseVersionId !== project.baseVersionId || input.projectRevision !== project.revision) {
      throw new StoreError('REVISION_CONFLICT', '提议基于过期的项目基准或修订，请先刷新项目', 409);
    }
  }

  private async find(projectId: string, proposalId: string, project: Project): Promise<EditProposal> {
    const proposals = await this.read(projectId, project);
    return proposals[this.indexOf(proposals, projectId, proposalId)];
  }

  private indexOf(proposals: EditProposal[], projectId: string, proposalId: string): number {
    if (!uuidSchema.safeParse(proposalId).success) throw new StoreError('INVALID_PROPOSAL_ID', '提议 ID 无效');
    const index = proposals.findIndex((proposal) => proposal.id === proposalId && proposal.projectId === projectId);
    if (index < 0) throw new StoreError('PROPOSAL_NOT_FOUND', '提议不存在', 404);
    return index;
  }

  private assertProposalRevision(proposal: EditProposal, revision: number): void {
    if (proposal.revision !== revision) throw new StoreError('PROPOSAL_REVISION_CONFLICT', '提议已被修改，请读取最新内容后重试', 409);
  }

  private async read(projectId: string, project: Project): Promise<EditProposal[]> {
    let raw: string;
    try { raw = await readFile(this.filePath(projectId), 'utf8'); }
    catch (error) {
      if (isCode(error, 'ENOENT')) return [];
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new StoreError('CORRUPT_PROPOSALS', '提议文件不是有效 JSON', 500); }
    const result = z.array(editProposalSchema).max(MAX_PROPOSALS).safeParse(parsed);
    if (!result.success || result.data.some((proposal) => proposal.projectId !== projectId)) {
      throw new StoreError('CORRUPT_PROPOSALS', '提议文件格式无效', 500);
    }
    const proposals = result.data.map((proposal) => {
      const regions = validateRegionList(proposal.regions, project.width, project.height);
      const checked = this.parseInput({
        title: proposal.title, goal: proposal.goal, backend: proposal.backend, source: proposal.source,
        baseVersionId: proposal.baseVersionId, projectRevision: proposal.projectRevision,
        regions, suggestions: proposal.suggestions,
      }, project, false);
      return { ...proposal, ...checked };
    });
    if (new Set(proposals.map((proposal) => proposal.id)).size !== proposals.length) throw new StoreError('CORRUPT_PROPOSALS', '提议 ID 不能重复', 500);
    return proposals;
  }

  private async write(projectId: string, proposals: EditProposal[]): Promise<void> {
    const parsed = z.array(editProposalSchema).max(MAX_PROPOSALS).safeParse(proposals);
    if (!parsed.success) throw new StoreError('INVALID_PROPOSAL', '提议数据未通过校验', 500);
    const filePath = this.filePath(projectId);
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, Buffer.from(JSON.stringify(proposals, null, 2)), { flag: 'wx' });
      await rename(temporary, filePath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private filePath(projectId: string): string {
    if (!uuidSchema.safeParse(projectId).success) throw new StoreError('INVALID_PROJECT_ID', '项目 ID 无效');
    return path.join(this.store.dataDir, projectId, 'proposals.json');
  }

  private derivedStatus(proposal: EditProposal, project: Project): EditProposal['status'] {
    if (proposal.status === 'cancelled' && !proposal.confirmation) return 'cancelled';
    const confirmation = proposal.confirmation;
    if (!confirmation) return proposal.baseVersionId === project.baseVersionId && proposal.projectRevision === project.revision ? 'draft' : 'stale';
    if (confirmation.projectRevision === project.revision + 1 && proposal.projectRevision === project.revision && proposal.baseVersionId === project.baseVersionId) return 'draft';
    const selected = confirmedRegions(proposal);
    const valid = confirmation.proposalRevision === proposal.revision
      && confirmation.projectRevision === project.revision
      && confirmation.baseVersionId === project.baseVersionId
      && proposal.baseVersionId === project.baseVersionId
      && containsRegions(project.regions, selected)
      && confirmation.fingerprint === fingerprint(proposal, confirmation.projectRevision, selected, confirmation.processing)
      && (!this.options.processing || sameJson(confirmation.processing, this.options.processing(proposal.backend)));
    return valid ? 'confirmed' : 'stale';
  }

  private withDerivedStatus(proposal: EditProposal, project: Project): EditProposal {
    const status = this.derivedStatus(proposal, project);
    return { ...proposal, status, ...(status === 'draft' ? { confirmation: undefined } : {}) };
  }

  private parse<T extends z.ZodType>(schema: T, input: unknown, code: string): z.infer<T> {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new StoreError(code, '提议请求数据格式无效');
    return parsed.data;
  }

  private async withLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    if (!uuidSchema.safeParse(projectId).success) throw new StoreError('INVALID_PROJECT_ID', '项目 ID 无效');
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.locks.set(projectId, tail);
    await previous;
    try { return await operation(); }
    finally { release(); if (this.locks.get(projectId) === tail) this.locks.delete(projectId); }
  }
}

function confirmedRegions(proposal: Pick<EditProposal, 'regions' | 'suggestions'>): Region[] {
  const enabled = new Set(proposal.suggestions.filter((suggestion) => suggestion.enabled).map((suggestion) => suggestion.regionId));
  return proposal.regions.filter((region) => region.kind === 'keep' || enabled.has(region.id));
}

function fingerprint(proposal: EditProposal, projectRevision: number, selected: Region[], processing?: ProcessingTarget): string {
  const payload = {
    projectId: proposal.projectId,
    baseVersionId: proposal.baseVersionId,
    proposalProjectRevision: proposal.projectRevision,
    projectRevision,
    proposalRevision: proposal.revision,
    title: proposal.title,
    goal: proposal.goal,
    source: proposal.source,
    backend: proposal.backend,
    regions: selected,
    planRegions: proposal.regions,
    suggestions: proposal.suggestions,
    ...(processing ? { processing } : {}),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function containsRegions(all: Region[], selected: Region[]): boolean {
  return selected.every(region => sameJson(all.find(item => item.id === region.id), region));
}
function isCode(error: unknown, code: string): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === code; }
