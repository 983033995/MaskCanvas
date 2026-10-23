import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AnnotationDocument, EditProposal } from '../packages/shared/types.js';
import { annotationDocumentSchema, exportAnnotations } from './annotations.js';
import { ProposalStore } from './proposals.js';
import { Store, StoreError } from './store.js';

export interface ProposalDocument {
  format: 'maskcanvas.proposal';
  schemaVersion: 1;
  projectId: string;
  image: AnnotationDocument['image'];
  proposal: EditProposal;
}

const documentSchema = z.object({
  format: z.literal('maskcanvas.proposal'),
  schemaVersion: z.literal(1),
  projectId: z.string().uuid(),
  image: annotationDocumentSchema.shape.image,
  proposal: z.object({
    id: z.string().uuid(), projectId: z.string().uuid(),
    title: z.string(), goal: z.string(), backend: z.enum(['qwen', 'gpt']),
    source: z.enum(['agent', 'human']), baseVersionId: z.string(),
    projectRevision: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
    status: z.enum(['draft', 'confirmed', 'stale', 'cancelled']),
    regions: z.array(z.unknown()).max(200), suggestions: z.array(z.unknown()).max(200),
    createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
    // Exported confirmation is informational. It never grants permission on import.
    confirmation: z.unknown().optional(),
  }).strict(),
}).strict();

export async function exportProposalDocument(store: Store, proposals: ProposalStore, projectId: string, proposalId: string): Promise<ProposalDocument> {
  const proposal = await proposals.get(projectId, proposalId);
  const project = await store.getProject(projectId);
  const base = project.versions.find(item => item.id === proposal.baseVersionId);
  if (!base) throw new StoreError('STALE_BASE', '建议对应的照片基准不存在', 409);
  const image = await store.readAsset(projectId, base.asset);
  return {
    format: 'maskcanvas.proposal', schemaVersion: 1, projectId,
    image: {
      assetUri: `maskcanvas://projects/${projectId}/assets/${base.asset}`,
      sha256: createHash('sha256').update(image).digest('hex'),
      width: project.width, height: project.height, colourSpace: 'srgb', coordinates: 'original-pixels',
    },
    proposal,
  };
}

export async function importProposalDocument(store: Store, proposals: ProposalStore, projectId: string, value: unknown): Promise<EditProposal> {
  const parsed = documentSchema.safeParse(value);
  if (!parsed.success) throw new StoreError('INVALID_PROPOSAL_DOCUMENT', '不是有效的 MaskCanvas 计划 JSON');
  const document = parsed.data;
  if (document.projectId !== projectId || document.proposal.projectId !== projectId) throw new StoreError('PROJECT_MISMATCH', '计划 JSON 属于另一项目', 409);
  const current = await exportAnnotations(store, projectId);
  for (const key of ['assetUri', 'sha256', 'width', 'height', 'colourSpace', 'coordinates'] as const) {
    if (document.image[key] !== current.image[key]) throw new StoreError('IMAGE_MISMATCH', '计划 JSON 的图片基准或坐标系统与当前照片不一致', 409);
  }
  const { title, goal, backend, source, baseVersionId, projectRevision, regions, suggestions } = document.proposal;
  // No status/id/confirmation is forwarded. Imported JSON always creates a new
  // draft; ProposalStore supplies the final geometric and revision checks.
  return proposals.create(projectId, { title, goal, backend, source, baseVersionId, projectRevision, regions, suggestions });
}
