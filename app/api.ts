import type { AnnotationDocument, Capabilities, EditProposal, Job, Project, ProjectSummary, ProposalInput, ProposalSuggestion, Region } from '../packages/shared/types';

type Session = { token: string };
type ApiErrorBody = { error?: { code?: string; message?: string } };
export type PendingJobSubmission = {
  projectId: string;
  revision: number;
  regionId: string;
  idempotencyKey: string;
};
export type PlanJob = Job & {
  proposalId?: string;
  confirmationId?: string;
  regionIds?: string[];
  stepIndex?: number;
  stepCount?: number;
};
export interface ProposalDocument {
  format: 'maskcanvas.proposal';
  schemaVersion: 1;
  projectId: string;
  image: AnnotationDocument['image'];
  proposal: EditProposal;
}
export interface RebindResult {
  proposal: EditProposal;
  source: { projectId: string; baseVersionId: string; revision: number };
  target: { projectId: string; baseVersionId: string; revision: number };
  imageMatched: true;
}
export type GrantPurpose = 'analysis' | 'generation';
export type GrantBackend = 'agent' | 'qwen' | 'gpt';
export interface ProjectGrantInput {
  baseVersionId: string;
  purpose: GrantPurpose;
  backend: GrantBackend;
  destination: string;
  expiresAt?: string;
  maxJobs?: number;
}
export interface ProjectGrant extends ProjectGrantInput {
  id: string;
  projectId: string;
  createdAt: string;
  consumedJobs: number;
  revokedAt?: string;
}
export interface ProjectPermissions {
  grants: ProjectGrant[];
  processing: Partial<Record<'qwen' | 'gpt', { destination: string; modelId: string }>>;
  remoteGenerationEnabled: boolean;
}
export type PendingPlanJobSubmission = {
  projectId: string;
  proposalId: string;
  confirmationId: string;
  idempotencyKey: string;
  jobId?: string;
  grantId?: string;
};
const pendingJobsKey = 'maskcanvas.pendingJobs.v1';
const pendingPlanJobsKey = 'maskcanvas.pendingPlanJobs.v1';

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(message: string, code = 'request_failed', status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

function readPendingJobs(): PendingJobSubmission[] {
  const raw = sessionStorage.getItem(pendingJobsKey);
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new ApiError('待核对的本地任务记录无法读取；为避免重复生成，已阻止提交新任务。', 'PENDING_JOB_RECORD_INVALID'); }
  if (!Array.isArray(parsed) || parsed.some(item => !item || typeof item.projectId !== 'string' || !Number.isInteger(item.revision) || typeof item.regionId !== 'string' || typeof item.idempotencyKey !== 'string')) {
    throw new ApiError('待核对的本地任务记录格式无效；为避免重复生成，已阻止提交新任务。', 'PENDING_JOB_RECORD_INVALID');
  }
  return parsed as PendingJobSubmission[];
}

export function getPendingJobSubmissions(projectId?: string): PendingJobSubmission[] {
  const pending = readPendingJobs();
  return projectId ? pending.filter(item => item.projectId === projectId) : pending;
}

function writePendingJob(submission: PendingJobSubmission): void {
  const current = readPendingJobs();
  const next = [...current.filter(item => !(item.projectId === submission.projectId && item.revision === submission.revision && item.regionId === submission.regionId)), submission];
  try { sessionStorage.setItem(pendingJobsKey, JSON.stringify(next)); }
  catch { throw new ApiError('无法保存任务待核对记录；为避免重复生成，已阻止任务提交。', 'PENDING_JOB_STORAGE_UNAVAILABLE'); }
}

function clearPendingJob(submission: PendingJobSubmission): void {
  const current = readPendingJobs();
  const next = current.filter(item => !(item.projectId === submission.projectId && item.revision === submission.revision && item.regionId === submission.regionId && item.idempotencyKey === submission.idempotencyKey));
  if (next.length === current.length) return;
  try { sessionStorage.setItem(pendingJobsKey, JSON.stringify(next)); }
  catch { throw new ApiError('无法清除本地待核对记录；服务端状态可能已确认或拒绝。再次核对仍会复用原幂等键。', 'PENDING_JOB_STORAGE_UNAVAILABLE'); }
}

