import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AnnotationDocument, Region } from '../packages/shared/types.js';
import { Store, StoreError } from './store.js';

export const annotationDocumentSchema = z.object({
  format: z.literal('maskcanvas.annotations'),
  schemaVersion: z.literal(1),
  projectId: z.string().uuid(),
  baseVersionId: z.string().min(1).max(100),
  revision: z.number().int().nonnegative(),
  image: z.object({
    assetUri: z.string().max(300),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    colourSpace: z.literal('srgb'),
    coordinates: z.literal('original-pixels'),
  }).strict(),
  regions: z.array(z.unknown()).max(200),
}).strict();

export async function exportAnnotations(store: Store, id: string): Promise<AnnotationDocument> {
  const project = await store.getProject(id);
  const base = project.versions.find(version => version.id === project.baseVersionId)!;
  const image = await store.readAsset(id, base.asset);
  return {
    format: 'maskcanvas.annotations', schemaVersion: 1,
    projectId: id, baseVersionId: project.baseVersionId, revision: project.revision,
    image: {
      assetUri: `maskcanvas://projects/${id}/assets/${base.asset}`,
      sha256: createHash('sha256').update(image).digest('hex'),
      width: project.width, height: project.height, colourSpace: 'srgb', coordinates: 'original-pixels',
    },
    regions: project.regions,
  };
}

export async function importAnnotations(store: Store, id: string, document: unknown) {
  const parsed = annotationDocumentSchema.safeParse(document);
  if (!parsed.success) throw new StoreError('INVALID_ANNOTATIONS', '不是有效的 MaskCanvas 标注 JSON，或 schema 版本不支持');
  const input = parsed.data;
  if (input.projectId !== id) throw new StoreError('PROJECT_MISMATCH', 'JSON 属于另一项目；请先打开对应项目，不自动替换照片', 409);
  const current = await exportAnnotations(store, id);
  if (input.revision !== current.revision || input.baseVersionId !== current.baseVersionId) {
    throw new StoreError('REVISION_CONFLICT', '照片基准或标注已更新，请先读取最新 JSON 再合并，不覆盖当前修改', 409);
  }
  for (const key of ['assetUri', 'sha256', 'width', 'height', 'colourSpace', 'coordinates'] as const) {
    if (input.image[key] !== current.image[key]) throw new StoreError('IMAGE_MISMATCH', 'JSON 的图片引用、哈希或坐标系统与当前照片不一致', 409);
  }
  // saveRegions supplies the shared, full geometric validation and an atomic
  // revision check. JSON import only changes annotations; it never executes edits.
  return store.saveRegions(id, { revision: input.revision, regions: input.regions as Region[] });
}
