import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import sharp from 'sharp';
import * as archiver from 'archiver';
import yauzl from 'yauzl';
import { z } from 'zod';
import type { Point, Project, ProjectSummary, Region, RegionContext, Shape, Validation, Version } from '../packages/shared/types.js';

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const MAX_REGIONS = 200;
const MAX_SHAPES_PER_REGION = 200;
const MAX_TOTAL_SHAPES = 5_000;
const MAX_POINTS_PER_SHAPE = 10_000;
const MAX_TOTAL_POINTS = 50_000;
const MAX_FEATHER = 512;
const MAX_PACKAGE_BYTES = 200 * 1024 * 1024;
const MAX_PACKAGE_EXPANDED_BYTES = 750 * 1024 * 1024;
const MAX_PACKAGE_ENTRIES = 2_500;

export class StoreError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = 'StoreError';
  }
}

const finiteNonnegative = z.number().finite().nonnegative();
const pointSchema = z.object({ x: finiteNonnegative, y: finiteNonnegative }).strict();
const regionContextSchema: z.ZodType<RegionContext> = z.object({
  x: finiteNonnegative,
  y: finiteNonnegative,
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
}).strict();
const shapeSchema: z.ZodType<Shape> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rect'), x: finiteNonnegative, y: finiteNonnegative, width: z.number().finite().positive(), height: z.number().finite().positive(), subtract: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('brush'), points: z.array(pointSchema).min(1).max(MAX_POINTS_PER_SHAPE), radius: z.number().finite().positive(), subtract: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('polygon'), points: z.array(pointSchema).min(3).max(MAX_POINTS_PER_SHAPE), subtract: z.boolean().optional() }).strict(),
]);
const regionSchema: z.ZodType<Region> = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['edit', 'keep']),
  intent: z.string().max(4_000),
  feather: z.number().finite().min(0).max(MAX_FEATHER),
  shapes: z.array(shapeSchema).max(MAX_SHAPES_PER_REGION),
  context: regionContextSchema.optional(),
}).strict();

const versionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  name: z.string().min(1).max(160),
  asset: z.string().regex(/^[A-Za-z0-9_-]{1,110}\.png$/),
  status: z.enum(['source', 'candidate', 'accepted', 'rejected']),
  createdAt: z.string().datetime(),
  baseVersionId: z.string().optional(),
  annotationRevision: z.number().int().nonnegative().optional(),
  regionId: z.string().optional(),
  regionIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)).min(1).max(MAX_REGIONS).optional(),
  stale: z.boolean().optional(),
  validation: z.object({
    protectedChangedPixels: z.number().int().nonnegative(),
    outsideEditChangedPixels: z.number().int().nonnegative(),
    changedPixels: z.number().int().nonnegative(),
    maxChannelDelta: z.number().int().min(0).max(255),
    passed: z.boolean(),
  }).strict().optional(),
}).strict();

const projectSchema: z.ZodType<Project> = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  width: z.number().int().positive().max(MAX_PIXELS),
  height: z.number().int().positive().max(MAX_PIXELS),
  revision: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  baseVersionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  regions: z.array(regionSchema).max(MAX_REGIONS),
  versions: z.array(versionSchema).min(1).max(1_000),
}).strict().superRefine((project, context) => {
  if (project.width * project.height > MAX_PIXELS) context.addIssue({ code: 'custom', message: '图像超过 40MP 上限' });
  if (new Set(project.regions.map((region) => region.id)).size !== project.regions.length) context.addIssue({ code: 'custom', message: '区域 ID 不能重复' });
  if (new Set(project.versions.map((version) => version.id)).size !== project.versions.length) context.addIssue({ code: 'custom', message: '版本 ID 不能重复' });
  if (new Set(project.versions.map((version) => version.asset)).size !== project.versions.length) context.addIssue({ code: 'custom', message: '版本资产不能重复' });
  if (project.versions.some((version) => version.regionIds && new Set(version.regionIds).size !== version.regionIds.length)) context.addIssue({ code: 'custom', message: '候选区域 ID 不能重复' });
  if (!project.versions.some((version) => version.id === project.baseVersionId)) context.addIssue({ code: 'custom', message: '基准版本不存在' });
  if (!project.versions.some((version) => version.status === 'source')) context.addIssue({ code: 'custom', message: '缺少原始版本' });
});

interface PackageFile { path: string; bytes: number; sha256: string }
interface PackageManifest { format: 'maskcanvas-package'; schemaVersion: 1; projectId: string; files: PackageFile[] }
interface ParsedImage { original: Buffer; normalizedPng: Buffer; raw: Buffer; width: number; height: number; extension: 'jpg' | 'png' }
export interface CreateProjectInput { name: string; imageDataUrl: string }
export interface CandidateInput { revision: number; baseVersionId: string; regionId: string; regionIds?: string[]; imageDataUrl: string; name?: string }
export interface RevisionInput { revision: number; regions: Region[] }
export interface AcceptInput { revision: number; versionId: string }
export interface RejectInput { revision: number; versionId: string }
export interface StoreOptions { dataDir?: string }

export class Store {
  readonly dataDir: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(options: StoreOptions = {}) {
    this.dataDir = path.resolve(options.dataDir ?? process.env.MASKCANVAS_DATA_DIR ?? path.join(process.cwd(), 'projects'));
  }