function readPendingPlanJobs(): PendingPlanJobSubmission[] {
  let raw: string | null;
  try { raw = localStorage.getItem(pendingPlanJobsKey); }
  catch { throw new ApiError('无法读取本地计划任务记录；为避免重复执行，已阻止提交。', 'PENDING_PLAN_JOB_STORAGE_UNAVAILABLE'); }
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new ApiError('本地计划任务记录无法解析；为避免重复执行，已阻止提交。', 'PENDING_PLAN_JOB_RECORD_INVALID'); }
  if (!Array.isArray(parsed) || parsed.some(item => !item || typeof item.projectId !== 'string' || typeof item.proposalId !== 'string' || typeof item.confirmationId !== 'string' || typeof item.idempotencyKey !== 'string' || item.jobId !== undefined && typeof item.jobId !== 'string' || item.grantId !== undefined && typeof item.grantId !== 'string')) {
    throw new ApiError('本地计划任务记录格式无效；为避免重复执行，已阻止提交。', 'PENDING_PLAN_JOB_RECORD_INVALID');
  }
  return parsed as PendingPlanJobSubmission[];
}

function writePendingPlanJob(submission: PendingPlanJobSubmission): void {
  const current = readPendingPlanJobs();
  const next = [...current.filter(item => !(item.projectId === submission.projectId && item.proposalId === submission.proposalId && item.confirmationId === submission.confirmationId)), submission];
  try { localStorage.setItem(pendingPlanJobsKey, JSON.stringify(next)); }
  catch { throw new ApiError('无法保存计划任务幂等记录；为避免重复执行，已阻止提交新任务。', 'PENDING_PLAN_JOB_STORAGE_UNAVAILABLE'); }
}

export function getPendingPlanJobSubmissions(projectId?: string): PendingPlanJobSubmission[] {
  const pending = readPendingPlanJobs();
  return projectId ? pending.filter(item => item.projectId === projectId) : pending;
}

class ApiClient {
  private token = '';

  async openSession(): Promise<void> {
    const response = await fetch('/api/session');
    const body = (await this.readJson(response)) as Session;
    if (!body?.token) throw new ApiError('本地会话未返回访问令牌。', 'invalid_session');
    this.token = body.token;
  }

  private async readJson(response: Response): Promise<unknown> {
    let body: unknown;
    try { body = await response.json(); }
    catch {
      if (response.ok) throw new ApiError('本地服务返回了无法解析的响应。', 'INVALID_RESPONSE', response.status);
      throw new ApiError(`请求失败（HTTP ${response.status}），且错误响应无法解析。`, 'INVALID_ERROR_RESPONSE', response.status);
    }
    if (!response.ok) {
      const errorBody = body as ApiErrorBody;
      throw new ApiError(errorBody.error?.message || `请求失败（HTTP ${response.status}）`, errorBody.error?.code, response.status);
    }
    return body;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set('x-maskcanvas-token', this.token);
    if (init.body && !(init.body instanceof FormData)) headers.set('content-type', 'application/json');
    const response = await fetch(path, { ...init, headers });
    return (await this.readJson(response)) as T;
  }

