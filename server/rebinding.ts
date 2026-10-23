import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AnnotationDocument, EditProposal, ImageBackend, ProposalInput, ProposalSuggestion, Region } from '../packages/shared/types.js';
import { annotationDocumentSchema } from './annotations.js';
import { ProposalStore } from './proposals.js';
import { Store, StoreError, validateRegionList } from './store.js';

export interface RebindSource {
  projectId: string;
  baseVersionId: string;
  revision: number;
}

export interface RebindTarget {
  projectId: string;
  baseVersionId: string;
  revision: number;
}

export interface RebindResult {
  proposal: EditProposal;
  source: RebindSource;
  target: RebindTarget;
  imageMatched: true;
}

const proposalDocumentSchema = z.object({
  format: z.literal('maskcanvas.proposal'),
  schemaVersion: z.literal(1),
  projectId: z.string().uuid(),
  image: annotationDocumentSchema.shape.image,
  proposal: z.object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    title: z.string(),
    goal: z.string(),
    backend: z.enum(['qwen', 'gpt']),
    source: z.enum(['agent', 'human']),
    baseVersionId: z.string().min(1).max(100),
    projectRevision: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    status: z.enum(['draft', 'confirmed', 'stale', 'cancelled']),
    regions: z.array(z.unknown()).max(200),
    suggestions: z.array(z.unknown()).max(200),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    // Informational only. Rebinding never imports execution authority.
    confirmation: z.unknown().optional(),
  }).strict(),
}).strict();
const proposalSuggestionsSchema: z.ZodType<ProposalSuggestion[]> = z.array(z.object({
  regionId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  reason: z.string().trim().min(1).max(2_000),
  enabled: z.boolean(),
  confidence: z.number().finite().min(0).max(1).optional(),
}).strict()).max(200);

type ParsedRebindDocument =
  | { kind: 'annotations'; document: AnnotationDocument }
  | { kind: 'proposal'; document: z.infer<typeof proposalDocumentSchema> };

/**
 * Bind a portable annotations/proposal document to an already imported local
 * project after matching the normalized base PNG bytes. No document path or
 * URI is read. The result is always a new draft with no confirmation.
 */
export async function rebindDocument(
  store: Store,
  proposals: ProposalStore,
  value: unknown,
  targetProjectId: string,
): Promise<RebindResult> {
  const parsed = parseDocument(value);
  const source: RebindSource = parsed.kind === 'annotations'
    ? { projectId: parsed.document.projectId, baseVersionId: parsed.document.baseVersionId, revision: parsed.document.revision }
    : {
      projectId: parsed.document.projectId,
      baseVersionId: parsed.document.proposal.baseVersionId,
      revision: parsed.document.proposal.projectRevision,
    };

  const target = await store.getProject(targetProjectId);
  const targetBase = target.versions.find(version => version.id === target.baseVersionId);
  if (!targetBase) throw new StoreError('CORRUPT_PROJECT', '目标项目缺少当前基准版本', 500);
  const targetBytes = await store.readAsset(targetProjectId, targetBase.asset);
  const targetHash = createHash('sha256').update(targetBytes).digest('hex');
  const image = parsed.document.image;
  if (image.sha256 !== targetHash
    || image.width !== target.width
    || image.height !== target.height
    || image.colourSpace !== 'srgb'
    || image.coordinates !== 'original-pixels') {
    throw new StoreError('IMAGE_MISMATCH', '外部 JSON 的规范基准图像哈希、尺寸或坐标系统与目标项目不匹配', 409);
  }

  let title: string;
  let goal: string;
  let backend: ImageBackend;
  let regions: Region[];
  let suggestions: ProposalInput['suggestions'];
  if (parsed.kind === 'annotations') {
    regions = validateRegionList(parsed.document.regions, target.width, target.height);
    const edits = regions.filter(region => region.kind === 'edit');
    if (edits.length === 0) throw new StoreError('NO_EDIT_REGIONS', '标注 JSON 中没有 edit 区域，无法创建重绑定草稿');
    title = '从外部标注 JSON 绑定';
    goal = '审阅并处理从外部标注 JSON 绑定的编辑区域。';
    backend = 'qwen';
    suggestions = edits.map(region => ({ regionId: region.id, reason: '从外部标注 JSON 绑定', enabled: true }));
  } else {
    regions = validateRegionList(parsed.document.proposal.regions, target.width, target.height);
    if (!regions.some(region => region.kind === 'edit')) throw new StoreError('NO_EDIT_REGIONS', '提议 JSON 中没有 edit 区域，无法创建重绑定草稿');
    title = parsed.document.proposal.title;
    goal = parsed.document.proposal.goal;
    backend = parsed.document.proposal.backend;
    suggestions = parsed.document.proposal.suggestions as ProposalInput['suggestions'];
  }

  // A source ID can collide with a target manual edit or keep. Remap only
  // collisions so a later confirmation cannot silently replace target work.
  const occupied = new Set(target.regions.map(region => region.id));
  const remapped = remapCollisions(regions, occupied);
  regions = remapped.regions;
  suggestions = suggestions.map(suggestion => ({
    ...suggestion,
    regionId: remapped.ids.get(suggestion.regionId) ?? suggestion.regionId,
  }));

  const proposal = await proposals.create(targetProjectId, {
    title,
    goal,
    backend,
    source: 'agent',
    baseVersionId: target.baseVersionId,
    projectRevision: target.revision,
    regions,
    suggestions,
  });

  return {
    proposal,
    source,
    target: { projectId: target.id, baseVersionId: target.baseVersionId, revision: target.revision },
    imageMatched: true,
  };
}