  async listProjects(): Promise<ProjectSummary[]> {
    await mkdir(this.dataDir, { recursive: true });
    const entries = await readdir(this.dataDir, { withFileTypes: true });
    const summaries: ProjectSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isProjectId(entry.name)) continue;
      const project = await this.getProject(entry.name);
      const baseVersion = project.versions.find((version) => version.id === project.baseVersionId);
      if (!baseVersion) throw new StoreError('CORRUPT_PROJECT', `项目 ${entry.name} 缺少基准版本`, 500);
      summaries.push({
        id: project.id,
        name: project.name,
        width: project.width,
        height: project.height,
        revision: project.revision,
        updatedAt: project.updatedAt,
        baseAsset: baseVersion.asset,
        versionCount: project.versions.length,
        regionCount: project.regions.length,
      });
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    const image = await parseImageDataUrl(input.imageDataUrl);
    const name = validateProjectName(input.name);
    const id = randomUUID();
    const now = new Date().toISOString();
    const sourceId = `source-${randomUUID()}`;
    const project: Project = {
      schemaVersion: 1,
      id,
      name,
      width: image.width,
      height: image.height,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      baseVersionId: sourceId,
      regions: [],
      versions: [{ id: sourceId, name: '原始图', asset: `${sourceId}.png`, status: 'source', createdAt: now }],
    };
    const projectDir = this.projectDir(id);
    const stagingDir = path.join(this.dataDir, `.tmp-${id}`);
    await mkdir(path.join(stagingDir, 'assets'), { recursive: true });
    try {
      await writeFile(path.join(stagingDir, `original.${image.extension}`), image.original, { flag: 'wx' });
      await writeFile(path.join(stagingDir, 'assets', `${sourceId}.png`), image.normalizedPng, { flag: 'wx' });
      await writeFile(path.join(stagingDir, 'project.json'), JSON.stringify(project, null, 2), { flag: 'wx' });
      await mkdir(this.dataDir, { recursive: true });
      await rename(stagingDir, projectDir);
      return project;
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true });
      throw error;
    }
  }

  async getProject(id: string): Promise<Project> {
    this.assertProjectId(id);
    let raw: string;
    try {
      raw = await readFile(path.join(this.projectDir(id), 'project.json'), 'utf8');
    } catch (error) {
      if (isCode(error, 'ENOENT')) throw new StoreError('PROJECT_NOT_FOUND', '项目不存在', 404);
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new StoreError('CORRUPT_PROJECT', '项目文件不是有效 JSON', 500); }
    const result = projectSchema.safeParse(parsed);
    if (!result.success || result.data.id !== id) throw new StoreError('CORRUPT_PROJECT', '项目数据无效', 500);
    return result.data;
  }

  async saveRegions(id: string, input: RevisionInput): Promise<Project> {
    return this.withProjectLock(id, async () => {
      const project = await this.getProject(id);
      this.assertRevision(project, input.revision);
      if (!Array.isArray(input.regions) || input.regions.length > MAX_REGIONS) throw new StoreError('INVALID_REGIONS', '区域数量超出限制');
      const parsed = z.array(regionSchema).max(MAX_REGIONS).safeParse(input.regions);
      if (!parsed.success) throw new StoreError('INVALID_REGIONS', '区域格式无效');
      validateRegions(parsed.data, project.width, project.height);
      const next: Project = { ...project, regions: parsed.data, revision: project.revision + 1, updatedAt: new Date().toISOString() };
      await this.writeProject(next);
      return next;
    });
  }

  async importCandidate(id: string, input: CandidateInput, options: { allowStale?: boolean; snapshotRegions?: Region[]; candidateId?: string; precomposited?: boolean; stale?: boolean } = {}): Promise<Project> {
    return this.withProjectLock(id, async () => {
      const project = await this.getProject(id);
      if (!Number.isInteger(input.revision) || input.revision < 0) throw new StoreError('INVALID_REVISION', 'revision 必须是非负整数');
      if (options.candidateId !== undefined) {
        if (!/^candidate-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.candidateId)) {
          throw new StoreError('INVALID_CANDIDATE_ID', '内部候选 ID 格式无效');
        }
        const existing = project.versions.find((version) => version.id === options.candidateId);
        if (existing) {
          if (existing.baseVersionId !== input.baseVersionId || existing.regionId !== input.regionId || existing.annotationRevision !== input.revision || (input.regionIds && JSON.stringify(existing.regionIds) !== JSON.stringify(input.regionIds)) || (options.stale !== undefined && Boolean(existing.stale) !== options.stale)) {
            throw new StoreError('CANDIDATE_ID_CONFLICT', '稳定候选 ID 已关联到不同的基准、区域或修订', 409);
          }
          return project;
        }
      }
      if (options.allowStale) {
        if (!project.versions.some((version) => version.id === input.baseVersionId)) throw new StoreError('STALE_BASE', '候选图基准版本不存在', 409);
      } else {
        this.assertRevision(project, input.revision);
        if (input.baseVersionId !== project.baseVersionId) throw new StoreError('STALE_BASE', '候选图基于过期版本，请先刷新项目', 409);
      }
      const snapshotRegions = options.snapshotRegions ?? project.regions;
      const checkedRegions = z.array(regionSchema).max(MAX_REGIONS).safeParse(snapshotRegions);
      if (!checkedRegions.success) throw new StoreError('INVALID_REGIONS', '冻结区域格式无效');
      validateRegions(checkedRegions.data, project.width, project.height);
      const regionIds = input.regionIds ?? [input.regionId];
      if (!regionIds.length || new Set(regionIds).size !== regionIds.length || !regionIds.includes(input.regionId)) throw new StoreError('REGION_NOT_EDITABLE', '候选图的编辑区域集合无效');
      const targetRegions = regionIds.map((regionId) => checkedRegions.data.find((item) => item.id === regionId));
      if (targetRegions.some((item) => !item || item.kind !== 'edit' || !item.intent.trim())) throw new StoreError('REGION_NOT_EDITABLE', '候选图必须关联有效的编辑区域');
      const region = targetRegions[0]!;
      const baseVersion = project.versions.find((version) => version.id === input.baseVersionId);
      if (!baseVersion) throw new StoreError('CORRUPT_PROJECT', '基准版本不存在', 500);
      const candidate = await parseImageDataUrl(input.imageDataUrl);
      if (candidate.width !== project.width || candidate.height !== project.height) {
        throw new StoreError('IMAGE_DIMENSIONS_MISMATCH', `候选图必须是 ${project.width}×${project.height}，收到 ${candidate.width}×${candidate.height}`);
      }
      const basePath = this.assetPath(id, baseVersion.asset);
      const base = await readRawPng(basePath, project.width, project.height);
      const maskSets = await this.buildMaskSets(project, regionIds, checkedRegions.data);
      const targetMask = maskSets.target;
      if (!targetMask) throw new StoreError('CORRUPT_PROJECT', '编辑区域蒙版不存在', 500);
      let result: Buffer;
      if (options.precomposited) {
        result = candidate.raw;
      } else {
        const alpha = input.regionIds
          ? await this.featheredRegionUnion(project, checkedRegions.data, regionIds)
          : await featheredAlpha(targetMask, region.feather, project.width, project.height);
        for (let i = 0; i < alpha.length; i++) if (maskSets.keep[i]) alpha[i] = 0;
        result = Buffer.allocUnsafe(base.data.length);
        for (let pixel = 0; pixel < project.width * project.height; pixel++) {
          const offset = pixel * 4;
          const a = alpha[pixel] / 255;
          for (let channel = 0; channel < 3; channel++) {
            result[offset + channel] = Math.round(base.data[offset + channel] * (1 - a) + candidate.raw[offset + channel] * a);
          }
          result[offset + 3] = base.data[offset + 3];
        }
      }
      const versionId = options.candidateId ?? `candidate-${randomUUID()}`;
      const validation = calculateValidation(base.data, result, targetMask, maskSets.keep, project.width * project.height);
      const asset = `${versionId}.png`;
      const now = new Date().toISOString();
      const version: Version = {
        id: versionId,
        name: validateVersionName(input.name ?? `候选 ${project.versions.filter((item) => item.status === 'candidate').length + 1}`),
        asset,
        status: 'candidate',
        createdAt: now,
        baseVersionId: input.baseVersionId,
        annotationRevision: input.revision,
        regionId: region.id,
        ...(input.regionIds ? { regionIds: [...input.regionIds] } : {}),
        ...(options.stale ? { stale: true } : {}),
        validation,
      };
      const resultPng = await sharp(result, { raw: { width: project.width, height: project.height, channels: 4 } }).png().toBuffer();
      await atomicWrite(this.assetPath(id, asset), resultPng);
      const next: Project = { ...project, updatedAt: now, versions: [...project.versions, version] };
      try { await this.writeProject(next); }
      catch (error) { await rm(this.assetPath(id, asset), { force: true }); throw error; }
      return next;
    });
  }

  async accept(id: string, input: AcceptInput): Promise<Project> {
    return this.withProjectLock(id, async () => {
      const project = await this.getProject(id);
      this.assertRevision(project, input.revision);
      const candidate = project.versions.find((version) => version.id === input.versionId);
      if (!candidate || candidate.status !== 'candidate') throw new StoreError('CANDIDATE_NOT_FOUND', '候选版本不存在', 404);
      if (candidate.stale) throw new StoreError('STALE_CANDIDATE', '计划确认已失效；该候选仅供查看，不能接受', 409);
      if (candidate.baseVersionId !== project.baseVersionId || candidate.annotationRevision !== project.revision) {
        throw new StoreError('STALE_CANDIDATE', '候选图基准或标注已变化，不能接受此版本', 409);
      }
      const regionIds = candidate.regionIds ?? (candidate.regionId ? [candidate.regionId] : []);
      if (!candidate.regionId || !regionIds.includes(candidate.regionId) || new Set(regionIds).size !== regionIds.length) throw new StoreError('VALIDATION_FAILED', '候选图关联的编辑区域集合无效', 409);
      const regions = regionIds.map((regionId) => project.regions.find((item) => item.id === regionId && item.kind === 'edit'));
      if (regions.some((item) => !item)) throw new StoreError('VALIDATION_FAILED', '候选图关联的当前编辑区域不存在', 409);
      const baseVersion = project.versions.find((version) => version.id === project.baseVersionId);
      if (!baseVersion) throw new StoreError('CORRUPT_PROJECT', '基准版本不存在', 500);
      const base = await readRawPng(this.assetPath(id, baseVersion.asset), project.width, project.height);
      const candidateImage = await readRawPng(this.assetPath(id, candidate.asset), project.width, project.height);
      const masks = await this.buildMaskSets(project, regionIds, project.regions);
      if (!masks.target) throw new StoreError('VALIDATION_FAILED', '候选图的编辑区域蒙版为空', 409);
      const validation = calculateValidation(base.data, candidateImage.data, masks.target, masks.keep, project.width * project.height);
      const now = new Date().toISOString();
      if (!validation.passed) {
        const rejectedAcceptance: Project = {
          ...project,
          updatedAt: now,
          versions: project.versions.map((version) => version.id === candidate.id ? { ...version, validation } : version),
        };
        await this.writeProject(rejectedAcceptance);
        throw new StoreError('VALIDATION_FAILED', '候选图超出目标编辑区域或改动了保护区', 409);
      }
      const next: Project = {
        ...project,
        baseVersionId: candidate.id,
        revision: project.revision + 1,
        updatedAt: now,
        versions: project.versions.map((version) => version.id === candidate.id
          ? { ...version, status: 'accepted', validation }
          : version),
      };
      await this.writeProject(next);
      return next;
    });
  }

  assetPath(id: string, asset: string): string {
    this.assertProjectId(id);
    if (!/^[A-Za-z0-9_-]{1,110}\.png$/.test(asset)) throw new StoreError('INVALID_ASSET', '资产名称无效');
    return path.join(this.projectDir(id), 'assets', asset);
  }

  async reject(id: string, input: RejectInput): Promise<Project> {
    return this.withProjectLock(id, async () => {
      const project = await this.getProject(id);
      this.assertRevision(project, input.revision);
      const candidate = project.versions.find(version => version.id === input.versionId);
      if (!candidate) throw new StoreError('CANDIDATE_NOT_FOUND', '候选版本不存在', 404);
      if (candidate.status === 'rejected') return project;
      if (candidate.status !== 'candidate') throw new StoreError('CANDIDATE_NOT_REJECTABLE', '只能拒绝尚未接受的候选版本', 409);
      const next: Project = {
        ...project,
        updatedAt: new Date().toISOString(),
        // Rejecting a candidate changes only its history state. It does not
        // touch the base pointer, annotations, or authorization revision.
        versions: project.versions.map(version => version.id === candidate.id ? { ...version, status: 'rejected' } : version),
      };
      await this.writeProject(next);
      return next;
    });
  }

  async readAsset(id: string, asset: string): Promise<Buffer> {
    const project = await this.getProject(id);
    if (!project.versions.some((version) => version.asset === asset)) throw new StoreError('ASSET_NOT_FOUND', '资产不存在', 404);
    try { return await readFile(this.assetPath(id, asset)); }
    catch (error) { if (isCode(error, 'ENOENT')) throw new StoreError('ASSET_NOT_FOUND', '资产不存在', 404); throw error; }
  }

  async getMask(id: string, regionId: string): Promise<Buffer> {
    const project = await this.getProject(id);
    const region = project.regions.find((item) => item.id === regionId);
    if (!region) throw new StoreError('REGION_NOT_FOUND', '区域不存在', 404);
    const mask = await rasterizeRegion(region, project.width, project.height);
    return sharp(mask, { raw: { width: project.width, height: project.height, channels: 1 } }).png().toBuffer();
  }

  async exportAccepted(id: string): Promise<Buffer> {
    const project = await this.getProject(id);
    const base = project.versions.find((version) => version.id === project.baseVersionId);
    if (!base) throw new StoreError('CORRUPT_PROJECT', '基准版本不存在', 500);
    return this.readAsset(id, base.asset);
  }

  async exportPackage(id: string): Promise<Buffer> {
    const project = await this.getProject(id);
    const projectJson = Buffer.from(JSON.stringify(project, null, 2));
    const entries: Array<{ path: string; source: Buffer | string; bytes: number; sha256: string }> = [];
    entries.push(await packageFile('project.json', projectJson));
    const dir = this.projectDir(id);
    const originals = await readdir(dir);
    const originalName = originals.find((item) => /^original\.(?:jpg|png)$/.test(item));
    if (!originalName) throw new StoreError('CORRUPT_PROJECT', '项目缺少原始文件', 500);
    const originalPath = path.join(dir, originalName);
    entries.push(await packageFile(`assets/${originalName}`, originalPath));
    for (const version of project.versions) {
      const source = this.assetPath(id, version.asset);
      entries.push(await packageFile(`assets/${version.asset}`, source));
    }
    for (const region of project.regions) {
      const mask = await rasterizeRegion(region, project.width, project.height);
      const png = await sharp(mask, { raw: { width: project.width, height: project.height, channels: 1 } }).png().toBuffer();
      entries.push(await packageFile(`masks/${region.id}.png`, png));
    }
    const manifest: PackageManifest = { format: 'maskcanvas-package', schemaVersion: 1, projectId: project.id, files: entries.map(({ path: filePath, bytes, sha256 }) => ({ path: filePath, bytes, sha256 })) };
    const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2));
    return zipEntries([...entries, { path: 'manifest.json', source: manifestBuffer, bytes: manifestBuffer.length, sha256: sha256(manifestBuffer) }]);
  }

  async importPackage(dataBase64: string): Promise<Project> {
    const zipBuffer = decodeBase64(dataBase64, '导入包', MAX_PACKAGE_BYTES);
    const extracted = await extractPackage(zipBuffer);
    const manifestBytes = extracted.get('manifest.json');
    const projectBytes = extracted.get('project.json');
    if (!manifestBytes || !projectBytes) throw new StoreError('INVALID_PACKAGE', '包缺少 manifest.json 或 project.json');
    const manifest = parseManifest(manifestBytes);
    const fileMap = new Map(manifest.files.map((file) => [file.path, file]));
    if (fileMap.size !== manifest.files.length || fileMap.size !== extracted.size - 1) throw new StoreError('INVALID_PACKAGE', '包内文件清单重复或不完整');
    for (const [filePath, file] of fileMap) {
      const bytes = extracted.get(filePath);
      if (!bytes || bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new StoreError('PACKAGE_HASH_MISMATCH', `文件校验失败：${filePath}`);
      if (!isAllowedPackagePath(filePath)) throw new StoreError('INVALID_PACKAGE', `包内路径不允许：${filePath}`);
    }
    const projectFile = fileMap.get('project.json');
    if (!projectFile) throw new StoreError('INVALID_PACKAGE', 'manifest 未登记项目文件');
    let rawProject: unknown;
    try { rawProject = JSON.parse(projectBytes.toString('utf8')); } catch { throw new StoreError('INVALID_PACKAGE', 'project.json 无效'); }
    const parsedProject = projectSchema.safeParse(rawProject);
    if (!parsedProject.success || parsedProject.data.id !== manifest.projectId) throw new StoreError('INVALID_PACKAGE', '项目数据或 ID 与 manifest 不匹配');
    const sourceProject = parsedProject.data;
    validateRegions(sourceProject.regions, sourceProject.width, sourceProject.height);
    const originalPath = [...fileMap.keys()].find((item) => /^assets\/original\.(?:jpg|png)$/.test(item));
    if (!originalPath) throw new StoreError('INVALID_PACKAGE', '包缺少原始文件');
    const original = extracted.get(originalPath)!;
    if (original.length > MAX_IMAGE_BYTES) throw new StoreError('INVALID_PACKAGE', '原始图超过 50MB');
    const ext = originalPath.endsWith('.jpg') ? 'jpg' : 'png';
    const parsedOriginal = await parseImageBytes(original, ext === 'jpg' ? 'image/jpeg' : 'image/png');
    if (parsedOriginal.width !== sourceProject.width || parsedOriginal.height !== sourceProject.height) throw new StoreError('INVALID_PACKAGE', '原始图尺寸与项目不匹配');
    const expectedPaths = new Set(['project.json', originalPath]);
    for (const version of sourceProject.versions) {
      const filePath = `assets/${version.asset}`;
      const versionBytes = extracted.get(filePath);
      if (!versionBytes) throw new StoreError('INVALID_PACKAGE', `缺少版本资产：${version.asset}`);
      expectedPaths.add(filePath);
      await validateVersionPng(versionBytes, sourceProject.width, sourceProject.height);
    }
    for (const region of sourceProject.regions) {
      const filePath = `masks/${region.id}.png`;
      const maskPng = extracted.get(filePath);
      if (!maskPng) throw new StoreError('INVALID_PACKAGE', `缺少区域蒙版：${region.id}`);
      expectedPaths.add(filePath);
      await validatePackageMask(maskPng, region, sourceProject.width, sourceProject.height);
    }
    if (expectedPaths.size !== fileMap.size || [...fileMap.keys()].some((item) => !expectedPaths.has(item))) throw new StoreError('INVALID_PACKAGE', '包包含未声明用途的文件');

    const importedBaseVersion = sourceProject.versions.find((version) => version.id === sourceProject.baseVersionId);
    if (!importedBaseVersion) throw new StoreError('INVALID_PACKAGE', '项目基准版本不存在');
    const importedBaseBytes = extracted.get(`assets/${importedBaseVersion.asset}`);
    if (!importedBaseBytes) throw new StoreError('INVALID_PACKAGE', '项目基准图不存在');
    let importedBaseRaw: Buffer | undefined;
    const maskCache = new Map<string, { target?: Buffer; edit: Buffer; keep: Buffer }>();
    const importedVersions: Version[] = [];
    for (const version of sourceProject.versions) {
      const currentCandidate = version.status === 'candidate'
        && version.baseVersionId === sourceProject.baseVersionId
        && version.annotationRevision === sourceProject.revision;
      const region = currentCandidate ? sourceProject.regions.find((item) => item.id === version.regionId && item.kind === 'edit') : undefined;
      if (!currentCandidate || !region) {
        importedVersions.push(withoutValidation(version));
        continue;
      }
      const candidateBytes = extracted.get(`assets/${version.asset}`);
      if (!candidateBytes) throw new StoreError('INVALID_PACKAGE', `缺少候选图：${version.asset}`);
      try {
        importedBaseRaw ??= (await decodeRawPng(importedBaseBytes, sourceProject.width, sourceProject.height)).data;
        let masks = maskCache.get(region.id);
        if (!masks) {
          masks = await this.buildMaskSets(sourceProject, region.id, sourceProject.regions);
          maskCache.set(region.id, masks);
        }
        if (!masks.target) {
          importedVersions.push(withoutValidation(version));
          continue;
        }
        const candidateRaw = await decodeRawPng(candidateBytes, sourceProject.width, sourceProject.height);
        const validation = calculateValidation(importedBaseRaw, candidateRaw.data, masks.target, masks.keep, sourceProject.width * sourceProject.height);
        importedVersions.push({ ...version, validation });
      } catch {
        throw new StoreError('INVALID_PACKAGE', `候选图无法重新验收：${version.id}`);
      }
    }

    const id = randomUUID();
    const project: Project = { ...sourceProject, id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), versions: importedVersions };
    const stagingDir = path.join(this.dataDir, `.tmp-${id}`);
    await mkdir(path.join(stagingDir, 'assets'), { recursive: true });
    try {
      await writeFile(path.join(stagingDir, originalPath.slice('assets/'.length)), original, { flag: 'wx' });
      for (const version of project.versions) await writeFile(path.join(stagingDir, 'assets', version.asset), extracted.get(`assets/${version.asset}`)!, { flag: 'wx' });
      await writeFile(path.join(stagingDir, 'project.json'), JSON.stringify(project, null, 2), { flag: 'wx' });
      await mkdir(this.dataDir, { recursive: true });
      await rename(stagingDir, this.projectDir(id));
      return project;
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true });
      throw error;
    }
  }

  private projectDir(id: string): string { this.assertProjectId(id); return path.join(this.dataDir, id); }
  private assertProjectId(id: string): void { if (!isProjectId(id)) throw new StoreError('INVALID_PROJECT_ID', '项目 ID 无效'); }
  private assertRevision(project: Project, revision: number): void {
    if (!Number.isInteger(revision) || revision < 0) throw new StoreError('INVALID_REVISION', 'revision 必须是非负整数');
    if (revision !== project.revision) throw new StoreError('REVISION_CONFLICT', '项目已被修改，请刷新后重试', 409);
  }
  private async writeProject(project: Project): Promise<void> {
    const parsed = projectSchema.safeParse(project);
    if (!parsed.success) throw new StoreError('INVALID_PROJECT', '项目数据未通过校验', 500);
    await atomicWrite(path.join(this.projectDir(project.id), 'project.json'), Buffer.from(JSON.stringify(project, null, 2)));
  }
  private async withProjectLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.assertProjectId(id);
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.locks.set(id, tail);
    await previous;
    try { return await operation(); }
    finally { release(); if (this.locks.get(id) === tail) this.locks.delete(id); }
  }
  async compositeCandidatePreview(id: string, basePng: Buffer, candidatePng: Buffer, regions: Region[], targetRegionIds: string[]): Promise<Buffer> {
    const project = await this.getProject(id);
    if (!targetRegionIds.length || new Set(targetRegionIds).size !== targetRegionIds.length) throw new StoreError('REGION_NOT_EDITABLE', '候选图的编辑区域集合无效');
    const checkedRegions = validateRegionList(regions, project.width, project.height);
    const targets = targetRegionIds.map((regionId) => checkedRegions.find((region) => region.id === regionId));
    if (targets.some((region) => !region || region.kind !== 'edit' || !region.intent.trim())) throw new StoreError('REGION_NOT_EDITABLE', '候选图必须关联有效的编辑区域');
    let base: { data: Buffer; info: { width: number; height: number } };
    let candidate: { data: Buffer; info: { width: number; height: number } };
    try {
      [base, candidate] = await Promise.all([
        sharp(basePng, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
        sharp(candidatePng, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
      ]);
    } catch { throw new StoreError('INVALID_CANDIDATE', '无法解码临时合成图'); }
    if (base.info.width !== project.width || base.info.height !== project.height || candidate.info.width !== project.width || candidate.info.height !== project.height) {
      throw new StoreError('IMAGE_DIMENSIONS_MISMATCH', '临时合成图尺寸与项目基准不一致');
    }
    const masks = await this.buildMaskSets(project, targetRegionIds, checkedRegions);
    if (!masks.target) throw new StoreError('EMPTY_EDIT', '临时合成区域为空');
    const alpha = await this.featheredRegionUnion(project, checkedRegions, targetRegionIds);
    for (let i = 0; i < alpha.length; i++) if (masks.keep[i]) alpha[i] = 0;
    const result = Buffer.allocUnsafe(base.data.length);
    for (let pixel = 0; pixel < project.width * project.height; pixel++) {
      const offset = pixel * 4;
      const amount = alpha[pixel] / 255;
      for (let channel = 0; channel < 3; channel++) result[offset + channel] = Math.round(base.data[offset + channel] * (1 - amount) + candidate.data[offset + channel] * amount);
      result[offset + 3] = base.data[offset + 3];
    }
    return sharp(result, { raw: { width: project.width, height: project.height, channels: 4 } }).png().toBuffer();
  }

  private async featheredRegionUnion(project: Project, regions: Region[], regionIds: string[]): Promise<Buffer> {
    const alpha = Buffer.alloc(project.width * project.height);
    for (const regionId of regionIds) {
      const region = regions.find((candidate) => candidate.id === regionId && candidate.kind === 'edit');
      if (!region) throw new StoreError('REGION_NOT_EDITABLE', '候选图必须关联有效的编辑区域');
      const masks = await this.buildMaskSets(project, region.id, regions);
      if (!masks.target) throw new StoreError('EMPTY_EDIT', '临时合成区域为空');
      const feathered = await featheredAlpha(masks.target, region.feather, project.width, project.height);
      for (let i = 0; i < alpha.length; i++) if (feathered[i] > alpha[i]) alpha[i] = feathered[i];
    }
    return alpha;
  }

  private async buildMaskSets(project: Project, targetRegionId: string | readonly string[], regions: Region[]): Promise<{ target?: Buffer; edit: Buffer; keep: Buffer }> {
    const pixels = project.width * project.height;
    const edit = Buffer.alloc(pixels);
    const keep = Buffer.alloc(pixels);
    const targetRegionIds = new Set(typeof targetRegionId === 'string' ? [targetRegionId] : targetRegionId);
    let target: Buffer | undefined;
    for (const region of regions) {
      const rendered = await rasterizeRegionCrop(region, project.width, project.height);
      if (!rendered) continue;
      if (targetRegionIds.has(region.id)) {
        target ??= Buffer.alloc(pixels);
        for (let y = 0; y < rendered.height; y++) for (let x = 0; x < rendered.width; x++) {
          const localIndex = y * rendered.width + x;
          if (!rendered.data[localIndex]) continue;
          target[(rendered.top + y) * project.width + rendered.left + x] = 255;
        }
      }
      const combinedMask = region.kind === 'keep' ? keep : edit;
      for (let y = 0; y < rendered.height; y++) for (let x = 0; x < rendered.width; x++) {
        const localIndex = y * rendered.width + x;
        if (!rendered.data[localIndex]) continue;
        combinedMask[(rendered.top + y) * project.width + rendered.left + x] = 255;
      }
    }
    return { target, edit, keep };
  }
}

export function createStore(options: StoreOptions = {}): Store { return new Store(options); }

export async function parseImageDataUrl(dataUrl: string): Promise<ParsedImage> {
  if (typeof dataUrl !== 'string') throw new StoreError('INVALID_IMAGE', '图像必须使用 data URL');
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw new StoreError('INVALID_IMAGE', '仅支持 PNG/JPEG base64 data URL');
  const original = decodeBase64(match[2], '图像', MAX_IMAGE_BYTES);
  return parseImageBytes(original, match[1]);
}

async function parseImageBytes(original: Buffer, mime: string): Promise<ParsedImage> {
  if (original.length === 0 || original.length > MAX_IMAGE_BYTES) throw new StoreError('IMAGE_SIZE_LIMIT', '图像文件必须在 1 字节到 50MB 之间');
  let normalizedPng: Buffer;
  let width: number;
  let height: number;
  try {
    const image = sharp(original, { limitInputPixels: MAX_PIXELS, failOn: 'error' });
    const metadata = await image.metadata();
    const expectedFormat = mime === 'image/jpeg' ? 'jpeg' : 'png';
    if (metadata.format !== expectedFormat) throw new StoreError('INVALID_IMAGE', 'data URL 类型与实际图像格式不一致');
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS) throw new StoreError('IMAGE_PIXEL_LIMIT', '图像超过 40MP 上限');
    const normalized = await sharp(original, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).rotate().toColourspace('srgb').ensureAlpha().png().toBuffer({ resolveWithObject: true });
    normalizedPng = normalized.data;
    width = normalized.info.width;
    height = normalized.info.height;
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError('INVALID_IMAGE', '无法读取或解码图像');
  }
  if (width * height > MAX_PIXELS) throw new StoreError('IMAGE_PIXEL_LIMIT', '图像超过 40MP 上限');
  const raw = await sharp(normalizedPng).raw().toBuffer({ resolveWithObject: true });
  if (raw.info.channels !== 4) throw new StoreError('IMAGE_NORMALIZATION_FAILED', '图像未能归一化为 RGBA8', 500);
  return { original, normalizedPng, raw: raw.data, width, height, extension: mime === 'image/jpeg' ? 'jpg' : 'png' };
}