  async getBlob(path: string): Promise<Blob> {
    const response = await fetch(path, { headers: { 'x-maskcanvas-token': this.token } });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
      throw new ApiError(body.error?.message || `无法读取文件（HTTP ${response.status}）`, body.error?.code, response.status);
    }
    return response.blob();
  }

  getCapabilities() {
    return this.request<Capabilities>('/api/capabilities');
  }

  getProjects() {
    return this.request<ProjectSummary[]>('/api/projects');
  }

  getProject(id: string) {
    return this.request<Project>(`/api/projects/${encodeURIComponent(id)}`);
  }

  getProjectPermissions(projectId: string) {
    return this.request<ProjectPermissions>(`/api/projects/${encodeURIComponent(projectId)}/permissions`);
  }

  createProjectGrant(projectId: string, input: ProjectGrantInput) {
    return this.request<ProjectGrant>(`/api/projects/${encodeURIComponent(projectId)}/permissions`, {
      method: 'POST', body: JSON.stringify(input),
    });
  }

  revokeProjectGrant(projectId: string, grantId: string) {
    return this.request<ProjectGrant>(`/api/projects/${encodeURIComponent(projectId)}/permissions/${encodeURIComponent(grantId)}/revoke`, {
      method: 'POST', body: JSON.stringify({}),
    });
  }

  getAnnotations(id: string) {
    return this.request<AnnotationDocument>(`/api/projects/${encodeURIComponent(id)}/annotations`);
  }

  importAnnotations(document: AnnotationDocument) {
    return this.request<Project>(`/api/projects/${encodeURIComponent(document.projectId)}/annotations`, { method: 'POST', body: JSON.stringify({ document }) });
  }

  createProject(name: string, imageDataUrl: string) {
    return this.request<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ name, imageDataUrl }) });
  }

  saveRegions(id: string, revision: number, regions: Region[]) {
    return this.request<Project>(`/api/projects/${encodeURIComponent(id)}/regions`, {
      method: 'PUT',
      body: JSON.stringify({ revision, regions }),
    });
  }

  getProposals(projectId: string) {
    return this.request<EditProposal[]>(`/api/projects/${encodeURIComponent(projectId)}/proposals`);
  }

  createProposal(projectId: string, input: ProposalInput) {
    return this.request<EditProposal>(`/api/projects/${encodeURIComponent(projectId)}/proposals`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  getProposal(projectId: string, proposalId: string) {
    return this.request<EditProposal>(`/api/projects/${encodeURIComponent(projectId)}/proposals/${encodeURIComponent(proposalId)}`);
  }

  getProposalDocument(projectId: string, proposalId: string) {
    return this.request<ProposalDocument>(`/api/projects/${encodeURIComponent(projectId)}/proposals/${encodeURIComponent(proposalId)}/document`);
  }

  importProposalDocument(document: ProposalDocument) {
    return this.request<EditProposal>(`/api/projects/${encodeURIComponent(document.projectId)}/proposal-documents`, {
      method: 'POST', body: JSON.stringify({ document }),
    });
  }

  rebindJson(targetProjectId: string, document: AnnotationDocument | ProposalDocument) {
    return this.request<RebindResult>(`/api/projects/${encodeURIComponent(targetProjectId)}/rebind-json`, {
      method: 'POST', body: JSON.stringify({ document }),
    });
  }

  patchProposal(projectId: string, proposalId: string, body: {
    revision: number;
    title?: string;
    goal?: string;
    backend?: EditProposal['backend'];
    regions?: Region[];
    suggestions?: ProposalSuggestion[];
  }) {
    return this.request<EditProposal>(`/api/projects/${encodeURIComponent(projectId)}/proposals/${encodeURIComponent(proposalId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  confirmProposal(projectId: string, proposalId: string, revision: number, projectRevision: number) {
    return this.request<EditProposal>(`/api/projects/${encodeURIComponent(projectId)}/proposals/${encodeURIComponent(proposalId)}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ revision, projectRevision }),
    });
  }

  cancelProposal(projectId: string, proposalId: string, revision: number) {
    return this.request<EditProposal>(`/api/projects/${encodeURIComponent(projectId)}/proposals/${encodeURIComponent(proposalId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ revision }),
    });
  }

  createCandidate(id: string, body: { revision: number; baseVersionId: string; regionId: string; imageDataUrl: string; name?: string }) {
    return this.request<Project>(`/api/projects/${encodeURIComponent(id)}/candidates`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  acceptVersion(id: string, revision: number, versionId: string) {
    return this.request<Project>(`/api/projects/${encodeURIComponent(id)}/accept`, {
      method: 'POST',
      body: JSON.stringify({ revision, versionId }),
    });
  }
  rejectVersion(id: string, revision: number, versionId: string) {
    return this.request<Project>(`/api/projects/${encodeURIComponent(id)}/reject`, {
      method: 'POST', body: JSON.stringify({ revision, versionId }),
    });
  }

  getJobs(projectId: string) {
    return this.request<PlanJob[]>(`/api/jobs?projectId=${encodeURIComponent(projectId)}`);
  }

  getJob(id: string) {
    return this.request<PlanJob>(`/api/jobs/${encodeURIComponent(id)}`);
  }

  async createPlanJob(projectId: string, proposalId: string, confirmationId: string, grantId?: string): Promise<PlanJob> {
    const current = readPendingPlanJobs().find(item => item.projectId === projectId && item.proposalId === proposalId && item.confirmationId === confirmationId);
    if (current && current.grantId !== grantId) throw new ApiError('这份计划已有待核对提交；重试必须使用原授权，不能切换 grantId。', 'PLAN_JOB_GRANT_CONFLICT', 409);
    if (current?.jobId) {
      const job = await this.getJob(current.jobId);
      if (job.proposalId !== proposalId || job.confirmationId !== confirmationId || job.grantId !== current.grantId) throw new ApiError('本地任务记录与服务端确认计划或授权不匹配；为避免重复执行，已停止继续提交。', 'PLAN_JOB_RECORD_MISMATCH', 409);
      return job;
    }
    const submission = current ?? { projectId, proposalId, confirmationId, idempotencyKey: crypto.randomUUID(), ...(grantId ? { grantId } : {}) };
    if (!current) writePendingPlanJob(submission);
    const job = await this.request<PlanJob>(`/api/projects/${encodeURIComponent(projectId)}/plan-jobs`, {
      method: 'POST',
      body: JSON.stringify({ proposalId, confirmationId, idempotencyKey: submission.idempotencyKey, ...(submission.grantId ? { grantId: submission.grantId } : {}) }),
      signal: AbortSignal.timeout(45_000),
    });
    if (job.proposalId !== proposalId || job.confirmationId !== confirmationId || job.grantId !== submission.grantId) throw new ApiError('服务端返回的任务与确认计划或授权不匹配；原幂等键已保留，请核对任务状态。', 'PLAN_JOB_RESPONSE_MISMATCH', 502);
    writePendingPlanJob({ ...submission, jobId: job.id });
    return job;
  }

  async createJob(projectId: string, revision: number, regionId: string): Promise<Job> {
    const current = getPendingJobSubmissions().find(item => item.projectId === projectId && item.revision === revision && item.regionId === regionId);
    const submission = current ?? { projectId, revision, regionId, idempotencyKey: crypto.randomUUID() };
    if (!current) writePendingJob(submission);
    try {
      const job = await this.request<Job>(`/api/projects/${encodeURIComponent(projectId)}/jobs`, {
        method: 'POST',
        body: JSON.stringify({ revision, regionId, idempotencyKey: submission.idempotencyKey }),
        signal: AbortSignal.timeout(45_000),
      });
      clearPendingJob(submission);
      return job;
    } catch (error) {
      // A changed session/transport rejection says nothing about the original
      // ambiguous request. Retain that key until the job handler can reconcile it.
      const definitiveJobRejection = error instanceof ApiError && ['INVALID_JOB', 'REVISION_CONFLICT', 'INVALID_EDIT', 'EMPTY_EDIT', 'CROP_TOO_LARGE', 'QWEN_UNAVAILABLE', 'IDEMPOTENCY_CONFLICT'].includes(error.code);
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && (!current || definitiveJobRejection)) clearPendingJob(submission);
      throw error;
    }
  }

  async importPackage(dataBase64: string) {
    return this.request<Project>('/api/import-package', { method: 'POST', body: JSON.stringify({ dataBase64 }) });
  }

  projectFile(id: string, endpoint: 'export' | 'package') {
    return `/api/projects/${encodeURIComponent(id)}/${endpoint}`;
  }

  asset(id: string, asset: string) {
    return `/api/projects/${encodeURIComponent(id)}/assets/${encodeURIComponent(asset)}`;
  }
}

export const api = new ApiClient();

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取所选文件。'));
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('图片编码失败。')));
    reader.readAsDataURL(file);
  });
}

export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const stride = 0x8000;
  for (let i = 0; i < bytes.length; i += stride) {
    binary += String.fromCharCode(...bytes.subarray(i, i + stride));
  }
  return btoa(binary);
}

export async function downloadBlob(path: string, filename: string): Promise<void> {
  const blob = await api.getBlob(path);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