function parseDocument(value: unknown): ParsedRebindDocument {
  const annotation = annotationDocumentSchema.safeParse(value);
  if (annotation.success) {
    const document = annotation.data as AnnotationDocument;
    validateRegionList(document.regions, document.image.width, document.image.height);
    return { kind: 'annotations', document };
  }
  const proposal = proposalDocumentSchema.safeParse(value);
  if (proposal.success) {
    if (proposal.data.projectId !== proposal.data.proposal.projectId) {
      throw new StoreError('INVALID_PROPOSAL_DOCUMENT', '提议 JSON 的外层与内层项目 ID 不一致');
    }
    validateRegionList(proposal.data.proposal.regions, proposal.data.image.width, proposal.data.image.height);
    const suggestions = proposalSuggestionsSchema.safeParse(proposal.data.proposal.suggestions);
    if (!suggestions.success) throw new StoreError('INVALID_PROPOSAL_DOCUMENT', '提议 JSON 的建议字段格式无效');
    const edits = new Set(proposal.data.proposal.regions
      .filter((region): region is Region => typeof region === 'object' && region !== null && 'kind' in region && region.kind === 'edit')
      .map(region => region.id));
    if (new Set(suggestions.data.map(item => item.regionId)).size !== suggestions.data.length
      || suggestions.data.length !== edits.size
      || suggestions.data.some(item => !edits.has(item.regionId))) {
      throw new StoreError('INVALID_PROPOSAL_DOCUMENT', '提议 JSON 必须为每个 edit 区域提供且仅提供一条建议');
    }
    return { kind: 'proposal', document: proposal.data };
  }
  throw new StoreError('INVALID_REBIND_DOCUMENT', '只接受有效的 maskcanvas.annotations 或 maskcanvas.proposal v1 JSON');
}

function remapCollisions(regions: Region[], occupied: Set<string>): { regions: Region[]; ids: Map<string, string> } {
  const ids = new Map<string, string>();
  const output = regions.map(region => {
    if (!occupied.has(region.id)) {
      occupied.add(region.id);
      return region;
    }
    let id: string;
    do { id = `rebind-${randomUUID()}`; } while (occupied.has(id));
    occupied.add(id);
    ids.set(region.id, id);
    return { ...region, id };
  });
  return { regions: output, ids };
}