function validateProjectName(name: string): string {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) throw new StoreError('INVALID_NAME', '项目名称长度必须是 1 到 120 个字符');
  return name.trim();
}
function validateVersionName(name: string): string {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 160) throw new StoreError('INVALID_NAME', '版本名称长度必须是 1 到 160 个字符');
  return name.trim();
}
function validateRegions(regions: Region[], width: number, height: number): void {
  if (new Set(regions.map((region) => region.id)).size !== regions.length) throw new StoreError('INVALID_REGIONS', '区域 ID 不能重复');
  let totalPoints = 0;
  let totalShapes = 0;
  for (const region of regions) {
    if (region.feather > Math.min(MAX_FEATHER, width, height)) throw new StoreError('INVALID_REGIONS', '羽化半径超出图像或系统限制');
    for (const shape of region.shapes) {
      if (++totalShapes > MAX_TOTAL_SHAPES) throw new StoreError('INVALID_REGIONS', '区域总形状数超出限制');
      if (shape.type === 'rect') {
        if (shape.x + shape.width > width || shape.y + shape.height > height) throw new StoreError('INVALID_REGIONS', `区域 ${region.name} 的矩形超出图像边界`);
      } else {
        totalPoints += shape.points.length;
        if (totalPoints > MAX_TOTAL_POINTS) throw new StoreError('INVALID_REGIONS', '区域总点数超出限制');
        for (const point of shape.points) {
          if (!isPointInside(point, width, height)) throw new StoreError('INVALID_REGIONS', `区域 ${region.name} 的坐标超出图像边界`);
        }
        if (shape.type === 'brush' && shape.radius > 4096) {
          throw new StoreError('INVALID_REGIONS', `区域 ${region.name} 的画笔半径超出限制`);
        }
      }
    }
    if (region.context) validateRegionContext(region, width, height);
  }
}

function validateRegionContext(region: Region, width: number, height: number): void {
  const context = region.context!;
  if (region.kind === 'keep') throw new StoreError('INVALID_REGIONS', `保护区域 ${region.name} 不能设置编辑上下文`);
  if (context.x + context.width > width || context.y + context.height > height) {
    throw new StoreError('INVALID_REGIONS', `编辑区域 ${region.name} 的上下文超出图像边界`);
  }
  // Subtractions only remove edit pixels, so they must never enlarge the
  // conservative context requirement. Use the clipped raster bounds of the
  // additive geometry; this also handles brush footprints at image edges.
  const additive = region.shapes.filter(shape => !shape.subtract);
  const bounds = regionBounds({ ...region, shapes: additive }, width, height);
  if (!bounds) return;
  if (context.x > bounds.left || context.y > bounds.top
    || context.x + context.width < bounds.left + bounds.width
    || context.y + context.height < bounds.top + bounds.height) {
    throw new StoreError('INVALID_REGIONS', `编辑区域 ${region.name} 的上下文必须完整包含全部有效编辑像素`);
  }
}

export function validateRegionList(regions: unknown, width: number, height: number): Region[] {
  const parsed = z.array(regionSchema).max(MAX_REGIONS).safeParse(regions);
  if (!parsed.success) throw new StoreError('INVALID_REGIONS', '区域或形状格式无效');
  validateRegions(parsed.data, width, height);
  return parsed.data;
}
function isPointInside(point: Point, width: number, height: number): boolean { return point.x <= width && point.y <= height; }

export interface RegionBounds { left: number; top: number; width: number; height: number }
export interface RasterizedRegion extends RegionBounds { data: Buffer }

export function regionBounds(region: Region, width: number, height: number): RegionBounds | undefined {
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let hasGeometry = false;
  for (const shape of region.shapes) {
    if (shape.type === 'rect') {
      minX = Math.min(minX, shape.x); minY = Math.min(minY, shape.y);
      maxX = Math.max(maxX, shape.x + shape.width); maxY = Math.max(maxY, shape.y + shape.height);
    } else if (shape.type === 'brush') {
      for (const point of shape.points) {
        minX = Math.min(minX, point.x - shape.radius); minY = Math.min(minY, point.y - shape.radius);
        maxX = Math.max(maxX, point.x + shape.radius); maxY = Math.max(maxY, point.y + shape.radius);
      }
    } else {
      for (const point of shape.points) {
        minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
      }
    }
    hasGeometry = true;
  }
  if (!hasGeometry) return undefined;
  const left = Math.max(0, Math.floor(minX));
  const top = Math.max(0, Math.floor(minY));
  const right = Math.min(width, Math.ceil(maxX));
  const bottom = Math.min(height, Math.ceil(maxY));
  if (right <= left || bottom <= top) return undefined;
  return { left, top, width: right - left, height: bottom - top };
}

export async function rasterizeRegionCrop(region: Region, width: number, height: number): Promise<RasterizedRegion | undefined> {
  const bounds = regionBounds(region, width, height);
  if (!bounds) return undefined;
  const { left, top } = bounds;
  const parts: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width}" height="${bounds.height}" viewBox="${left} ${top} ${bounds.width} ${bounds.height}"><rect x="${left}" y="${top}" width="${bounds.width}" height="${bounds.height}" fill="#000"/>`];
  for (const shape of region.shapes) {
    const color = shape.subtract ? '#000' : '#fff';
    if (shape.type === 'rect') {
      parts.push(`<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" fill="${color}"/>`);
    } else if (shape.type === 'polygon') {
      parts.push(`<polygon points="${shape.points.map((point) => `${point.x},${point.y}`).join(' ')}" fill="${color}"/>`);
    } else {
      const line = shape.points.map((point) => `${point.x},${point.y}`).join(' ');
      if (shape.points.length === 1) parts.push(`<circle cx="${shape.points[0].x}" cy="${shape.points[0].y}" r="${shape.radius}" fill="${color}"/>`);
      else parts.push(`<polyline points="${line}" fill="none" stroke="${color}" stroke-width="${shape.radius * 2}" stroke-linecap="round" stroke-linejoin="round"/>`);
    }
  }
  parts.push('</svg>');
  let raster: { data: Buffer; info: { width: number; height: number; channels: number } };
  try { raster = await sharp(Buffer.from(parts.join('')), { limitInputPixels: MAX_PIXELS }).greyscale().raw().toBuffer({ resolveWithObject: true }); }
  catch { throw new StoreError('MASK_RENDER_FAILED', '无法生成区域蒙版'); }
  if (raster.info.width !== bounds.width || raster.info.height !== bounds.height || raster.info.channels !== 1) throw new StoreError('MASK_RENDER_FAILED', '区域蒙版尺寸不匹配', 500);
  for (let i = 0; i < raster.data.length; i++) raster.data[i] = raster.data[i] >= 128 ? 255 : 0;
  return { ...bounds, data: raster.data };
}

export async function rasterizeRegion(region: Region, width: number, height: number): Promise<Buffer> {
  const output = Buffer.alloc(width * height);
  const rendered = await rasterizeRegionCrop(region, width, height);
  if (rendered) blitMask(output, width, rendered);
  return output;
}

function blitMask(target: Buffer, targetWidth: number, source: RasterizedRegion): void {
  for (let y = 0; y < source.height; y++) {
    const start = y * source.width;
    source.data.copy(target, (source.top + y) * targetWidth + source.left, start, start + source.width);
  }
}

async function featheredAlpha(mask: Buffer, feather: number, width: number, height: number): Promise<Buffer> {
  if (feather === 0) return Buffer.from(mask);
  const saturation = (feather + 1) * 10;
  const distance = new Uint16Array(mask.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    if (mask[index]) distance[index] = x === 0 || y === 0 || x === width - 1 || y === height - 1 ? 10 : saturation;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    if (!mask[index]) continue;
    let best = distance[index];
    if (x > 0) best = Math.min(best, distance[index - 1] + 10);
    if (y > 0) best = Math.min(best, distance[index - width] + 10);
    if (x > 0 && y > 0) best = Math.min(best, distance[index - width - 1] + 14);
    if (x + 1 < width && y > 0) best = Math.min(best, distance[index - width + 1] + 14);
    distance[index] = best;
  }
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    const index = y * width + x;
    if (!mask[index]) continue;
    let best = distance[index];
    if (x + 1 < width) best = Math.min(best, distance[index + 1] + 10);
    if (y + 1 < height) best = Math.min(best, distance[index + width] + 10);
    if (x + 1 < width && y + 1 < height) best = Math.min(best, distance[index + width + 1] + 14);
    if (x > 0 && y + 1 < height) best = Math.min(best, distance[index + width - 1] + 14);
    distance[index] = best;
  }
  const alpha = Buffer.allocUnsafe(mask.length);
  for (let i = 0; i < mask.length; i++) alpha[i] = mask[i] ? Math.min(255, Math.round(255 * distance[i] / saturation)) : 0;
  return alpha;
}

function calculateValidation(base: Buffer, result: Buffer, edit: Buffer, keep: Buffer, pixels: number): Validation {
  let protectedChangedPixels = 0;
  let outsideEditChangedPixels = 0;
  let changedPixels = 0;
  let maxChannelDelta = 0;
  for (let pixel = 0; pixel < pixels; pixel++) {
    const offset = pixel * 4;
    let changed = false;
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(result[offset + channel] - base[offset + channel]);
      if (delta) changed = true;
      if (delta > maxChannelDelta) maxChannelDelta = delta;
    }
    if (!changed) continue;
    changedPixels++;
    if (keep[pixel]) protectedChangedPixels++;
    if (!edit[pixel]) outsideEditChangedPixels++;
  }
  return { protectedChangedPixels, outsideEditChangedPixels, changedPixels, maxChannelDelta, passed: protectedChangedPixels === 0 && outsideEditChangedPixels === 0 };
}

async function readRawPng(filePath: string, width: number, height: number): Promise<{ data: Buffer }> {
  try { return await decodeRawPng(filePath, width, height); }
  catch { throw new StoreError('CORRUPT_ASSET', '基准图像无法解码', 500); }
}

async function decodeRawPng(source: string | Buffer, width: number, height: number): Promise<{ data: Buffer }> {
  try {
    const result = await sharp(source, { limitInputPixels: MAX_PIXELS }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (result.info.width !== width || result.info.height !== height || result.info.channels !== 4) throw new Error('dimensions or channels');
    return { data: result.data };
  } catch { throw new Error('PNG could not be decoded with expected dimensions'); }
}

function withoutValidation(version: Version): Version {
  const { validation: _untrustedValidation, ...trustedFields } = version;
  return trustedFields;
}

async function validateVersionPng(bytes: Buffer, width: number, height: number): Promise<void> {
  if (bytes.length > MAX_PACKAGE_EXPANDED_BYTES) throw new StoreError('INVALID_PACKAGE', '版本图超过包内文件上限');
  try {
    const metadata = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).metadata();
    if (metadata.format !== 'png' || metadata.width !== width || metadata.height !== height || (metadata.width ?? 0) * (metadata.height ?? 0) > MAX_PIXELS) throw new Error('dimensions');
  } catch { throw new StoreError('INVALID_PACKAGE', '版本图格式或尺寸无效'); }
}
async function validatePackageMask(bytes: Buffer, region: Region, width: number, height: number): Promise<void> {
  try {
    const actual = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).greyscale().raw().toBuffer({ resolveWithObject: true });
    if (actual.info.width !== width || actual.info.height !== height || actual.info.channels !== 1) throw new Error('dimensions');
    const expected = await rasterizeRegion(region, width, height);
    for (let i = 0; i < expected.length; i++) {
      if ((actual.data[i] >= 128 ? 255 : 0) !== expected[i]) throw new Error('mask mismatch');
    }
  } catch { throw new StoreError('INVALID_PACKAGE', `区域 ${region.id} 的蒙版与标注不一致`); }
}

function decodeBase64(value: string, label: string, maxBytes: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new StoreError('INVALID_BASE64', `${label}不是有效的 base64`);
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length === 0 || buffer.length > maxBytes || buffer.toString('base64') !== value) throw new StoreError('INPUT_SIZE_LIMIT', `${label}为空、超过大小限制或编码无效`);
  return buffer;
}

function parseManifest(bytes: Buffer): PackageManifest {
  if (bytes.length > 5 * 1024 * 1024) throw new StoreError('INVALID_PACKAGE', 'manifest 超过大小限制');
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new StoreError('INVALID_PACKAGE', 'manifest.json 无效'); }
  const schema = z.object({
    format: z.literal('maskcanvas-package'),
    schemaVersion: z.literal(1),
    projectId: z.string().uuid(),
    files: z.array(z.object({ path: z.string().min(1).max(240), bytes: z.number().int().nonnegative().max(MAX_PACKAGE_EXPANDED_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(MAX_PACKAGE_ENTRIES),
  }).strict();
  const result = schema.safeParse(parsed);
  if (!result.success) throw new StoreError('INVALID_PACKAGE', 'manifest 数据无效');
  return result.data;
}

async function extractPackage(zipBuffer: Buffer): Promise<Map<string, Buffer>> {
  const output = new Map<string, Buffer>();
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true, validateEntrySizes: true, autoClose: true }, (error, zip) => {
      if (error || !zip) { reject(new StoreError('INVALID_PACKAGE', '无法读取 ZIP 包')); return; }
      let count = 0;
      let expanded = 0;
      let settled = false;
      const fail = (reason: Error) => { if (!settled) { settled = true; zip.close(); reject(reason); } };
      zip.on('error', () => fail(new StoreError('INVALID_PACKAGE', 'ZIP 包损坏')));
      zip.on('end', () => { if (!settled) { settled = true; resolve(output); } });
      zip.on('entry', (entry) => {
        count++;
        if (count > MAX_PACKAGE_ENTRIES || !isSafeZipEntry(entry.fileName)) { fail(new StoreError('INVALID_PACKAGE', 'ZIP 包含过多文件或非法路径')); return; }
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((mode & 0o170000) === 0o120000) { fail(new StoreError('INVALID_PACKAGE', 'ZIP 不允许符号链接')); return; }
        if (entry.fileName.endsWith('/') || output.has(entry.fileName)) { fail(new StoreError('INVALID_PACKAGE', 'ZIP 不允许目录项或重复路径')); return; }
        expanded += entry.uncompressedSize;
        if (entry.uncompressedSize > MAX_PACKAGE_EXPANDED_BYTES || expanded > MAX_PACKAGE_EXPANDED_BYTES) { fail(new StoreError('INPUT_SIZE_LIMIT', 'ZIP 解压后超过大小限制')); return; }
        if (!isAllowedPackagePath(entry.fileName) && entry.fileName !== 'manifest.json') { fail(new StoreError('INVALID_PACKAGE', `ZIP 包含不支持的文件：${entry.fileName}`)); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail(new StoreError('INVALID_PACKAGE', '无法读取 ZIP 文件')); return; }
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > entry.uncompressedSize || size > MAX_PACKAGE_EXPANDED_BYTES) { stream.destroy(); fail(new StoreError('INVALID_PACKAGE', 'ZIP 文件大小与声明不符')); return; }
            chunks.push(chunk);
          });
          stream.on('error', () => fail(new StoreError('INVALID_PACKAGE', 'ZIP 文件流损坏')));
          stream.on('end', () => {
            if (settled) return;
            if (size !== entry.uncompressedSize) { fail(new StoreError('INVALID_PACKAGE', 'ZIP 文件长度不匹配')); return; }
            output.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

function isSafeZipEntry(name: string): boolean {
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  const parts = name.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}
function isAllowedPackagePath(name: string): boolean {
  return name === 'project.json' || /^assets\/[A-Za-z0-9_-]{1,110}\.png$/.test(name) || /^assets\/original\.(?:jpg|png)$/.test(name) || /^masks\/[A-Za-z0-9_-]{1,80}\.png$/.test(name);
}

async function packageFile(filePath: string, source: Buffer | string): Promise<{ path: string; source: Buffer | string; bytes: number; sha256: string }> {
  if (Buffer.isBuffer(source)) return { path: filePath, source, bytes: source.length, sha256: sha256(source) };
  const fileStat = await stat(source);
  return { path: filePath, source, bytes: fileStat.size, sha256: await sha256File(source) };
}
function zipEntries(entries: Array<{ path: string; source: Buffer | string; bytes: number; sha256: string }>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = new archiver.ZipArchive({ zlib: { level: 6 } });
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    output.on('error', reject);
    archive.on('error', reject);
    output.on('end', () => resolve(Buffer.concat(chunks)));
    archive.pipe(output);
    for (const entry of entries) {
      if (Buffer.isBuffer(entry.source)) archive.append(entry.source, { name: entry.path });
      else archive.file(entry.source, { name: entry.path });
    }
    archive.finalize().catch(reject);
  });
}
function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
async function atomicWrite(filePath: string, bytes: Buffer): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, filePath); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}
function isProjectId(id: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id); }
function isCode(error: unknown, code: string): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === code; }

