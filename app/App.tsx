import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUUpLeft,
  CaretDown,
  Check,
  CheckCircle,
  Clock,
  CloudArrowDown,
  Cursor,
  DotsThree,
  DownloadSimple,
  Eraser,
  Eye,
  EyeSlash,
  FileCode,
  FolderSimplePlus,
  GearSix,
  Hand,
  ImageSquare,
  Info,
  LockKey,
  PaintBrush,
  Magnet,
  MagicWand,
  Keyboard,
  Plus,
  Rectangle,
  ShieldCheck,
  Sparkle,
  UploadSimple,
  WarningCircle,
  X,
  ArrowsLeftRight,
  ArrowsOut,
  ArrowsIn,
  CircleHalf,
  Path,
} from '@phosphor-icons/react';
import type { AnnotationDocument, Capabilities, EditProposal, Job, Project, ProjectSummary, Region, Shape, Version } from '../packages/shared/types';
import { api, ApiError, downloadBlob, fileToDataUrl, getPendingJobSubmissions, getPendingPlanJobSubmissions, type PendingJobSubmission, type PendingPlanJobSubmission, type PlanJob, type ProjectGrant, type ProjectGrantInput, type ProjectPermissions as ProjectPermissionsSnapshot, type ProposalDocument, type RebindResult } from './api';
import { CanvasEditor, type AnnotationKind, type Tool } from './CanvasEditor';
import { ProposalReview, type ProposalDraftFields } from './ProposalReview';
import { RegionContextControl } from './RegionContextControl';
import { ReviewCompare } from './ReviewCompare';
import { morphRegionShapes, type MorphOp } from './mask-morphology';
import { AnnotateHistory, type AnnotateSnapshot } from './annotate-history';
import type { ReviewCompareMode } from './canvas-diff';
import './styles.css';

type Page = 'projects' | 'packages' | 'settings' | 'editor';
type EditorTab = 'retouch' | 'annotate' | 'collab' | 'jobs';
type Flash = { kind: 'success' | 'error' | 'info'; message: string } | null;

function makeId(): string {
  return crypto.randomUUID();
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function formatDimensions(width: number, height: number): string {
  return `${width.toLocaleString()} × ${height.toLocaleString()}`;
}

function regionRoughBounds(region: Region) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const shape of region.shapes) {
    if (shape.type === 'rect') {
      x0 = Math.min(x0, shape.x); y0 = Math.min(y0, shape.y);
      x1 = Math.max(x1, shape.x + shape.width); y1 = Math.max(y1, shape.y + shape.height);
    } else for (const point of shape.points) {
      const r = shape.type === 'brush' ? shape.radius : 0;
      x0 = Math.min(x0, point.x - r); y0 = Math.min(y0, point.y - r);
      x1 = Math.max(x1, point.x + r); y1 = Math.max(y1, point.y + r);
    }
  }
  if (!Number.isFinite(x0)) return null;
  return { x0, y0, x1, y1 };
}

function overlappingEditNames(regions: Region[]): string[] {
  const edits = regions.filter(region => region.kind === 'edit' && region.shapes.length);
  const hits: string[] = [];
  for (let i = 0; i < edits.length; i++) for (let j = i + 1; j < edits.length; j++) {
    const a = regionRoughBounds(edits[i]), b = regionRoughBounds(edits[j]);
    if (!a || !b) continue;
    if (a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0) hits.push(`${edits[i].name} ↔ ${edits[j].name}`);
  }
  return hits;
}


function safeFilename(value: string): string {
  return value.trim().replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'MaskCanvas';
}

function assetThumb(id: string, asset: string, label: string) {
  return <AssetThumb projectId={id} asset={asset} label={label} />;
}

function AssetThumb({ projectId, asset, label }: { projectId: string; asset: string; label: string }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let objectUrl = '';
    setUrl('');
    setFailed(false);
    api.getBlob(api.asset(projectId, asset)).then(blob => {
      objectUrl = URL.createObjectURL(blob);
      if (live) setUrl(objectUrl);
      else URL.revokeObjectURL(objectUrl);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [projectId, asset]);
  return url ? <img src={url} alt={label} /> : <span className="thumb-placeholder" title={failed ? `无法读取${label}` : `正在读取${label}`} aria-label={failed ? `无法读取${label}` : `正在读取${label}`}>{failed ? <><WarningCircle size={20} /><small>读取失败</small></> : <ImageSquare size={22} />}</span>;
}

function RegionPreview({ imageUrl, region, width, height }: { imageUrl: string; region: Region; width: number; height: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!imageUrl || !region.shapes.length) return;
    let active = true;
    const image = new Image();
    image.onload = () => {
      if (!active || !canvas.current) return;
      let x0 = width, y0 = height, x1 = 0, y1 = 0;
      for (const shape of region.shapes.filter(shape => !shape.subtract)) {
        if (shape.type === 'rect') {
          x0 = Math.min(x0, shape.x); y0 = Math.min(y0, shape.y);
          x1 = Math.max(x1, shape.x + shape.width); y1 = Math.max(y1, shape.y + shape.height);
        } else for (const point of shape.points) {
          const r = shape.type === 'brush' ? shape.radius : 0;
          x0 = Math.min(x0, point.x - r); y0 = Math.min(y0, point.y - r);
          x1 = Math.max(x1, point.x + r); y1 = Math.max(y1, point.y + r);
        }
      }
      x0 = Math.max(0, x0 - 24); y0 = Math.max(0, y0 - 24);
      x1 = Math.min(width, x1 + 24); y1 = Math.min(height, y1 + 24);
      if (x1 <= x0 || y1 <= y0) return;
      canvas.current.getContext('2d')?.drawImage(image, x0, y0, x1 - x0, y1 - y0, 0, 0, 240, 144);
    };
    image.src = imageUrl;
    return () => { active = false; image.onload = null; };
  }, [imageUrl, region, width, height]);
  return <canvas className="region-preview" ref={canvas} width={240} height={144} aria-label={`${region.name}局部预览`} />;
}

function CapabilityLine({ label, available, reason, loading = false }: { label: string; available: boolean | null; reason?: string; loading?: boolean }) {
  return (
    <div className="capability-line">
      <span className={`capability-dot ${available ? 'is-ready' : ''} ${loading ? 'is-loading' : ''}`} />
      <span className="capability-label">{label}</span>
      <span className={`capability-state ${available ? 'is-ready' : ''}`}>{loading ? '检测中' : available === null ? '读取失败' : available ? '可用' : '未配置'}</span>
      {reason && <small>{reason}</small>}
    </div>
  );
}

function jobLabel(status: Job['status']): string {
  return {
    queued: '排队中',
    running: '正在执行',
    reconciling: '正在核对结果',
    candidate: '候选待验收',
    failed: '执行失败',
    cancelled: '已取消',
  }[status];
}

function validateImageSize(dataUrl: string, expectedWidth: number, expectedHeight: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (image.naturalWidth !== expectedWidth || image.naturalHeight !== expectedHeight) {
        reject(new Error(`候选图尺寸为 ${image.naturalWidth} × ${image.naturalHeight}，项目基准为 ${expectedWidth} × ${expectedHeight}。请导出同尺寸 PNG 再导入。`));
      } else resolve();
    };
    image.onerror = () => reject(new Error('无法解码这张候选图片，请检查文件格式。'));
    image.src = dataUrl;
  });
}

export default function App() {
  const [sessionReady, setSessionReady] = useState(false);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(true);
  const [capabilitiesError, setCapabilitiesError] = useState('');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [page, setPage] = useState<Page>('projects');
  const [tab, setTab] = useState<EditorTab>('retouch');
  const [regions, setRegions] = useState<Region[]>([]);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [proposals, setProposals] = useState<EditProposal[]>([]);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [activeProposal, setActiveProposal] = useState<EditProposal | null>(null);
  const [proposalDraft, setProposalDraft] = useState<ProposalDraftFields | null>(null);
  const [proposalsLoading, setProposalsLoading] = useState(false);
  const [proposalError, setProposalError] = useState('');
  const [isComparing, setIsComparing] = useState(false);
  const [compareMode, setCompareMode] = useState<ReviewCompareMode>('side');
  const [morphRadius, setMorphRadius] = useState(4);
  const [showCheatSheet, setShowCheatSheet] = useState(false);
  const [showMasks, setShowMasks] = useState(true);
  const [tool, setTool] = useState<Tool>('select');
  const [annotationKind, setAnnotationKind] = useState<AnnotationKind>('edit');
  const [brushSize, setBrushSize] = useState(24);
  const [jobs, setJobs] = useState<PlanJob[]>([]);
  const [pendingJobs, setPendingJobs] = useState<PendingJobSubmission[]>([]);
  const [pendingJobsError, setPendingJobsError] = useState('');
  const [pendingPlanJobs, setPendingPlanJobs] = useState<PendingPlanJobSubmission[]>([]);
  const [pendingPlanJobsError, setPendingPlanJobsError] = useState('');
  const [projectPermissions, setProjectPermissions] = useState<ProjectPermissionsSnapshot | null>(null);
  const [permissionsLoading, setPermissionsLoading] = useState(false);
  const [permissionsError, setPermissionsError] = useState('');
  const [busyGrantId, setBusyGrantId] = useState<string | null>(null);
  const [permissionCreating, setPermissionCreating] = useState(false);
  const [selectedExecutionGrant, setSelectedExecutionGrant] = useState<{ proposalId: string; grantId: string } | null>(null);
  const [planExecutionError, setPlanExecutionError] = useState('');
  const [flash, setFlash] = useState<Flash>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonDialog, setJsonDialog] = useState(false);
  const [jsonDialogType, setJsonDialogType] = useState<'annotations' | 'proposal'>('annotations');
  const [jsonImportText, setJsonImportText] = useState('');
  const [rebindJsonToCurrentPhoto, setRebindJsonToCurrentPhoto] = useState(false);
  const [leavePrompt, setLeavePrompt] = useState(false);
  const [proposalExitPrompt, setProposalExitPrompt] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState('');
  const photoInputRef = useRef<HTMLInputElement>(null);
  const packageInputRef = useRef<HTMLInputElement>(null);
  const candidateInputRef = useRef<HTMLInputElement>(null);
  const savedRegionsRef = useRef('[]');
  const annotateHistoryRef = useRef<AnnotateHistory | null>(null);
  const skipHistoryRef = useRef(false);
  const [historyTick, setHistoryTick] = useState(0);
  const savedProposalDraftRef = useRef('');
  const proposalDirtyRef = useRef(false);
  const draftDirtyRef = useRef(false);
  const currentProjectIdRef = useRef<string | null>(null);
  const activeProposalRef = useRef<EditProposal | null>(null);
  const surfacedPlanCandidatesRef = useRef(new Set<string>());
  const surfacingPlanCandidatesRef = useRef(new Set<string>());
  const flashTimerRef = useRef<number | null>(null);
  const selectedRegion = regions.find(region => region.id === selectedRegionId) ?? null;
  const selectedProposal = proposals.find(proposal => proposal.id === selectedProposalId) ?? null;
  const reviewProposal = activeProposal ?? selectedProposal;
  const watchedConfirmedProposalId = (activeProposal ?? selectedProposal)?.status === 'confirmed' ? (activeProposal ?? selectedProposal)?.id ?? null : null;
  const proposalSnapshot = proposalDraft ? JSON.stringify({ ...proposalDraft, regions }) : '';
  const dirty = activeProposal ? Boolean(proposalSnapshot && proposalSnapshot !== savedProposalDraftRef.current) : JSON.stringify(regions) !== savedRegionsRef.current;
  proposalDirtyRef.current = dirty && Boolean(activeProposal);
  draftDirtyRef.current = dirty;
  activeProposalRef.current = activeProposal;
  const selectedVersion = currentProject?.versions.find(version => version.id === selectedVersionId) ?? null;
  const selectedCandidateStale = selectedVersion?.status === 'candidate' && Boolean(currentProject) && (
    selectedVersion.stale ||
    selectedVersion.annotationRevision !== currentProject?.revision || selectedVersion.baseVersionId !== currentProject?.baseVersionId
  );
  const sourceVersion = currentProject?.versions.find(version => version.status === 'source') ?? null;
  const comparisonVersion = sourceVersion ?? currentProject?.versions.find(version => version.id === currentProject.baseVersionId) ?? null;
  const comparisonLabel = sourceVersion ? '原图' : '当前基准';
  const displayUrl = currentProject && selectedVersion ? api.asset(currentProject.id, selectedVersion.asset) : '';
  const baseUrl = currentProject && comparisonVersion ? api.asset(currentProject.id, comparisonVersion.asset) : '';
  const hasActiveJobs = jobs.some(job => ['queued', 'running', 'reconciling'].includes(job.status));
  const hasPendingJob = pendingJobs.length > 0;

  const notify = useCallback((kind: NonNullable<Flash>['kind'], message: string) => {
    setFlash({ kind, message });
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlash(null), kind === 'error' ? 8000 : 4200);
  }, []);

  const refreshProjects = useCallback(async () => {
    const list = await api.getProjects();
    setProjects(list);
  }, []);

  const refreshPendingJobs = useCallback((projectId?: string) => {
    if (!projectId) { setPendingJobs([]); setPendingJobsError(''); return; }
    try {
      setPendingJobs(getPendingJobSubmissions(projectId));
      setPendingJobsError('');
    } catch (error) {
      const message = error instanceof Error ? error.message : '待核对任务记录无法读取。';
      setPendingJobsError(message);
      notify('error', message);
    }
  }, [notify]);

  const refreshPendingPlanJobs = useCallback((projectId?: string) => {
    if (!projectId) { setPendingPlanJobs([]); setPendingPlanJobsError(''); return; }
    try {
      setPendingPlanJobs(getPendingPlanJobSubmissions(projectId));
      setPendingPlanJobsError('');
    } catch (error) {
      const message = error instanceof Error ? error.message : '计划任务幂等记录无法读取。';
      setPendingPlanJobsError(message);
      notify('error', message);
    }
  }, [notify]);

  const refreshProjectPermissions = useCallback(async (projectId = currentProject?.id) => {
    if (!projectId) return;
    setPermissionsLoading(true);
    setPermissionsError('');
    try {
      const snapshot = await api.getProjectPermissions(projectId);
      if (currentProjectIdRef.current === projectId) setProjectPermissions(snapshot);
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : '读取项目授权失败。';
      if (currentProjectIdRef.current === projectId) setPermissionsError(message);
      throw error;
    } finally {
      if (currentProjectIdRef.current === projectId) setPermissionsLoading(false);
    }
  }, [currentProject?.id]);

  const createProjectPermission = async (input: ProjectGrantInput) => {
    if (!currentProject) return;
    setPermissionCreating(true);
    setPermissionsError('');
    try {
      await api.createProjectGrant(currentProject.id, input);
      await refreshProjectPermissions(currentProject.id);
      notify('success', input.purpose === 'analysis' ? '已创建当前照片的 Agent 分析授权。' : '已创建一次性 GPT Image 生成授权。');
    } catch (error) {
      const message = error instanceof Error ? error.message : '创建项目授权失败。';
      setPermissionsError(message);
      notify('error', `创建授权失败：${message}`);
    } finally {
      setPermissionCreating(false);
    }
  };

  const revokeProjectPermission = async (grant: ProjectGrant) => {
    if (!currentProject) return;
    setBusyGrantId(grant.id);
    setPermissionsError('');
    try {
      await api.revokeProjectGrant(currentProject.id, grant.id);
      await refreshProjectPermissions(currentProject.id);
      if (selectedExecutionGrant?.grantId === grant.id) setSelectedExecutionGrant(null);
      notify('success', '项目授权已手动撤销。');
    } catch (error) {
      const message = error instanceof Error ? error.message : '撤销项目授权失败。';
      setPermissionsError(message);
      notify('error', `撤销授权失败：${message}`);
    } finally {
      setBusyGrantId(null);
    }
  };

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        await api.openSession();
        if (!live) return;
        setSessionReady(true);
        setLoading(false);
        void api.getProjects().then(list => {
          if (live) setProjects(list);
        }).catch(error => {
          if (live) notify('error', `读取项目列表失败：${error instanceof Error ? error.message : '未知错误'}`);
        }).finally(() => { if (live) setProjectsLoading(false); });
        void api.getCapabilities().then(caps => {
          if (live) { setCapabilities(caps); setCapabilitiesError(''); }
        }).catch(error => {
          if (live) {
            const message = error instanceof Error ? error.message : '未知错误';
            setCapabilitiesError(message);
            notify('error', `读取本机能力失败：${message}`);
          }
        }).finally(() => { if (live) setCapabilitiesLoading(false); });
      } catch (error) {
        if (live) setSessionError(error instanceof Error ? error.message : '无法连接本地服务。');
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [notify]);

  const replaceProject = useCallback((project: Project, versionId?: string) => {
    const projectChanged = currentProjectIdRef.current !== project.id;
    currentProjectIdRef.current = project.id;
    setCurrentProject(project);
    setRegions(project.regions); resetHistory(project.regions, project.regions[0]?.id ?? null);
    savedRegionsRef.current = JSON.stringify(project.regions);
    setProposals([]);
    if (projectChanged) setProjectPermissions(null);
    setPermissionsError('');
    setSelectedProposalId(null);
    setActiveProposal(null);
    setProposalDraft(null);
    savedProposalDraftRef.current = '';
    setProposalError('');
    setSelectedRegionId(project.regions[0]?.id ?? null);
    setSelectedVersionId(versionId ?? project.baseVersionId);
    setPage('editor');
  }, []);

  const rememberProposal = (proposal: EditProposal) => {
    setProposals(current => [proposal, ...current.filter(item => item.id !== proposal.id)]);
    setSelectedProposalId(proposal.id);
  };

  const proposalPayload = (proposal: EditProposal): ProposalDraftFields => ({
    title: proposal.title,
    goal: proposal.goal,
    backend: proposal.backend,
    suggestions: proposal.suggestions.map(item => ({ ...item })),
  });

  const proposalSnapshotFor = (fields: ProposalDraftFields, proposalRegions: Region[]) => JSON.stringify({ ...fields, regions: proposalRegions });

  const enterProposalEditor = (proposal: EditProposal) => {
    setSelectedProposalId(proposal.id);
    if (proposal.status !== 'draft') return;
    const fields = proposalPayload(proposal);
    setActiveProposal(proposal);
    setProposalDraft(fields);
    setRegions(proposal.regions); resetHistory(proposal.regions, proposal.regions[0]?.id ?? null);
    savedProposalDraftRef.current = proposalSnapshotFor(fields, proposal.regions);
    setSelectedRegionId(proposal.regions.find(region => region.kind === 'edit')?.id ?? proposal.regions[0]?.id ?? null);
    setAnnotationKind('edit');
    setShowMasks(true);
    setIsComparing(false);
    setTab('collab');
    setPage('editor');
    setProposalError('');
  };

  const loadProposal = async (projectId: string, proposalId: string) => {
    const proposal = await api.getProposal(projectId, proposalId);
    if (proposal.projectId !== projectId) throw new Error('该建议不属于当前项目。');
    rememberProposal(proposal);
    if (proposal.status === 'draft') enterProposalEditor(proposal);
    else setTab('collab');
    return proposal;
  };

  const refreshProposals = useCallback(async (projectId = currentProject?.id) => {
    if (!projectId) return;
    setProposalsLoading(true);
    try {
      const list = await api.getProposals(projectId);
      if (currentProjectIdRef.current !== projectId) return;
      setProposals(list);
      setSelectedProposalId(current => current && list.some(item => item.id === current) ? current : list[0]?.id ?? null);
      const active = activeProposalRef.current;
      const remote = active ? list.find(item => item.id === active.id) : undefined;
      if (active && remote) {
        if (!proposalDirtyRef.current) {
          const fields = proposalPayload(remote);
          setActiveProposal(remote);
          setProposalDraft(fields);
          setRegions(remote.regions);
          savedProposalDraftRef.current = proposalSnapshotFor(fields, remote.regions);
          setProposalError('');
        } else if (remote.revision !== active.revision || remote.status !== active.status) {
          setProposalError(remote.status === 'stale'
            ? '项目基准或正式标注已变化。当前本地草稿已保留，但这份建议不能确认。'
            : '服务端建议已有新修订。当前本地草稿已保留；保存前请核对修订冲突。');
          setActiveProposal(current => current?.id === remote.id
            ? { ...current, status: remote.status, ...(remote.confirmation ? { confirmation: remote.confirmation } : {}) }
            : current);
        }
      }
      if (!active) setProposalError('');
    } catch (error) {
      if (currentProjectIdRef.current === projectId) setProposalError(`读取建议失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      if (currentProjectIdRef.current === projectId) setProposalsLoading(false);
    }
  }, [currentProject?.id]);

  const openedLink = useRef(false);
  useEffect(() => {
    if (!sessionReady || openedLink.current) return;
    openedLink.current = true;
    const params = new URLSearchParams(window.location.search);
    const id = params.get('project');
    const proposalId = params.get('proposal');
    if (!id) return;
    if (!/^[0-9a-f-]{36}$/i.test(id)) { notify('error', '项目链接无效。'); return; }
    void api.getProject(id).then(async project => {
      replaceProject(project);
      if (proposalId) {
        if (!/^[0-9a-f-]{36}$/i.test(proposalId)) throw new Error('建议链接无效。');
        await loadProposal(id, proposalId);
      }
    }).catch(error => notify('error', `无法打开项目链接：${error instanceof Error ? error.message : '未知错误'}`));
  }, [sessionReady, replaceProject, notify]);

  useEffect(() => {
    refreshPendingJobs(currentProject?.id);
    refreshPendingPlanJobs(currentProject?.id);
  }, [currentProject?.id, refreshPendingJobs, refreshPendingPlanJobs]);

  useEffect(() => {
    if (!currentProject) return;
    void refreshProjectPermissions(currentProject.id).catch(() => { /* The permissions panel displays the read error. */ });
  }, [currentProject?.id, currentProject?.baseVersionId, refreshProjectPermissions]);

  useEffect(() => {
    if (page !== 'packages') setRebindJsonToCurrentPhoto(false);
  }, [page]);

  useEffect(() => {
    if (!currentProject || tab !== 'collab') return;
    void refreshProposals(currentProject.id);
    if (!activeProposal && !selectedProposalId) return;
    const interval = window.setInterval(() => { void refreshProposals(currentProject.id); }, 3000);
    return () => window.clearInterval(interval);
  }, [currentProject?.id, tab, activeProposal?.id, selectedProposalId, refreshProposals]);

  const openProject = async (id: string) => {
    setBusy('open');
    setFlash(null);
    try {
      const project = await api.getProject(id);
      replaceProject(project);
      setTab('retouch');
      setJobs([]);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '无法打开项目。');
    } finally {
      setBusy(null);
    }
  };

  const createFromPhoto = async (file: File, name?: string) => {
    if (!file.type.startsWith('image/')) throw new Error('请选择 JPEG 或 PNG 照片。');
    if (!['image/jpeg', 'image/png'].includes(file.type)) throw new Error('当前首版仅接受 JPEG 和 PNG。');
    const imageDataUrl = await fileToDataUrl(file);
    const projectName = (name ?? file.name.replace(/\.[^.]+$/, '')).trim().slice(0, 120) || '未命名照片';
    const project = await api.createProject(projectName, imageDataUrl);
    replaceProject(project);
    setTab('retouch');
    await refreshProjects();
  };

  const onPhotoInput = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy('import-photo');
    setFlash(null);
    try {
      await createFromPhoto(file);
      notify('success', '照片已导入为本地项目。');
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '照片导入失败。');
    } finally {
      setBusy(null);
    }
  };

  const applyAnnotationJson = async (text: string) => {
    if (dirty) throw new Error('当前有未保存标注，请先保存或明确放弃，再导入 JSON。');
    if (activeProposal) throw new Error('请先退出建议审阅，再载入另一份 JSON。');
    let document: AnnotationDocument | ProposalDocument;
    try { document = JSON.parse(text); } catch { throw new Error('JSON 语法无效，请检查逗号与引号。'); }
    if (!document || typeof document.projectId !== 'string') throw new Error('请选择 MaskCanvas 标注或计划 JSON；照片须已存在于当前工作区。');
    if (rebindJsonToCurrentPhoto && page === 'packages') {
      if (!currentProject) throw new Error('请先导入或打开目标照片项目，再绑定外部 JSON。');
      if (document.format !== 'maskcanvas.annotations' && document.format !== 'maskcanvas.proposal') throw new Error('仅支持 maskcanvas.annotations 或 maskcanvas.proposal JSON。');
      const result = await api.rebindJson(currentProject.id, document);
      await openReboundProposal(result);
      setRebindJsonToCurrentPhoto(false);
      const summary = `绑定完成，需要重新确认。来源项目 ${result.source.projectId.slice(0, 8)} / 基准 ${result.source.baseVersionId} / 修订 ${result.source.revision}；目标项目 ${result.target.projectId.slice(0, 8)} / 基准 ${result.target.baseVersionId} / 修订 ${result.target.revision}。`;
      try {
        await refreshProjects();
        notify('success', summary);
      } catch (error) {
        notify('info', `${summary} 最近项目列表刷新失败：${error instanceof Error ? error.message : '未知错误'}`);
      }
      return;
    }
    if (document.format === 'maskcanvas.proposal') {
      const proposal = await api.importProposalDocument(document);
      const project = await api.getProject(document.projectId);
      replaceProject(project);
      rememberProposal(proposal);
      enterProposalEditor(proposal);
      await refreshProjects();
      notify('success', '计划 JSON 已作为新草稿载入；需要重新确认，未触发生成。');
      return;
    }
    if (document.format !== 'maskcanvas.annotations') throw new Error('仅支持 maskcanvas.annotations 或 maskcanvas.proposal JSON。');
    const project = await api.importAnnotations(document);
    replaceProject(project); setTab('annotate'); await refreshProjects();
    notify('success', 'JSON 标注已载入，请确认或调整；没有触发图像生成。');
  };

  const openReboundProposal = async (result: RebindResult) => {
    if (!currentProject || result.imageMatched !== true || result.target.projectId !== currentProject.id || result.target.baseVersionId !== currentProject.baseVersionId) {
      throw new Error('服务端返回的目标项目与当前照片状态不匹配，已停止载入，请刷新项目后重试。');
    }
    const project = await api.getProject(result.target.projectId);
    if (project.baseVersionId !== result.target.baseVersionId || project.revision !== result.target.revision) {
      throw new Error('重绑定期间目标照片或项目修订已变化。服务端已创建草稿，但本页未载入；请刷新项目并重新打开建议。');
    }
    replaceProject(project);
    rememberProposal(result.proposal);
    enterProposalEditor(result.proposal);
  };

  const onPackageInput = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    setBusy('import-annotations');
    try {
      if (file.size > 16 * 1024 * 1024) throw new Error('标注 JSON 超过 16MB 限制。');
      await applyAnnotationJson(await file.text());
    } catch (error) { notify('error', error instanceof Error ? error.message : 'JSON 导入失败。'); }
    finally { setBusy(null); }
  };

  const pasteAnnotationJson = async () => {
    setBusy('import-annotations');
    try { await applyAnnotationJson(jsonImportText); }
    catch (error) { notify('error', error instanceof Error ? error.message : 'JSON 导入失败。'); }
    finally { setBusy(null); }
  };

  const loadDemo = async () => {
    setBusy('demo');
    setFlash(null);
    try {
      const response = await fetch('/demo-portrait.png');
      if (!response.ok) throw new Error('合成示例图片尚未就绪，请改为导入自己的 JPEG 或 PNG。');
      const blob = await response.blob();
      const file = new File([blob], 'demo-portrait.png', { type: 'image/png' });
      await createFromPhoto(file, '合成肖像 · 体验项目');
      notify('success', '合成示例已通过导入接口创建为项目。');
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '合成示例导入失败。');
    } finally {
      setBusy(null);
    }
  };

  const saveAnnotations = async (): Promise<Project> => {
    if (activeProposal) throw new Error('当前正在审阅建议草稿；请使用“保存建议修改”，避免写入正式标注。');
    if (!currentProject) throw new Error('请先打开一个项目。');
    if (!dirty) return currentProject;
    setBusy('save');
    try {
      const project = await api.saveRegions(currentProject.id, currentProject.revision, regions);
      setCurrentProject(project);
      setRegions(project.regions); resetHistory(project.regions, project.regions[0]?.id ?? null);
      savedRegionsRef.current = JSON.stringify(project.regions);
      setSelectedRegionId(id => project.regions.some(region => region.id === id) ? id : project.regions[0]?.id ?? null);
      notify('success', '标注已保存到项目。');
      return project;
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      const message = apiError?.code.toLowerCase().includes('conflict') || apiError?.code.toLowerCase().includes('revision')
        ? `保存冲突：${error instanceof Error ? error.message : '项目修订已变化。'} 本地修改仍保留在当前页面；请先重新载入最新项目后再继续。`
        : error instanceof Error ? error.message : '标注保存失败。';
      notify('error', message);
      throw error;
    } finally {
      setBusy(null);
    }
  };

  const updateRegion = (id: string, update: Partial<Region>, options?: { recordHistory?: boolean }) => {
    const nextRegions = regions.map(region => region.id === id ? { ...region, ...update } : region);
    setRegions(nextRegions);
    const keys = Object.keys(update);
    const structural = keys.some(key => key === 'shapes' || key === 'kind' || key === 'feather' || key === 'context');
    if (options?.recordHistory ?? structural) {
      pushHistory(nextRegions, selectedRegionId);
    }
    if (activeProposal && update.kind) {
      setProposalDraft(current => {
        if (!current) return current;
        const existing = current.suggestions.some(item => item.regionId === id);
        if (update.kind === 'edit' && !existing) return { ...current, suggestions: [...current.suggestions, { regionId: id, reason: '用户新增编辑区域', enabled: true }] };
        if (update.kind === 'keep' && existing) return { ...current, suggestions: current.suggestions.filter(item => item.regionId !== id) };
        return current;
      });
    }
  };

  const deleteRegion = (id: string) => {
    const nextRegions = regions.filter(region => region.id !== id);
    const nextSelected = selectedRegionId === id ? null : selectedRegionId;
    setRegions(nextRegions);
    if (activeProposal) setProposalDraft(current => current ? { ...current, suggestions: current.suggestions.filter(item => item.regionId !== id) } : current);
    if (selectedRegionId === id) setSelectedRegionId(null);
    pushHistory(nextRegions, nextSelected);
  };

  const addRegion = (kind: AnnotationKind) => {
    const next: Region = {
      id: makeId(),
      name: kind === 'edit' ? `编辑区域 ${regions.filter(region => region.kind === 'edit').length + 1}` : `保护区域 ${regions.filter(region => region.kind === 'keep').length + 1}`,
      kind,
      intent: '',
      feather: 0,
      shapes: [],
    };
    const nextRegions = [...regions, next];
    setRegions(nextRegions);
    if (activeProposal && kind === 'edit') setProposalDraft(current => current ? { ...current, suggestions: [...current.suggestions, { regionId: next.id, reason: '用户新增编辑区域', enabled: true }] } : current);
    setSelectedRegionId(next.id);
    setAnnotationKind(kind);
    setTool('brush');
    setTab('annotate');
    pushHistory(nextRegions, next.id);
  };

  const pushHistory = (nextRegions: Region[], nextSelected: string | null = selectedRegionId) => {
    if (!annotateHistoryRef.current) annotateHistoryRef.current = new AnnotateHistory({ regions: nextRegions, selectedRegionId: nextSelected });
    else annotateHistoryRef.current.push({ regions: nextRegions, selectedRegionId: nextSelected });
    setHistoryTick(value => value + 1);
  };

  const resetHistory = (nextRegions: Region[], nextSelected: string | null) => {
    if (!annotateHistoryRef.current) annotateHistoryRef.current = new AnnotateHistory({ regions: nextRegions, selectedRegionId: nextSelected });
    else annotateHistoryRef.current.replacePresent({ regions: nextRegions, selectedRegionId: nextSelected });
    setHistoryTick(value => value + 1);
  };

  const applyHistorySnapshot = (snapshot: AnnotateSnapshot) => {
    skipHistoryRef.current = true;
    setRegions(snapshot.regions);
    setSelectedRegionId(snapshot.selectedRegionId);
    const region = snapshot.regions.find(item => item.id === snapshot.selectedRegionId);
    if (region) setAnnotationKind(region.kind);
    setHistoryTick(value => value + 1);
  };

  const undoAnnotate = () => {
    const snapshot = annotateHistoryRef.current?.undo();
    if (!snapshot) { notify('info', '没有可撤销的标注步骤。'); return; }
    applyHistorySnapshot(snapshot);
  };

  const redoAnnotate = () => {
    const snapshot = annotateHistoryRef.current?.redo();
    if (!snapshot) { notify('info', '没有可重做的标注步骤。'); return; }
    applyHistorySnapshot(snapshot);
  };

  const addShape = (regionId: string | null, kind: AnnotationKind, shape: Shape, options?: { replaceLast?: boolean }) => {
    setShowMasks(true);
    if (regionId && regions.some(region => region.id === regionId)) {
      const nextRegions = regions.map(region => {
        if (region.id !== regionId) return region;
        if (options?.replaceLast && region.shapes.length) {
          return { ...region, shapes: [...region.shapes.slice(0, -1), shape] };
        }
        return { ...region, shapes: [...region.shapes, shape] };
      });
      setRegions(nextRegions);
      setSelectedRegionId(regionId);
      pushHistory(nextRegions, regionId);
      return;
    }
    const next: Region = {
      id: makeId(),
      name: `${kind === 'edit' ? '编辑' : '保护'}区域 ${regions.filter(region => region.kind === kind).length + 1}`,
      kind,
      intent: '',
      feather: 0,
      shapes: [shape],
    };
    const nextRegions = [...regions, next];
    setRegions(nextRegions);
    if (activeProposal && kind === 'edit') setProposalDraft(current => current ? { ...current, suggestions: [...current.suggestions, { regionId: next.id, reason: '用户新增编辑区域', enabled: true }] } : current);
    setSelectedRegionId(next.id);
    setAnnotationKind(kind);
    pushHistory(nextRegions, next.id);
  };

  const undoShape = () => {
    if (!selectedRegion) return;
    const nextShapes = selectedRegion.shapes.slice(0, -1);
    const nextRegions = regions.map(region => region.id === selectedRegion.id ? { ...region, shapes: nextShapes } : region);
    setRegions(nextRegions);
    pushHistory(nextRegions, selectedRegion.id);
  };

  const applyMorphology = (op: MorphOp) => {
    if (!currentProject || !selectedRegion || proposalReadOnly) return;
    if (!selectedRegion.shapes.length && op !== 'invert') {
      notify('info', '当前区域还没有形状，无法扩张或收缩。');
      return;
    }
    const result = morphRegionShapes(selectedRegion, currentProject.width, currentProject.height, op, morphRadius);
    updateRegion(selectedRegion.id, { shapes: result.shapes });
    setShowMasks(true);
    if (result.empty) {
      notify('info', op === 'contract' ? '收缩后选区已清空。' : '形态学结果为空。');
      return;
    }
    const label = op === 'expand' ? '扩张' : op === 'contract' ? '收缩' : '反选';
    notify('success', `${label}完成：${result.beforePixels.toLocaleString()} → ${result.afterPixels.toLocaleString()} px（半径 ${morphRadius}）。`);
  };

  const importCandidate = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !currentProject || !selectedRegion || activeProposal) return;
    setBusy('candidate');
    setFlash(null);
    try {
      if (!['image/jpeg', 'image/png'].includes(file.type)) throw new Error('候选图必须是 JPEG 或 PNG。');
      const imageDataUrl = await fileToDataUrl(file);
      await validateImageSize(imageDataUrl, currentProject.width, currentProject.height);
      const saved = dirty ? await saveAnnotations() : currentProject;
      const project = await api.createCandidate(currentProject.id, {
        revision: saved.revision,
        baseVersionId: currentProject.baseVersionId,
        regionId: selectedRegion.id,
        imageDataUrl,
        name: file.name.replace(/\.[^.]+$/, ''),
      });
      const created = project.versions.filter(version => version.status === 'candidate').at(-1);
      setCurrentProject(project);
      setRegions(project.regions); resetHistory(project.regions, project.regions[0]?.id ?? null);
      savedRegionsRef.current = JSON.stringify(project.regions);
      if (created) setSelectedVersionId(created.id);
      setIsComparing(false);
      await refreshProjects();
      if (created?.validation) {
        notify(created.validation.passed ? 'success' : 'error', `候选范围检查${created.validation.passed ? '通过' : '未通过'}。这是像素范围报告，不代表视觉质量通过。`);
      } else {
        notify('info', '候选已导入，服务端尚未返回像素范围检查报告。');
      }
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '候选导入失败。');
    } finally {
      setBusy(null);
    }
  };

  const rejectCandidate = async (version: Version) => {
    if (!currentProject || activeProposal || dirty) return;
    setBusy('reject');
    try {
      const project = await api.rejectVersion(currentProject.id, currentProject.revision, version.id);
      setCurrentProject(project);
      notify('success', '候选已拒绝，图像与历史仍保留，当前基准未改变。');
    } catch (error) { notify('error', error instanceof Error ? error.message : '拒绝候选失败。'); }
    finally { setBusy(null); }
  };

  const acceptCandidate = async (version: Version) => {
    if (!currentProject || activeProposal) return;
    if (dirty) {
      notify('error', '当前有未保存标注。保存会更新修订，使此候选不再对应当前标注；请先放弃本地改动，或重新导入候选后再接受。');
      return;
    }
    if (version.annotationRevision !== currentProject.revision || version.baseVersionId !== currentProject.baseVersionId) {
      notify('error', '候选对应的基准或标注修订已经过期；请按当前标注重新导入候选。');
      return;
    }
    setBusy('accept');
    setFlash(null);
    try {
      const project = await api.acceptVersion(currentProject.id, currentProject.revision, version.id);
      replaceProject(project, version.id);
      setTab('retouch');
      setIsComparing(false);
      await refreshProjects();
      notify('success', '候选已设为接受版本。');
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '接受候选失败。');
    } finally {
      setBusy(null);
    }
  };

  const showMergedPlanCandidate = useCallback(async (items: PlanJob[]) => {
    const projectId = currentProject?.id;
    const active = activeProposalRef.current;
    const candidateJob = [...items].reverse().find(job => job.proposalId && job.status === 'candidate' && job.versionId && !surfacedPlanCandidatesRef.current.has(job.id)
      && (!active || active.status === 'confirmed' && active.id === job.proposalId && active.confirmation?.id === job.confirmationId));
    const reviewingSameConfirmedPlan = active?.status === 'confirmed' && active.id === candidateJob?.proposalId && active.confirmation?.id === candidateJob?.confirmationId;
    if (!projectId || !candidateJob || surfacingPlanCandidatesRef.current.has(candidateJob.id) || active && !reviewingSameConfirmedPlan || draftDirtyRef.current) return;
    surfacingPlanCandidatesRef.current.add(candidateJob.id);
    try {
      const project = await api.getProject(projectId);
      const currentActive = activeProposalRef.current;
      const stillSameConfirmedPlan = currentActive?.status === 'confirmed' && currentActive.id === candidateJob.proposalId && currentActive.confirmation?.id === candidateJob.confirmationId;
      if (currentProjectIdRef.current !== projectId || currentActive && !stillSameConfirmedPlan || draftDirtyRef.current) return;
      if (!project.versions.some(version => version.id === candidateJob.versionId)) throw new Error('计划任务报告了候选版本，但项目读取中尚未包含该资产。');
      surfacedPlanCandidatesRef.current.add(candidateJob.id);
      setCurrentProject(project);
      setRegions(project.regions); resetHistory(project.regions, project.regions[0]?.id ?? null);
      savedRegionsRef.current = JSON.stringify(project.regions);
      setSelectedRegionId(project.regions[0]?.id ?? null);
      setSelectedVersionId(candidateJob.versionId ?? null);
      setIsComparing(false);
      if (stillSameConfirmedPlan) {
        setActiveProposal(null);
        setProposalDraft(null);
        savedProposalDraftRef.current = '';
      }
      setTab('retouch');
      let projectListNotice = '';
      try { await refreshProjects(); }
      catch (listError) { projectListNotice = `最近项目列表未能更新：${listError instanceof Error ? listError.message : '未知错误'}。`; }
      notify(projectListNotice ? 'info' : 'success', `已载入计划生成的合并候选。请检查范围报告与照片效果后再决定是否接受。${projectListNotice}`);
    } catch (error) {
      notify('error', `读取计划合并候选失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      surfacingPlanCandidatesRef.current.delete(candidateJob.id);
    }
  }, [currentProject?.id, notify, refreshProjects]);

  const refreshJobs = useCallback(async () => {
    if (!currentProject) return;
    try {
      const result = await api.getJobs(currentProject.id);
      setJobs(result);
      await showMergedPlanCandidate(result);
    } catch (error) {
      notify('error', `读取本地任务失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }, [currentProject, notify, showMergedPlanCandidate]);

  useEffect(() => {
    if (!currentProject || tab !== 'collab' || !watchedConfirmedProposalId) return;
    let live = true;
    const loadPlanJobs = async () => {
      try {
        const result = await api.getJobs(currentProject.id);
        if (!live) return;
        setJobs(result);
        await showMergedPlanCandidate(result);
      } catch (error) {
        if (live) notify('error', `读取确认计划任务失败：${error instanceof Error ? error.message : '未知错误'}`);
      }
    };
    void loadPlanJobs();
    const interval = window.setInterval(() => { void loadPlanJobs(); }, 3000);
    return () => { live = false; window.clearInterval(interval); };
  }, [currentProject?.id, tab, watchedConfirmedProposalId, showMergedPlanCandidate, notify]);

  useEffect(() => {
    if (!currentProject || tab !== 'jobs') return;
    let live = true;
    const load = async () => {
      try {
        const result = await api.getJobs(currentProject.id);
        if (live) {
          setJobs(result);
          await showMergedPlanCandidate(result);
        }
      } catch (error) {
        if (live) notify('error', `读取本地任务失败：${error instanceof Error ? error.message : '未知错误'}`);
      }
    };
    void load();
    const interval = window.setInterval(() => { void load(); }, hasActiveJobs ? 3000 : 15000);
    return () => { live = false; window.clearInterval(interval); };
  }, [currentProject?.id, tab, hasActiveJobs, notify, showMergedPlanCandidate]);

  const startLocalJob = async () => {
    if (activeProposal) {
      notify('error', '建议草稿不能直接提交生成；先确认计划，再由 Agent 按确认记录续跑。');
      return;
    }
    if (!currentProject || !selectedRegion || selectedRegion.kind !== 'edit' || !selectedRegion.shapes.length) return;
    if (!capabilities?.qwen.available) return;
    setBusy('job');
    setFlash(null);
    try {
      const unresolved = getPendingJobSubmissions(currentProject.id);
      setPendingJobs(unresolved);
      if (unresolved.length) {
        setTab('jobs');
        notify('info', '已有任务提交状态待核对。先用任务页的原幂等键核对，避免重复生成。');
        return;
      }
      const saved = dirty ? await saveAnnotations() : currentProject;
      const job = await api.createJob(saved.id, saved.revision, selectedRegion.id);
      refreshPendingJobs(saved.id);
      setJobs(current => [job, ...current.filter(item => item.id !== job.id)]);
      setTab('jobs');
      notify('success', '本地任务已提交；状态将从服务端查询。');
    } catch (error) {
      let pending: PendingJobSubmission[] = [];
      try {
        pending = getPendingJobSubmissions(currentProject.id);
        setPendingJobs(pending);
        setPendingJobsError('');
      } catch (storageError) {
        const message = storageError instanceof Error ? storageError.message : '待核对任务记录无法读取。';
        setPendingJobsError(message);
        notify('error', message);
        return;
      }
      if (pending.length) {
        setTab('jobs');
        notify('error', `任务提交状态待核对：${error instanceof Error ? error.message : '连接中断'}。原幂等键已保存在本次浏览器会话；核对时会复用，不会自动换键或创建第二个任务。`);
      } else {
        notify('error', error instanceof Error ? error.message : '本地任务提交失败。');
      }
    } finally {
      setBusy(null);
    }
  };

  const verifyPendingJob = async (submission: PendingJobSubmission) => {
    setBusy('job-check');
    try {
      const job = await api.createJob(submission.projectId, submission.revision, submission.regionId);
      setPendingJobs(getPendingJobSubmissions(currentProject?.id));
      setPendingJobsError('');
      if (currentProject?.id === submission.projectId) {
        setJobs(current => [job, ...current.filter(item => item.id !== job.id)]);
        setTab('jobs');
      }
      notify('success', `服务端已确认同一幂等请求（任务 ${job.id.slice(0, 8)}）；不会重复创建任务。`);
    } catch (error) {
      let stillPending = false;
      try {
        const pending = getPendingJobSubmissions(currentProject?.id);
        setPendingJobs(pending);
        stillPending = pending.some(item => item.idempotencyKey === submission.idempotencyKey);
      } catch (storageError) {
        const message = storageError instanceof Error ? storageError.message : '待核对任务记录无法读取。';
        setPendingJobsError(message);
        notify('error', message);
        return;
      }
      if (stillPending) notify('error', `任务仍待核对：${error instanceof Error ? error.message : '服务端暂未确认'}。下一次核对仍使用原幂等键。`);
      else notify('error', `服务端已明确拒绝该任务：${error instanceof Error ? error.message : '任务未提交'}。待核对记录已清除。`);
    } finally {
      setBusy(null);
    }
  };

  const selectProposal = async (proposalId: string) => {
    if (!currentProject) return;
    if (activeProposal && activeProposal.id !== proposalId) {
      notify('error', '请先退出当前建议审阅，再打开另一份建议，避免画布显示与列表选择混淆。');
      return;
    }
    setBusy('proposal-load');
    setProposalError('');
    try {
      const proposal = await api.getProposal(currentProject.id, proposalId);
      if (proposal.projectId !== currentProject.id) throw new Error('该建议不属于当前项目。');
      rememberProposal(proposal);
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法读取建议。';
      setProposalError(`读取建议失败：${message}`);
      notify('error', `读取建议失败：${message}`);
    } finally {
      setBusy(null);
    }
  };

  const startProposalEditing = (proposal: EditProposal) => {
    if (dirty && !activeProposal) {
      notify('error', '正式标注有未保存修改。请先保存或明确放弃，再进入建议审阅。');
      return;
    }
    if (activeProposal && activeProposal.id !== proposal.id && dirty) {
      notify('error', '当前建议有未保存修改。先保存或退出并明确放弃，再切换。');
      return;
    }
    enterProposalEditor(proposal);
  };

  const saveProposalChanges = async (quiet = false): Promise<EditProposal> => {
    if (!currentProject || !activeProposal || !proposalDraft) throw new Error('请先载入一份可编辑的建议。');
    if (activeProposal.status !== 'draft') throw new Error('此建议已过期或已确认，不能继续修改。');
    const body = {
      revision: activeProposal.revision,
      title: proposalDraft.title,
      goal: proposalDraft.goal,
      backend: proposalDraft.backend,
      regions,
      suggestions: proposalDraft.suggestions,
    };
    setBusy('proposal-save');
    try {
      const updated = await api.patchProposal(currentProject.id, activeProposal.id, body);
      const fields = proposalPayload(updated);
      setActiveProposal(updated);
      setProposalDraft(fields);
      setRegions(updated.regions);
      savedProposalDraftRef.current = proposalSnapshotFor(fields, updated.regions);
      rememberProposal(updated);
      setProposalError('');
      if (!quiet) notify('success', '建议修改已保存为草稿，正式标注尚未改变。');
      return updated;
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      const conflict = apiError?.code.toLowerCase().includes('conflict') || apiError?.code.toLowerCase().includes('revision');
      const message = error instanceof Error ? error.message : '建议保存失败。';
      const detail = conflict ? `保存冲突：${message} 当前画布草稿仍保留；刷新建议后核对服务端修订。` : `保存建议失败：${message} 当前画布草稿仍保留。`;
      setProposalError(detail);
      if (!quiet) notify('error', detail);
      throw error;
    } finally {
      setBusy(null);
    }
  };

  const cancelProposal = async (proposal: EditProposal) => {
    if (!currentProject) return;
    if (activeProposal?.id === proposal.id && dirty) {
      notify('error', '此建议有未保存修改。先保存或明确放弃，再取消建议。');
      return;
    }
    setBusy('proposal-cancel');
    setProposalError('');
    try {
      const cancelled = await api.cancelProposal(currentProject.id, proposal.id, proposal.revision);
      rememberProposal(cancelled);
      if (activeProposal?.id === proposal.id) {
        setActiveProposal(null);
        setProposalDraft(null);
        savedProposalDraftRef.current = '';
        setRegions(currentProject.regions); resetHistory(currentProject.regions, currentProject.regions[0]?.id ?? selectedRegionId);
        savedRegionsRef.current = JSON.stringify(currentProject.regions);
        setSelectedRegionId(currentProject.regions[0]?.id ?? null);
      }
      notify('success', '建议已取消；正式标注未改变。');
    } catch (error) {
      const message = error instanceof Error ? error.message : '取消建议失败。';
      setProposalError(`取消建议失败：${message}`);
      notify('error', `取消建议失败：${message}`);
    } finally {
      setBusy(null);
    }
  };

  const toggleProposalSuggestion = (regionId: string) => {
    setProposalDraft(current => current ? {
      ...current,
      suggestions: current.suggestions.map(item => item.regionId === regionId ? { ...item, enabled: !item.enabled } : item),
    } : current);
  };

  const updateProposalDraft = (update: Partial<ProposalDraftFields>) => {
    setProposalDraft(current => current ? { ...current, ...update } : current);
  };

  const exitProposal = async (discard = false) => {
    if (!currentProject || !activeProposal) return;
    const projectId = currentProject.id;
    setBusy('proposal-exit');
    setProposalError('');
    try {
      if (!discard && dirty) {
        await saveProposalChanges(true);
        setBusy('proposal-exit');
      }
      const freshProject = await api.getProject(projectId);
      if (currentProjectIdRef.current !== projectId) return;
      setCurrentProject(freshProject);
      setRegions(freshProject.regions); resetHistory(freshProject.regions, freshProject.regions[0]?.id ?? null);
      savedRegionsRef.current = JSON.stringify(freshProject.regions);
      setSelectedRegionId(freshProject.regions[0]?.id ?? null);
      setSelectedProposalId(activeProposal.id);
      setActiveProposal(null);
      setProposalDraft(null);
      savedProposalDraftRef.current = '';
      setAnnotationKind('edit');
      setShowMasks(true);
      setTab('annotate');
      setProposalExitPrompt(false);
      notify(discard ? 'info' : 'success', discard ? '已放弃本页未保存的建议改动，正式标注保持原样。' : '已退出建议并载入最新正式标注。');
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法退出建议。';
      setProposalError(`退出建议失败：${message} 当前建议草稿仍留在页面。`);
      notify('error', `退出建议失败：${message} 当前建议草稿仍留在页面。`);
    } finally {
      setBusy(null);
    }
  };

  const requestProposalExit = () => {
    if (dirty) setProposalExitPrompt(true);
    else void exitProposal(false);
  };

  const confirmProposal = async () => {
    if (!currentProject || !activeProposal || !proposalDraft) return;
    if (activeProposal.status !== 'draft') {
      notify('error', '此建议已过期或已处理，不能确认。');
      return;
    }
    setBusy('proposal-confirm');
    setProposalError('');
    let saved = activeProposal;
    try {
      if (dirty) saved = await saveProposalChanges(true);
      setBusy('proposal-confirm');
      const freshProject = await api.getProject(currentProject.id);
      setCurrentProject(freshProject);
      if (freshProject.revision !== saved.projectRevision || freshProject.baseVersionId !== saved.baseVersionId) {
        setActiveProposal(current => current?.id === saved.id ? { ...current, status: 'stale' } : current);
        const stale = { ...saved, status: 'stale' as const };
        rememberProposal(stale);
        throw new Error('正式项目已发生变化。这份建议已失效，请让 Agent 基于当前修订重新创建。');
      }
      const confirmed = await api.confirmProposal(currentProject.id, saved.id, saved.revision, freshProject.revision);
      const fields = proposalPayload(confirmed);
      setActiveProposal(confirmed);
      setProposalDraft(fields);
      setRegions(confirmed.regions);
      savedProposalDraftRef.current = proposalSnapshotFor(fields, confirmed.regions);
      rememberProposal(confirmed);
      let updatedProject: Project;
      try {
        updatedProject = await api.getProject(currentProject.id);
      } catch (readbackError) {
        setProposalError(`计划已确认（${confirmed.confirmation?.id ?? '已记录'}），但无法读取更新后的正式项目：${readbackError instanceof Error ? readbackError.message : '未知错误'}。当前画布保留确认快照，请退出建议后重试读取。`);
        notify('error', `计划已确认，但正式项目读取失败。确认编号：${confirmed.confirmation?.id ?? '服务端未返回编号'}。`);
        return;
      }
      setCurrentProject(updatedProject);
      setRegions(updatedProject.regions); resetHistory(updatedProject.regions, updatedProject.regions[0]?.id ?? null);
      savedRegionsRef.current = JSON.stringify(updatedProject.regions);
      setSelectedRegionId(updatedProject.regions[0]?.id ?? null);
      setActiveProposal(null);
      setProposalDraft(null);
      savedProposalDraftRef.current = '';
      setProposalError('');
      let projectListNotice = '';
      try { await refreshProjects(); }
      catch (listError) { projectListNotice = `项目列表未能更新：${listError instanceof Error ? listError.message : '未知错误'}。`; }
      notify(projectListNotice ? 'info' : 'success', `计划已确认，Agent 可继续执行。确认编号：${confirmed.confirmation?.id ?? '服务端未返回编号'}。${projectListNotice}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : '计划确认失败。';
      setProposalError(`确认计划失败：${message} 草稿仍保留。`);
      notify('error', `确认计划失败：${message} 草稿仍保留。`);
    } finally {
      setBusy(null);
    }
  };

  const executeConfirmedPlan = async () => {
    if (!currentProject) return;
    const proposal = activeProposal ?? proposals.find(item => item.id === selectedProposalId) ?? null;
    if (!proposal || proposal.status !== 'confirmed' || !proposal.confirmation) {
      setPlanExecutionError('只有服务端记录为已确认的建议才能执行。');
      return;
    }
    if (dirty) {
      setPlanExecutionError('存在未保存修改。请先保存或放弃当前改动，再执行确认快照。');
      return;
    }
    setBusy('plan-job');
    setPlanExecutionError('');
    try {
      const latestProposal = await api.getProposal(currentProject.id, proposal.id);
      rememberProposal(latestProposal);
      if (latestProposal.status !== 'confirmed' || !latestProposal.confirmation || latestProposal.confirmation.id !== proposal.confirmation.id) {
        throw new Error(latestProposal.status === 'stale' ? '建议已过期，不能执行。' : '服务端确认状态或确认编号已变化，请刷新并核对后再执行。');
      }
      if (latestProposal.backend !== proposal.backend) throw new Error('已确认计划的处理后端已变化，请刷新后重新核对。');

      const freshProject = await api.getProject(currentProject.id);
      if (freshProject.revision !== latestProposal.confirmation.projectRevision) throw new Error('正式项目修订已变化，这份确认已不能用于执行。');
      if (draftDirtyRef.current) throw new Error('执行前检测到本地改动，请先保存或放弃后再试。');

      // Return the canvas to the formal, confirmed annotation snapshot before
      // showing jobs or refreshing a completed candidate.
      setCurrentProject(freshProject);
      setRegions(freshProject.regions); resetHistory(freshProject.regions, freshProject.regions[0]?.id ?? null);
      savedRegionsRef.current = JSON.stringify(freshProject.regions);
      setSelectedRegionId(freshProject.regions[0]?.id ?? null);
      setActiveProposal(null);
      setProposalDraft(null);
      savedProposalDraftRef.current = '';

      const knownJobs = await api.getJobs(currentProject.id);
      const existing = knownJobs.find(job => job.proposalId === latestProposal.id && job.confirmationId === latestProposal.confirmation?.id);
      const hasPendingSubmission = pendingPlanJobs.some(item => item.projectId === currentProject.id && item.proposalId === latestProposal.id && item.confirmationId === latestProposal.confirmation?.id);
      let grantId: string | undefined;
      if (latestProposal.backend === 'gpt' && !existing) {
        grantId = pendingPlanJobs.find(item => item.projectId === currentProject.id && item.proposalId === latestProposal.id && item.confirmationId === latestProposal.confirmation?.id)?.grantId
          ?? (selectedExecutionGrant?.proposalId === latestProposal.id ? selectedExecutionGrant.grantId : undefined);
        if (!hasPendingSubmission && !gptTargetMatchesConfirmation) throw new Error(capabilities?.gpt.reason || '此确认计划的远端处理目的地或模型已变化，不能执行。');
        if (!grantId) throw new Error('请选择一项匹配此确认计划的有效 GPT generation 授权。');
        if (!hasPendingSubmission && !matchingGptGrants.some(grant => grant.id === grantId)) throw new Error('所选 GPT 授权已撤销、过期、额度耗尽或不匹配当前照片/目的地，请刷新授权后重新选择。');
      }
      if (!existing && latestProposal.backend === 'qwen' && !capabilities?.qwen.available && !hasPendingSubmission) throw new Error(capabilities?.qwen.reason || capabilitiesError || '本地 Qwen 当前不可用。');
      const job = existing ?? await api.createPlanJob(currentProject.id, latestProposal.id, latestProposal.confirmation.id, grantId);
      if (selectedExecutionGrant?.proposalId === latestProposal.id) setSelectedExecutionGrant(null);
      setJobs(current => [job, ...current.filter(item => item.id !== job.id)]);
      refreshPendingPlanJobs(currentProject.id);
      setPlanExecutionError('');
      setTab('jobs');
      notify('success', existing ? '已载入这份确认计划的既有任务，不会重复提交。' : '计划任务已提交；后续重试将复用相同幂等键。');
    } catch (error) {
      const message = error instanceof Error ? error.message : '计划任务提交失败。';
      let retryNote = '';
      try {
        const pending = getPendingPlanJobSubmissions(currentProject.id).find(item => item.proposalId === proposal.id && item.confirmationId === proposal.confirmation?.id);
        if (pending) retryNote = ` 可使用原幂等键${pending.grantId ? '和原授权' : ''}继续核对，不会替换。`;
      } catch { /* The storage error is already surfaced by the original request. */ }
      setPlanExecutionError(`${message}${retryNote}`);
      refreshPendingPlanJobs(currentProject.id);
      notify('error', `计划执行未能确认：${message}${retryNote}`);
    } finally {
      setBusy(null);
    }
  };

  const saveCurrentChanges = async () => {
    if (activeProposal) { await saveProposalChanges(); return; }
    await saveAnnotations();
  };

  const annotationText = async () => {
    if (!currentProject) throw new Error('请先打开照片项目。');
    const saved = dirty ? await saveAnnotations() : currentProject;
    return JSON.stringify(await api.getAnnotations(saved.id), null, 2);
  };

  const showAnnotationJson = async () => {
    setMenuOpen(false); setBusy('annotations');
    try { setJsonText(await annotationText()); setJsonDialogType('annotations'); setJsonDialog(true); }
    catch (error) { notify('error', error instanceof Error ? error.message : '读取 JSON 失败。'); }
    finally { setBusy(null); }
  };

  const copyAnnotationJson = async () => {
    try {
      await navigator.clipboard.writeText(jsonText);
      notify('success', jsonDialogType === 'proposal' ? '计划 JSON 已复制；确认信息仅供查询，不会授予执行权限。' : '标注 JSON 已复制，可直接交给 Agent。');
    } catch { notify('error', '浏览器未允许剪贴板访问，请在文本框内全选复制。'); }
  };

  const copyProposalDocument = async () => {
    if (!currentProject) return;
    let proposal = activeProposal ?? proposals.find(item => item.id === selectedProposalId) ?? null;
    if (!proposal) { notify('error', '请先选择一份建议。'); return; }
    setBusy('proposal-document');
    try {
      if (activeProposal && dirty) {
        if (activeProposal.status !== 'draft') throw new Error('此建议已处理，不能保存本地改动后导出。');
        proposal = await saveProposalChanges(true);
        setBusy('proposal-document');
      }
      const document = await api.getProposalDocument(currentProject.id, proposal.id);
      const text = JSON.stringify(document, null, 2);
      setJsonText(text);
      setJsonDialogType('proposal');
      try {
        await navigator.clipboard.writeText(text);
        notify('success', '计划 JSON 已复制。确认信息只用于查询，不会在导入时授权执行。');
      } catch {
        setJsonDialog(true);
        notify('info', '剪贴板不可用，已打开计划 JSON，可在文本框中全选复制。');
      }
    } catch (error) {
      notify('error', `计划 JSON 准备失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setBusy(null);
    }
  };

  const exportFile = async (kind: 'export' | 'annotations') => {
    if (!currentProject) return;
    setMenuOpen(false); setBusy(kind);
    try {
      if (kind === 'export') await downloadBlob(api.projectFile(currentProject.id, 'export'), `${safeFilename(currentProject.name)}.png`);
      else {
        const blob = new Blob([await annotationText()], { type: 'application/json' });
        const url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url; link.download = `${safeFilename(currentProject.name)}.maskcanvas.json`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      notify('success', kind === 'export' ? 'PNG 已导出。' : '标注 JSON 已导出，不包含图片字节。');
    } catch (error) { notify('error', error instanceof Error ? error.message : '导出失败。'); }
    finally { setBusy(null); }
  };

  const currentToolButtons = [
    { id: 'select' as Tool, label: '选择', shortcut: 'V', icon: Cursor },
    { id: 'brush' as Tool, label: '画笔', shortcut: 'B', icon: PaintBrush },
    { id: 'erase' as Tool, label: '擦除', shortcut: 'E', icon: Eraser },
    { id: 'rect' as Tool, label: '矩形', shortcut: 'R', icon: Rectangle },
    { id: 'magnetic' as Tool, label: '套索', shortcut: 'L', icon: Magnet },
    { id: 'suggest' as Tool, label: '建议', shortcut: 'G', icon: MagicWand },
    { id: 'move' as Tool, label: '移动', shortcut: 'H', icon: Hand },
  ];

  useEffect(() => {
    const saveShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || page !== 'editor') return;
      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        if (dirty && busy !== 'save' && busy !== 'proposal-save') void saveCurrentChanges().catch(() => { /* Save handlers report the error and preserve the draft. */ });
        return;
      }
      if (key === 'z' && !proposalReadOnly) {
        event.preventDefault();
        if (event.shiftKey) redoAnnotate();
        else undoAnnotate();
      }
    };
    window.addEventListener('keydown', saveShortcut);
    return () => window.removeEventListener('keydown', saveShortcut);
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (target.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key.toLowerCase() === 'm' && page === 'editor') { setShowMasks(value => !value); return; }
      if ((event.key === '?' || (event.shiftKey && event.key === '/')) && page === 'editor') { event.preventDefault(); setShowCheatSheet(value => !value); return; }
      const keys: Record<string, Tool> = { v: 'select', b: 'brush', e: 'erase', r: 'rect', l: 'magnetic', g: 'suggest', h: 'move' };
      const next = keys[event.key.toLowerCase()];
      if (next && page === 'editor') { setTool(next); if (['brush', 'erase', 'magnetic', 'suggest'].includes(next)) setShowMasks(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [page]);

  const saveStateLabel = busy === 'save' || busy === 'proposal-save' ? '正在保存…' : dirty ? activeProposal ? '建议有未保存修改' : '有未保存标注' : activeProposal ? '建议草稿已保存' : '已保存';
  const executionJob = reviewProposal?.confirmation ? jobs.find(job => job.proposalId === reviewProposal.id && job.confirmationId === reviewProposal.confirmation?.id) ?? null : null;
  const pendingPlanSubmissionRecord = reviewProposal?.confirmation ? pendingPlanJobs.find(item => item.projectId === currentProject?.id && item.proposalId === reviewProposal.id && item.confirmationId === reviewProposal.confirmation?.id) ?? null : null;
  const pendingPlanSubmission = Boolean(pendingPlanSubmissionRecord);
  const confirmedGptTarget = reviewProposal?.confirmation?.processing;
  const configuredGptTarget = projectPermissions?.processing.gpt;
  const gptTargetMatchesConfirmation = Boolean(reviewProposal?.backend === 'gpt' && confirmedGptTarget
    && configuredGptTarget?.destination === confirmedGptTarget.destination
    && configuredGptTarget.modelId === confirmedGptTarget.modelId
    && capabilities?.gpt.available
    && capabilities.gpt.destination === confirmedGptTarget.destination
    && capabilities.gpt.modelId === confirmedGptTarget.modelId
    && projectPermissions?.remoteGenerationEnabled
    && currentProject?.baseVersionId === reviewProposal?.confirmation?.baseVersionId);
  const matchingGptGrants = gptTargetMatchesConfirmation && reviewProposal?.confirmation
    ? (projectPermissions?.grants ?? []).filter(grant => grant.purpose === 'generation'
      && grant.backend === 'gpt'
      && grant.destination === confirmedGptTarget?.destination
      && grant.baseVersionId === reviewProposal.confirmation?.baseVersionId
      && !grant.revokedAt
      && (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now())
      && (grant.maxJobs === undefined || grant.consumedJobs < grant.maxJobs))
    : [];
  const selectedGrantId = reviewProposal
    ? selectedExecutionGrant?.proposalId === reviewProposal.id ? selectedExecutionGrant.grantId : pendingPlanSubmissionRecord?.grantId ?? executionJob?.grantId ?? ''
    : '';
  const proposalReadOnly = Boolean(activeProposal && activeProposal.status !== 'draft');

  const requestHome = () => {
    if (dirty) setLeavePrompt(true);
    else { setPage('projects'); setTab('retouch'); }
  };

  const discardAndLeave = () => {
    if (currentProject) {
      setRegions(currentProject.regions); resetHistory(currentProject.regions, currentProject.regions[0]?.id ?? selectedRegionId);
      savedRegionsRef.current = JSON.stringify(currentProject.regions);
      setSelectedRegionId(currentProject.regions[0]?.id ?? null);
    }
    setActiveProposal(null);
    setProposalDraft(null);
    savedProposalDraftRef.current = '';
    setLeavePrompt(false);
    setPage('projects');
    setTab('retouch');
  };

  const saveAndLeave = async () => {
    try {
      await saveCurrentChanges();
      setLeavePrompt(false);
      setPage('projects');
      setTab('retouch');
    } catch { /* The current draft stays open and the save error is shown in the toast. */ }
  };

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (loading) {
    return <main className="boot-screen"><div className="brand-mark">M</div><span>正在连接本地工作区</span></main>;
  }

  if (!sessionReady) {
    return (
      <main className="boot-screen boot-error">
        <div className="boot-error-card">
          <WarningCircle size={36} />
          <h1>无法连接 MaskCanvas</h1>
          <p>{sessionError || '本地服务暂不可用。'}</p>
          <button type="button" className="button button-dark" onClick={() => window.location.reload()}>重新连接</button>
        </div>
      </main>
    );
  }

  const showProjects = page === 'projects';

  return (
    <div className="app-shell">
      {page !== 'editor' ? (
        <div className="home-layout">
          <aside className="home-sidebar">
            <button className="brand-lockup" type="button" onClick={() => setPage('projects')} aria-label="MaskCanvas 项目入口">
              <span className="brand-mark">M</span><span>MaskCanvas</span>
            </button>
            <div className="side-nav">
              <button type="button" className={page === 'projects' ? 'side-nav-item active' : 'side-nav-item'} onClick={() => setPage('projects')}><ImageSquare size={20} />照片项目</button>
              <button type="button" className={page === 'packages' ? 'side-nav-item active' : 'side-nav-item'} onClick={() => setPage('packages')}><FileCode size={20} />JSON 交接</button>
              <button type="button" className={page === 'settings' ? 'side-nav-item active' : 'side-nav-item'} onClick={() => setPage('settings')}><GearSix size={20} />连接与设置</button>
            </div>
            <div className="side-bottom"><span className="local-indicator"><span />本地项目 · 原图始终保留</span></div>
          </aside>

          <main className="home-main">
            {showProjects ? (
              <>
                <header className="home-header">
                  <div><div className="eyebrow">LOCAL PHOTO WORKSPACE</div><h1>照片项目</h1><p>从一张照片开始，或接着上次的精修。</p></div>
                  <div className="home-actions">
                    <button type="button" className="button button-dark" onClick={() => photoInputRef.current?.click()} disabled={busy === 'import-photo'}><FolderSimplePlus size={18} />{busy === 'import-photo' ? '导入中…' : '导入照片'}</button>
                    <button type="button" className="button button-soft" onClick={loadDemo} disabled={busy === 'demo'}><Sparkle size={17} />{busy === 'demo' ? '正在读取示例…' : '体验合成示例'}</button>
                  </div>
                </header>
                <div className="mode-row" aria-label="工作方式">
                  <div className="mode-item mode-selected"><span className="mode-icon amber"><PaintBrush size={22} /></span><div><strong>人工标注</strong><span>手动画出编辑与保护范围</span></div><span className="mode-note">现在可用</span></div>
                  <div className="mode-item"><span className="mode-icon sage"><ArrowsLeftRight size={22} /></span><div><strong>协同精修</strong><span>连接 Agent 后共享标注和候选</span></div><span className="mode-note">依赖外部 Agent</span></div>
                  <div className="mode-item"><span className="mode-icon gray"><Sparkle size={22} /></span><div><strong>自主精修</strong><span>视觉识别能力按本机配置提供</span></div><span className="mode-note">能力状态见设置</span></div>
                </div>
                <section className="project-section">
                  <div className="section-heading"><h2>最近编辑</h2><span className="section-rule" /><button type="button" className="text-button" onClick={() => packageInputRef.current?.click()}><UploadSimple size={16} />导入标注 JSON</button></div>
                  {projects.length ? (
                    <div className="project-grid">
                      {projects.map(project => (
                        <button type="button" className="project-card" key={project.id} onClick={() => void openProject(project.id)} disabled={busy === 'open'}>
                          <div className="project-thumb">{assetThumb(project.id, project.baseAsset, `${project.name}原图`)}</div>
                          <div className="project-card-meta"><div><strong>{project.name}</strong><span>{project.versionCount} 个版本 · {project.regionCount} 个标注</span></div><DotsThree size={22} /></div>
                          <div className="project-card-foot"><span>{formatDimensions(project.width, project.height)}</span><span>{formatDate(project.updatedAt)}</span></div>
                        </button>
                      ))}
                      <button type="button" className="new-project-card" onClick={() => photoInputRef.current?.click()}><Plus size={22} /><strong>导入另一张照片</strong><span>JPEG 或 PNG</span></button>
                    </div>
                  ) : projectsLoading ? (
                    <div className="empty-projects project-loading"><div className="empty-project-art"><Clock size={28} /></div><h2>正在读取本地项目</h2><p>项目列表加载完成后会显示在这里。</p></div>
                  ) : (
                    <div className="empty-projects" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) { setBusy('import-photo'); void createFromPhoto(file).then(() => notify('success', '照片已导入为本地项目。')).catch(error => notify('error', error instanceof Error ? error.message : '照片导入失败。')).finally(() => setBusy(null)); } }}>
                      <div className="empty-project-art"><ImageSquare size={36} weight="light" /></div>
                      <h2>还没有照片项目</h2>
                      <p>拖入一张 JPEG 或 PNG，或使用合成示例开始体验。</p>
                      <div className="empty-actions"><button type="button" className="button button-dark" onClick={() => photoInputRef.current?.click()}><FolderSimplePlus size={17} />导入照片</button><button type="button" className="button button-soft" onClick={loadDemo}><Sparkle size={17} />体验合成示例</button></div>
                      <span className="drop-hint">照片保存在本地工作区 · 原图不会被覆盖</span>
                    </div>
                  )}
                </section>
                <footer className="home-footer"><span>MaskCanvas</span><span>本地编辑核心已连接 · 未配置的能力不会显示为可用</span></footer>
              </>
            ) : page === 'packages' ? (
              <section className="home-subpage">
                <div className="eyebrow">JSON WORKFLOW</div><h1>JSON 交接</h1><p>用一段 JSON 交换区域、意图、保护与图片引用。照片保留在工作区，不需要压缩包。</p>
                <div className="package-actions">
                  <button type="button" className="package-drop" onClick={() => packageInputRef.current?.click()}><FileCode size={34} /><strong>导入标注或计划 JSON</strong><span>核对图片与版本后载入。计划始终作为新草稿，不直接生成。</span><em><UploadSimple size={16} />选择 JSON 文件</em></button>
                  {currentProject && <button type="button" className="package-drop package-export" onClick={() => void showAnnotationJson()} disabled={busy === 'annotations'}><CloudArrowDown size={34} /><strong>查看 / 复制当前 JSON</strong><span>{currentProject.name} · 图片引用、原图坐标选区与意图</span><em><FileCode size={16} />查看 JSON</em></button>}
                </div>
                <label className="field-label json-paste-label">粘贴 Agent 返回的 JSON<textarea className="json-paste" value={jsonImportText} onChange={e => setJsonImportText(e.target.value)} placeholder="粘贴 maskcanvas.annotations 或 maskcanvas.proposal JSON…" spellCheck={false} /></label>
                <div className={`json-rebind-option ${currentProject ? '' : 'unavailable'}`}>
                  <label><input type="checkbox" checked={rebindJsonToCurrentPhoto} disabled={!currentProject || busy === 'import-annotations'} onChange={event => setRebindJsonToCurrentPhoto(event.target.checked)} /><span><strong>将此 JSON 绑定到当前照片</strong><small>核对规范图像像素哈希后创建新建议；导入的确认状态不会沿用。此操作必须对每份 JSON 单独勾选。</small></span></label>
                  {currentProject ? <div className="json-rebind-target">目标照片：<strong>{currentProject.name}</strong> · {formatDimensions(currentProject.width, currentProject.height)} · 基准 {currentProject.baseVersionId}</div> : <div className="json-rebind-target">请先导入或打开目标照片项目；当前没有可绑定的照片。</div>}
                </div>
                <button type="button" className="button button-dark" disabled={!jsonImportText.trim() || busy === 'import-annotations'} onClick={() => void pasteAnnotationJson()}>载入供审阅</button>
                <div className="privacy-note"><ShieldCheck size={20} /><span>JSON 不是照片本身。默认导入要求同一工作区、图片哈希与版本匹配；跨设备绑定必须先导入目标照片，再明确勾选上方选项。服务端按规范基准图像哈希校验，不会按尺寸相同推断照片一致，也不会按 JSON 路径访问文件或上传图片。</span></div>
              </section>
            ) : (
              <section className="home-subpage settings-page">
                <div className="eyebrow">CAPABILITY STATUS</div><h1>连接与设置</h1><p>以下状态直接来自本机能力接口；未配置的服务不会显示为在线。</p>
                <div className="settings-card"><div className="settings-card-head"><div><strong>处理能力</strong><span>设备与服务分别检测，不推断远端隐私边界。</span></div><span className="settings-tag">本机报告</span></div>
                  <CapabilityLine label="本地编辑核心" available={capabilities?.localCore ?? null} loading={capabilitiesLoading} reason={capabilitiesError || undefined} />
                  <CapabilityLine label="Qwen Image · 本地候选生成" available={capabilities?.qwen.available ?? null} loading={capabilitiesLoading} reason={capabilities?.qwen.reason ?? (capabilitiesError || undefined)} />
                  <CapabilityLine label="GPT Image · 候选生成" available={capabilities?.gpt.available ?? null} loading={capabilitiesLoading} reason={capabilities?.gpt.reason ?? (capabilitiesError || undefined)} />
                  <CapabilityLine label="视觉识别" available={capabilities?.vision.available ?? null} loading={capabilitiesLoading} reason={capabilities?.vision.reason ?? (capabilitiesError || undefined)} />
                </div>
                <div className="settings-note"><Info size={19} /><p>Codex、WorkBuddy、Qoder 等 Agent 的连接由各自客户端管理。此首版没有内置账号或连接状态检测，因此不会显示虚构的连接按钮或成功状态。</p></div>
              </section>
            )}
          </main>
        </div>
      ) : currentProject ? (
        <div className="editor-layout">
          <header className="editor-topbar">
            <button type="button" className="editor-brand" aria-label="返回项目入口" onClick={requestHome}><span className="brand-mark">M</span><span>MaskCanvas</span></button>
            <span className="header-divider" />
            <button type="button" className="project-crumb" onClick={requestHome}>{currentProject.name}<CaretDown size={14} /></button>
            <nav className="editor-tabs" aria-label="工作区">
              <button type="button" className={tab === 'retouch' ? 'editor-tab active' : 'editor-tab'} onClick={() => setTab('retouch')} disabled={Boolean(activeProposal)}>精修</button>
              <button type="button" className={tab === 'annotate' ? 'editor-tab active' : 'editor-tab'} onClick={() => setTab('annotate')} disabled={Boolean(activeProposal)}>标注</button>
              <button type="button" className={tab === 'collab' ? 'editor-tab active' : 'editor-tab'} onClick={() => setTab('collab')}>协作</button>
              <button type="button" className={tab === 'jobs' ? 'editor-tab active' : 'editor-tab'} onClick={() => setTab('jobs')} disabled={Boolean(activeProposal)}>任务{(hasPendingJob || jobs.some(job => ['queued', 'running', 'reconciling'].includes(job.status))) && <span className="tab-live-dot" />}</button>
            </nav>
            <div className="save-state"><span className={`save-dot ${dirty ? 'is-dirty' : ''}`} />{saveStateLabel}</div>
            <button type="button" className={`cheat-toggle ${showCheatSheet ? 'active' : ''}`} aria-expanded={showCheatSheet} aria-controls="cheat-sheet" title="快捷键 (?)" onClick={() => setShowCheatSheet(v => !v)}><Keyboard size={17} /><span>快捷键</span></button>
            {dirty && <button type="button" className="save-top-button" onClick={() => void saveCurrentChanges().catch(() => { /* Save handlers report the conflict or request error. */ })} disabled={busy === 'save' || busy === 'proposal-save'}>{activeProposal ? '保存建议修改' : '保存标注'}</button>}
            {!activeProposal && <div className="export-menu-wrap">
              <button type="button" className="button button-dark export-trigger" onClick={() => setMenuOpen(open => !open)}><span>导出</span><CaretDown size={15} /></button>
              {menuOpen && <div className="export-menu"><button type="button" onClick={() => void exportFile('export')}><ImageSquare size={17} />导出已接受 PNG</button><button type="button" onClick={() => void showAnnotationJson()}><FileCode size={17} />查看 / 复制标注 JSON</button><button type="button" onClick={() => void exportFile('annotations')}><DownloadSimple size={17} />导出标注 JSON</button><button type="button" onClick={() => packageInputRef.current?.click()}><UploadSimple size={17} />导入标注 JSON</button></div>}
            </div>}
          </header>

          <div className="editor-body">
            <aside className="tool-rail" aria-label="画布工具">
              <div className="rail-tools">
                {currentToolButtons.map(item => {
                  const Icon = item.icon;
                  return <button type="button" key={item.id} className={tool === item.id || item.id === 'magnetic' && ['polygon', 'lasso'].includes(tool) ? 'rail-tool active' : 'rail-tool'} onClick={() => { setTool(item.id); if (['brush', 'erase', 'magnetic', 'suggest'].includes(item.id)) setShowMasks(true); }} title={`${item.label} (${item.shortcut})`} aria-label={`${item.label}工具，快捷键 ${item.shortcut}`} disabled={proposalReadOnly}><Icon size={20} /><span>{item.label}</span><small>{item.shortcut}</small></button>;
                })}
              </div>
              <div className="rail-bottom">
                <button type="button" className="rail-tool" disabled={proposalReadOnly || !annotateHistoryRef.current?.canUndo} onClick={undoAnnotate} title="撤销标注 (⌘Z)" aria-label="撤销标注"><ArrowUUpLeft size={19} /><span>撤销</span><small>⌘Z</small></button>
                <button type="button" className="rail-tool" disabled={proposalReadOnly || !annotateHistoryRef.current?.canRedo} onClick={redoAnnotate} title="重做标注 (⇧⌘Z)" aria-label="重做标注"><ArrowUUpLeft size={19} style={{ transform: 'scaleX(-1)' }} /><span>重做</span><small>⇧⌘Z</small></button>
                <span className="history-tick" hidden>{historyTick}</span>
              </div>
            </aside>

            <main className="workspace">
              {activeProposal && <div className="proposal-mode-banner" role="status"><span><strong>{activeProposal.status === 'draft' ? '正在审阅建议草稿' : activeProposal.status === 'confirmed' ? '已确认建议快照' : activeProposal.status === 'stale' ? '已过期建议快照' : '已取消建议快照'}</strong><small>{activeProposal.title} · {activeProposal.status === 'draft' ? '画布编辑只写入此提议，不改正式标注' : '当前为只读建议快照'}</small></span><button type="button" className="button button-outline" onClick={requestProposalExit} disabled={busy === 'proposal-exit'}>退出建议，查看正式标注</button></div>}
              <div className={isComparing ? (compareMode === 'side' ? 'canvas-compare' : 'canvas-wrap review-wrap') : 'canvas-wrap'}>
                {isComparing && compareMode === 'side' ? (
                  <>
                    <div className="compare-pane"><span className="compare-label">{comparisonLabel}</span><CanvasEditor imageUrl={baseUrl} width={currentProject.width} height={currentProject.height} regions={[]} activeRegionId={null} annotationKind="edit" tool="select" brushSize={brushSize} showMasks={false} onShape={() => {}} /></div>
                    <div className="compare-pane"><span className="compare-label">{selectedVersion?.name || '当前版本'}</span><CanvasEditor imageUrl={displayUrl} width={currentProject.width} height={currentProject.height} regions={regions} activeRegionId={selectedRegionId} annotationKind={annotationKind} tool="select" brushSize={brushSize} showMasks={showMasks} onShape={() => {}} /></div>
                    <button type="button" className="compare-close" onClick={() => setIsComparing(false)}><X size={16} />退出对比</button>
                  </>
                ) : isComparing ? (
                  <ReviewCompare
                    baseUrl={baseUrl}
                    candidateUrl={displayUrl}
                    width={currentProject.width}
                    height={currentProject.height}
                    mode={compareMode}
                    validation={selectedVersion?.validation}
                    baseLabel={comparisonLabel}
                    candidateLabel={selectedVersion?.name || '当前版本'}
                    onExit={() => setIsComparing(false)}
                  />
                ) : (
                  <CanvasEditor imageUrl={displayUrl} width={currentProject.width} height={currentProject.height} regions={regions} activeRegionId={selectedRegionId} annotationKind={annotationKind} tool={tool} brushSize={brushSize} showMasks={showMasks} onShape={proposalReadOnly ? () => {} : addShape} onToolChange={setTool} onBrushSizeChange={setBrushSize} onRegionSelect={id => { const region = regions.find(item => item.id === id); setSelectedRegionId(id); if (region) setAnnotationKind(region.kind); }} />
                )}
              </div>
              <div className="canvas-statusbar"><span>{formatDimensions(currentProject.width, currentProject.height)} · sRGB / 8 bit</span><span>{dirty ? '标注有未保存更改' : '本地保存'} · 原图始终保留</span></div>
              <section className="version-strip" aria-label="版本历史">
                <div className="version-strip-head"><span>版本</span><span className="version-count">{currentProject.versions.length}</span></div>
                <div className="version-items">
                  {currentProject.versions.map(version => (
                    <button type="button" className={version.id === selectedVersionId ? 'version-card selected' : 'version-card'} key={version.id} onClick={() => { setSelectedVersionId(version.id); setIsComparing(false); }}>
                      <span className="version-image">{assetThumb(currentProject.id, version.asset, version.name)}</span>
                      <strong>{version.status === 'source' ? '原图' : version.name || (version.status === 'accepted' ? '已接受' : '候选')}</strong>
                      <small>{version.status === 'accepted' ? '已接受' : version.status === 'candidate' ? '候选待验收' : version.status === 'rejected' ? '已退回' : '基准'}</small>
                    </button>
                  ))}
                  <div className="compare-controls">
                    <button type="button" className="compare-button" disabled={!baseUrl || selectedVersionId === comparisonVersion?.id} onClick={() => { setIsComparing(value => !value); setShowMasks(false); if (!isComparing) setCompareMode('side'); }}><ArrowsLeftRight size={17} />{isComparing ? '退出对比' : `对比${comparisonLabel}`}</button>
                    {isComparing && (
                      <div className="compare-mode-switch" role="group" aria-label="对比方式">
                        <button type="button" className={compareMode === 'side' ? 'active' : ''} onClick={() => setCompareMode('side')} title="并排"><ArrowsLeftRight size={14} />并排</button>
                        <button type="button" className={compareMode === 'wipe' ? 'active' : ''} onClick={() => setCompareMode('wipe')} title="wipe 滑动"><CircleHalf size={14} />Wipe</button>
                        <button type="button" className={compareMode === 'diff' ? 'active' : ''} onClick={() => setCompareMode('diff')} title="差异热图"><Path size={14} />差异</button>
                      </div>
                    )}
                  </div>
                </div>
              </section>
            </main>

            <aside className="inspector">
              {activeProposal || tab === 'collab' ? (
                <ProposalReview
                  proposals={proposals}
                  selectedProposalId={selectedProposalId}
                  selectedProposal={selectedProposal}
                  activeProposal={activeProposal}
                  draft={proposalDraft}
                  regions={regions}
                  selectedRegion={selectedRegion}
                  selectedRegionId={selectedRegionId}
                  annotationKind={annotationKind}
                  tool={tool}
                  brushSize={brushSize}
                  projectRevision={currentProject.revision}
                  loading={proposalsLoading}
                  dirty={dirty}
                  busy={busy}
                  error={proposalError}
                  qwenAvailable={Boolean(capabilities?.qwen.available)}
                  qwenReason={capabilities?.qwen.reason || capabilitiesError}
                  gptAvailable={Boolean(projectPermissions?.remoteGenerationEnabled && capabilities?.gpt.available && capabilities.gpt.destination && capabilities.gpt.modelId && projectPermissions.processing.gpt?.destination === capabilities.gpt.destination && projectPermissions.processing.gpt.modelId === capabilities.gpt.modelId)}
                  gptReason={capabilities?.gpt.reason || capabilitiesError}
                  gptExecutionAvailable={gptTargetMatchesConfirmation}
                  projectId={currentProject.id}
                  currentBaseVersionId={currentProject.baseVersionId}
                  imageWidth={currentProject.width}
                  imageHeight={currentProject.height}
                  pendingPlanSubmission={pendingPlanSubmission}
                  executionStorageAvailable={!pendingPlanJobsError}
                  executionBusy={busy === 'plan-job'}
                  executionError={planExecutionError || pendingPlanJobsError}
                  executionJob={executionJob}
                  permissions={projectPermissions}
                  permissionsLoading={permissionsLoading}
                  permissionsError={permissionsError}
                  permissionCreating={permissionCreating}
                  busyGrantId={busyGrantId}
                  selectedGrantId={selectedGrantId}
                  matchingGptGrants={matchingGptGrants}
                  onRefresh={() => { void refreshProposals(currentProject.id); }}
                  onSelect={id => { void selectProposal(id); }}
                  onStartEditing={startProposalEditing}
                  onCancel={proposal => { void cancelProposal(proposal); }}
                  onDraftChange={updateProposalDraft}
                  onToggleSuggestion={toggleProposalSuggestion}
                  onAnnotationKindChange={setAnnotationKind}
                  onRegionSelect={region => { setSelectedRegionId(region.id); setAnnotationKind(region.kind); }}
                  onAddRegion={addRegion}
                  onUpdateRegion={updateRegion}
                  onDeleteRegion={deleteRegion}
                  onBrushSizeChange={setBrushSize}
                  onSave={() => { void saveProposalChanges().catch(() => { /* The proposal editor reports and preserves conflicts. */ }); }}
                  onConfirm={() => { void confirmProposal(); }}
                  onExecute={() => { void executeConfirmedPlan(); }}
                  onCopyDocument={() => { void copyProposalDocument(); }}
                  onPermissionRefresh={() => { void refreshProjectPermissions(currentProject.id).catch(() => { /* The permission panel displays the error. */ }); }}
                  onCreatePermission={input => { void createProjectPermission(input); }}
                  onRevokePermission={grant => { void revokeProjectPermission(grant); }}
                  onSelectGrant={grantId => { if (reviewProposal) setSelectedExecutionGrant({ proposalId: reviewProposal.id, grantId }); }}
                  onExit={requestProposalExit}
                />
              ) : tab === 'jobs' ? (
                <div className="inspector-scroll jobs-inspector">
                  <div className="inspector-heading"><div className="eyebrow">PROJECT JOBS</div><h2>本地任务</h2><p>状态来自本项目的真实服务端任务。</p></div>
                  <button type="button" className="button button-outline full-button" onClick={() => { void refreshJobs(); refreshPendingJobs(currentProject.id); }}><Clock size={17} />刷新任务</button>
                  {pendingJobsError && <p className="job-error">待核对记录无法读取：{pendingJobsError}</p>}
                  {pendingPlanJobsError && <p className="job-error">计划任务幂等记录无法读取：{pendingPlanJobsError}</p>}
                  {pendingPlanJobs.filter(item => !item.jobId || !jobs.some(job => job.id === item.jobId)).map(submission => (
                    <article className="job-card pending-job-card" key={`${submission.projectId}:${submission.proposalId}:${submission.confirmationId}`}>
                      <div className="job-card-head"><span className="job-state state-reconciling"><span />计划提交待核对</span><small>已确认</small></div>
                      <strong>建议 {submission.proposalId.slice(0, 8)}</strong>
                      <div className="job-meta">确认 {submission.confirmationId.slice(0, 8)} · 原幂等键 {submission.idempotencyKey.slice(0, 8)}…</div>
                      <button type="button" className="button button-outline full-button" onClick={() => { void selectProposal(submission.proposalId); setTab('collab'); }}>返回计划使用原幂等键核对</button>
                    </article>
                  ))}
                  {pendingJobs.map(submission => (
                    <article className="job-card pending-job-card" key={`${submission.projectId}:${submission.revision}:${submission.regionId}`}>
                      <div className="job-card-head"><span className="job-state state-reconciling"><span />提交待核对</span><small>修订 {submission.revision}</small></div>
                      <strong>{regions.find(region => region.id === submission.regionId)?.name ?? `区域 ${submission.regionId.slice(0, 7)}`}</strong>
                      <div className="job-meta">原幂等键 {submission.idempotencyKey.slice(0, 8)}… · 未确认前不会换键</div>
                      <button type="button" className="button button-outline full-button" onClick={() => void verifyPendingJob(submission)} disabled={busy === 'job-check' || busy === 'job'}>{busy === 'job-check' ? '正在核对…' : '使用原请求核对'}</button>
                    </article>
                  ))}
                  {jobs.length ? <div className="job-list">{jobs.map(job => (
                    <article className="job-card" key={job.id}>
                      <div className="job-card-head"><span className={`job-state state-${job.status}`}><span />{jobLabel(job.status)}</span><small>{formatDate(job.updatedAt)}</small></div>
                      <strong>{job.proposalId ? `已确认计划 · ${job.regionIds?.length ?? 0} 个编辑区域` : regions.find(region => region.id === job.regionId)?.name ?? `区域 ${job.regionId.slice(0, 7)}`}</strong>
                      <div className="job-meta">任务 {job.id.slice(0, 8)}{job.proposalId ? ` · 建议 ${job.proposalId.slice(0, 8)}` : ` · 修订 ${job.annotationRevision}`}</div>
                      {job.proposalId && job.stepCount && <div className="plan-job-progress"><div className="plan-job-progress-track" role="progressbar" aria-label="计划生成进度" aria-valuemin={0} aria-valuemax={job.stepCount} aria-valuenow={job.completedStepCount ?? 0}><span style={{ width: `${Math.round(Math.min(job.completedStepCount ?? 0, job.stepCount) / job.stepCount * 100)}%` }} /></div><small>{job.status === 'candidate' ? `步骤 ${job.stepCount}/${job.stepCount} · 全部完成` : job.status === 'queued' ? `等待第 ${Math.max(1, (job.stepIndex ?? 0) + 1)}/${job.stepCount} 步` : `步骤 ${Math.max(1, (job.stepIndex ?? 0) + 1)}/${job.stepCount}`}</small></div>}
                      {job.waitReason && <p className="helper-text" role="status">{job.waitReason}</p>}
                      {job.error && <p className="job-error">{job.error}</p>}
                      {job.versionId && <button type="button" className="text-button" onClick={() => { setSelectedVersionId(job.versionId ?? null); if (job.proposalId) setTab('retouch'); }}>查看关联版本</button>}
                    </article>
                  ))}</div> : <div className="empty-inline"><Clock size={24} /><strong>尚无本项目任务</strong><span>提交本地候选任务后，真实状态会显示在这里。</span></div>}
                  <div className="panel-separator" />
                  <CapabilityLine label="Qwen Image · 本地" available={capabilities?.qwen.available ?? null} loading={capabilitiesLoading} reason={capabilities?.qwen.reason ?? (capabilitiesError || undefined)} />
                  <button type="button" className="button button-dark full-button" disabled={!capabilities?.qwen.available || hasPendingJob || Boolean(pendingJobsError) || busy === 'job' || !selectedRegion || selectedRegion.kind !== 'edit' || !selectedRegion.shapes.length} onClick={() => void startLocalJob()}><Sparkle size={17} />{hasPendingJob ? '先核对待提交任务' : busy === 'job' ? '正在提交…' : '保存并生成当前区域候选'}</button>
                  {capabilitiesLoading && <p className="helper-text">正在读取本机能力状态，任务提交暂不可用。</p>}
                  {!capabilitiesLoading && !capabilities?.qwen.available && <p className="helper-text">本机 Qwen 不可用。可导入外部候选图，由本地服务执行范围检查。</p>}
                  {selectedRegion?.kind === 'edit' && !selectedRegion.shapes.length && <p className="helper-text">先在画布上为编辑区域绘制标注。</p>}
                </div>
              ) : (
                <div className="inspector-scroll">
                  <div className="inspector-heading"><h2>{tab === 'annotate' ? '精细标注' : selectedRegion?.name ?? '当前精修'}</h2><p>{tab === 'annotate' ? '分别标记可编辑区域与需要保护的区域。' : '只处理选中区域，保留照片的自然质感。'}</p></div>
                  {tab === 'annotate' && <div className="annotation-switch" role="group" aria-label="标注类型">
                    <button type="button" className={annotationKind === 'edit' ? 'active edit-choice' : ''} onClick={() => { setAnnotationKind('edit'); if (selectedRegion && selectedRegion.kind !== 'edit') updateRegion(selectedRegion.id, { kind: 'edit' }); }}>编辑范围</button>
                    <button type="button" className={annotationKind === 'keep' ? 'active keep-choice' : ''} onClick={() => { setAnnotationKind('keep'); if (selectedRegion && selectedRegion.kind !== 'keep') updateRegion(selectedRegion.id, { kind: 'keep' }); }}><LockKey size={15} />保护范围</button>
                  </div>}
                  <div className="region-section">
                    <div className="panel-label-row"><span>区域</span><span>{regions.length}</span></div>
                    <div className="region-list">
                      {regions.map(region => (
                        <div className={selectedRegionId === region.id ? `region-item selected ${region.kind}` : `region-item ${region.kind}`} key={region.id}>
                          <button type="button" className="region-select" onClick={() => { setSelectedRegionId(region.id); setAnnotationKind(region.kind); }}>
                            <span className={`region-swatch ${region.kind}`}>{region.kind === 'keep' ? <LockKey size={12} /> : null}</span>
                            <span className="region-main"><strong>{region.name}</strong><small>{region.kind === 'edit' ? '编辑区域' : '保护区域'} · {region.shapes.length} 个形状</small></span>
                            {selectedRegionId === region.id && <Check size={16} />}
                          </button>
                          {selectedRegionId === region.id && <button type="button" className="region-delete" aria-label={`删除${region.name}`} onClick={() => deleteRegion(region.id)}><X size={14} /></button>}
                        </div>
                      ))}
                    </div>
                    <div className="region-add-row"><button type="button" onClick={() => addRegion('edit')}><Plus size={15} />新建编辑区</button><button type="button" onClick={() => addRegion('keep')}><LockKey size={14} />新建保护区</button></div>
                    {overlappingEditNames(regions).length > 0 && <p className="overlap-hint" role="status">编辑区外接矩形有重叠：{overlappingEditNames(regions).slice(0, 3).join('；')}。多意图请分步执行，勿盲目合并提示词。</p>}
                  </div>
                  {selectedRegion ? (
                    <>
                      <div className="panel-separator" />
                      {tab === 'annotate' && <label className="field-label">区域名称<input value={selectedRegion.name} maxLength={64} onChange={event => updateRegion(selectedRegion.id, { name: event.target.value })} /></label>}
                      <label className="field-label intent-label">局部意图<textarea value={selectedRegion.intent} maxLength={2000} placeholder={selectedRegion.kind === 'edit' ? '描述要修改什么，以及哪些细节需要保留…' : '描述此区域需要保护的对象…'} onChange={event => updateRegion(selectedRegion.id, { intent: event.target.value })} /><span className="field-count">{selectedRegion.intent.length}/2000</span></label>
                      {tab === 'annotate' && selectedRegion.kind === 'edit' && <RegionContextControl region={selectedRegion} width={currentProject.width} height={currentProject.height} onChange={context => updateRegion(selectedRegion.id, { context })} />}
                      {tab === 'annotate' && <div className="slider-field"><div className="slider-heading"><label htmlFor="feather-range">向内羽化</label><span>{selectedRegion.feather} px</span></div><input id="feather-range" type="range" min="0" max="64" value={selectedRegion.feather} onChange={event => updateRegion(selectedRegion.id, { feather: Number(event.target.value) })} /><small>画布即时预览有效软边；服务端合成时同样向内羽化，不扩大授权范围。</small></div>}
                      {tab === 'annotate' && <div className="morph-tools" aria-label="选区形态学">
                        <div className="slider-heading"><span>选区调整</span><span>半径 {morphRadius} px</span></div>
                        <input aria-label="扩张收缩半径" type="range" min="1" max="32" value={morphRadius} onChange={event => setMorphRadius(Number(event.target.value))} />
                        <div className="morph-actions">
                          <button type="button" className="button button-outline morph-button" disabled={proposalReadOnly || !selectedRegion.shapes.length} onClick={() => applyMorphology('expand')} title="扩张选区"><ArrowsOut size={15} />扩张</button>
                          <button type="button" className="button button-outline morph-button" disabled={proposalReadOnly || !selectedRegion.shapes.length} onClick={() => applyMorphology('contract')} title="收缩选区"><ArrowsIn size={15} />收缩</button>
                          <button type="button" className="button button-outline morph-button" disabled={proposalReadOnly} onClick={() => applyMorphology('invert')} title="反选"><Path size={15} />反选</button>
                        </div>
                        <small>扩张 / 收缩 / 反选只改当前区域形状；不修改原图像素，也不改变 E/K 硬保护规则。</small>
                      </div>}
                      {(tool === 'brush' || tool === 'erase') && <div className="slider-field brush-setting"><div className="slider-heading"><label htmlFor="brush-range">{tool === 'erase' ? '橡皮直径' : '画笔直径'}</label><span>{brushSize} px</span></div><input id="brush-range" type="range" min="1" max="512" value={brushSize} onChange={event => setBrushSize(Number(event.target.value))} /></div>}
                      {tab === 'retouch' ? <div className="local-preview-section"><h3>局部预览</h3><div className="local-preview-pair"><div><RegionPreview imageUrl={baseUrl} region={selectedRegion} width={currentProject.width} height={currentProject.height} /><span>原图</span></div><div><RegionPreview imageUrl={displayUrl} region={selectedRegion} width={currentProject.width} height={currentProject.height} /><span>{selectedVersion?.status === 'source' ? '当前版本' : selectedVersion?.status === 'candidate' ? '候选' : selectedVersion?.status === 'rejected' ? '已拒绝' : '已接受'}</span></div></div><button type="button" className="text-button" onClick={() => setTab('annotate')}>精细调整选区</button></div> : <div className="mask-legend"><div><span className="region-swatch edit" /> <span><strong>E · 编辑范围</strong><small>琥珀色区域允许修改；羽化只向内</small></span></div><div><span className="region-swatch keep"><LockKey size={12} /></span><span><strong>K · 保护范围</strong><small>蓝色斜纹区域优先保持不变</small></span></div><div><span className="region-swatch context" /> <span><strong>C · 参考范围</strong><small>虚线框仅供模型观察，不是编辑授权</small></span></div></div>}
                    </>
                  ) : <div className="empty-inline empty-region"><PaintBrush size={24} /><strong>还没有标注区域</strong><span>用画笔 / 矩形 / 套索直接在照片上画，或按 G 点选建议后再精修。</span><div className="empty-actions"><button type="button" className="button button-outline" onClick={() => { addRegion(annotationKind); setTool('suggest'); }}>建议选区</button><button type="button" className="text-button" onClick={() => addRegion(annotationKind)}>空{annotationKind === 'edit' ? '编辑' : '保护'}区域</button></div></div>}
                  <div className="panel-separator" />
                  <div className="display-row"><span>显示标注蒙版 <small className="shortcut-inline">M</small></span><button type="button" className={`switch ${showMasks ? 'on' : ''}`} role="switch" aria-checked={showMasks} onClick={() => setShowMasks(value => !value)} aria-label="显示标注蒙版，快捷键 M"> <span /></button></div>
                  <div className="annotation-actions">
                    <button type="button" className="button button-dark full-button" onClick={() => void saveAnnotations().catch(() => { /* saveAnnotations reports the conflict or request error. */ })} disabled={!dirty || busy === 'save'}>{busy === 'save' ? '正在保存…' : '保存标注'}<span className="button-shortcut">⌘ S</span></button>
                    {dirty && <div className="dirty-explain"><Info size={15} />标注尚未保存；提交任务前会先保存并冻结修订。</div>}
                    {currentProject && dirty && <div className="conflict-help">如果服务器返回修订冲突，本地修改会留在此页，不会静默覆盖远端标注。</div>}
                  </div>
                </div>
              )}
              {tab !== 'jobs' && tab !== 'collab' && <div className="inspector-bottom">
                {selectedVersion?.status === 'candidate' ? (
                  <div className="candidate-validation">
                    <div className="validation-heading"><span>候选范围检查</span><span className={selectedVersion.validation?.passed ? 'validation-result passed' : selectedVersion.validation ? 'validation-result failed' : 'validation-result unknown'}>{selectedVersion.validation ? selectedVersion.validation.passed ? '通过' : '未通过' : '未返回'}</span></div>
                    {selectedVersion.validation ? (
                      <>
                        <div className={`protect-zero-chip ${selectedVersion.validation.protectedChangedPixels === 0 ? 'ok' : 'bad'}`} role="status">
                          保护区变化 <strong>{selectedVersion.validation.protectedChangedPixels.toLocaleString()} px</strong>
                          {selectedVersion.validation.protectedChangedPixels === 0 ? ' · 硬约束 0 px' : ' · 硬约束未通过'}
                        </div>
                        <div className="validation-stats"><span>保护区变化<strong>{selectedVersion.validation.protectedChangedPixels.toLocaleString()}</strong></span><span>编辑区外变化<strong>{selectedVersion.validation.outsideEditChangedPixels.toLocaleString()}</strong></span><span>发生变化像素<strong>{selectedVersion.validation.changedPixels.toLocaleString()}</strong></span><span>最大通道差<strong>{selectedVersion.validation.maxChannelDelta}</strong></span></div>
                        <div className="compare-mode-switch validation-compare-switch" role="group" aria-label="打开验收对比">
                          <button type="button" onClick={() => { setCompareMode('wipe'); setIsComparing(true); setShowMasks(false); }} disabled={!baseUrl || selectedVersionId === comparisonVersion?.id}><CircleHalf size={14} />Wipe 对比</button>
                          <button type="button" onClick={() => { setCompareMode('diff'); setIsComparing(true); setShowMasks(false); }} disabled={!baseUrl || selectedVersionId === comparisonVersion?.id}><Path size={14} />差异热图</button>
                        </div>
                      </>
                    ) : <p>服务端未提供像素验收报告，不能据此宣称范围安全。</p>}
                    <div className="staging-actions" role="group" aria-label="候选处置">
                      <button type="button" className="button button-dark full-button" disabled={!selectedVersion.validation?.passed || busy === 'accept' || dirty || selectedCandidateStale} onClick={() => void acceptCandidate(selectedVersion)}><CheckCircle size={17} />{busy === 'accept' ? '正在接受…' : '接受为新基准'}</button>
                      <button type="button" className="button button-outline full-button" disabled={Boolean(busy) || dirty} onClick={() => void rejectCandidate(selectedVersion)}><X size={17} />{busy === 'reject' ? '正在拒绝…' : '拒绝并保留历史'}</button>
                    </div>
                    <p className="staging-help">接受会推进正式基准；拒绝只标记候选，不删图、不改标注。范围通过 ≠ 视觉通过。</p>
                    {dirty && <span className="helper-text">有未保存标注。接受会将候选绑定到旧修订；请先放弃本地改动或重新导入候选。</span>}
                    {!dirty && selectedCandidateStale && <span className="helper-text">候选对应旧标注修订，无法接受。请按当前标注重新导入候选。</span>}
                    {selectedVersion.validation && !selectedVersion.validation.passed && <span className="helper-text">检查未通过，不能接受此候选。</span>}
                  </div>
                ) : (
                  <>
                    <div className="backend-row"><span>候选生成</span><span className={`inline-status ${capabilities?.qwen.available ? 'ready' : ''}`}><i />{capabilitiesLoading ? '正在读取 Qwen 状态…' : capabilities?.qwen.available ? 'Qwen Image · 本地可用' : capabilitiesError ? '能力状态读取失败' : 'Qwen Image · 未配置'}</span></div>
                    <button type="button" className="button button-dark full-button" disabled={!capabilities?.qwen.available || hasPendingJob || Boolean(pendingJobsError) || !selectedRegion || selectedRegion.kind !== 'edit' || !selectedRegion.shapes.length || busy === 'job'} onClick={() => void startLocalJob()}><Sparkle size={17} />{hasPendingJob ? '先核对待提交任务' : busy === 'job' ? '正在提交本地任务…' : '生成当前区域候选'}</button>
                    {capabilitiesLoading && <p className="helper-text">正在读取本机能力状态，生成操作暂不可用。</p>}
                    {!capabilitiesLoading && !capabilities?.qwen.available && <p className="helper-text">{capabilities?.qwen.reason || capabilitiesError || '本地 Qwen 尚未配置。导入外部候选仍可执行本地范围检查。'}</p>}
                    {hasPendingJob && <p className="helper-text">有任务提交状态待核对。请先到「任务」页使用原幂等键核对，不会自动创建新任务。</p>}
                    {pendingJobsError && <p className="helper-text">{pendingJobsError}为避免重复生成，任务提交已禁用；可在「任务」页重新读取待核对记录。</p>}
                    {selectedRegion?.kind === 'edit' && !selectedRegion.shapes.length && <p className="helper-text">先在画布上为编辑区域绘制标注。</p>}
                    <button type="button" className="button button-outline full-button" disabled={!selectedRegion || selectedRegion.kind !== 'edit' || !selectedRegion.shapes.length || busy === 'candidate'} onClick={() => candidateInputRef.current?.click()}><UploadSimple size={17} />{busy === 'candidate' ? '正在验收候选…' : '导入外部候选'}</button>
                    <span className="helper-text">候选必须与项目基准同尺寸；验收由本地服务返回。</span>
                  </>
                )}
              </div>}
            </aside>
          </div>
        </div>
      ) : null}

      {showCheatSheet && page === 'editor' && <aside id="cheat-sheet" className="cheat-sheet" role="dialog" aria-label="快捷键一览">
        <div className="cheat-sheet-head"><strong>画布快捷键</strong><button type="button" aria-label="关闭" onClick={() => setShowCheatSheet(false)}><X size={15} /></button></div>
        <ul>
          <li><kbd>V</kbd> 选择 · <kbd>B</kbd> 画笔 · <kbd>E</kbd> 擦除 · <kbd>R</kbd> 矩形</li>
          <li><kbd>L</kbd> 套索 · <kbd>G</kbd> 建议 · <kbd>H</kbd>/<kbd>空格</kbd> 平移</li>
          <li><kbd>M</kbd> 显隐蒙版 · <kbd>[</kbd><kbd>]</kbd>/滚轮 笔刷大小</li>
          <li><kbd>0</kbd> 适合 · <kbd>1</kbd> 100% · <kbd>+</kbd>/<kbd>-</kbd> 缩放</li>
          <li>套索：<kbd>Enter</kbd>/双击闭合 · <kbd>Backspace</kbd> 回退锚点 · <kbd>Alt</kbd> 自由跟随</li>
          <li>建议：点击扩散 · 拖框约束 · 再用画笔/扩张收缩精修</li>
          <li><kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Z</kbd> 撤销 · <kbd>⇧⌘Z</kbd> 重做</li>
          <li><kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>S</kbd> 保存 · <kbd>?</kbd> 开关本面板</li>
          <li>建议：点击包含 · <kbd>Alt</kbd>+点击排除 · 拖框范围（本地多点，非 SAM2）</li>
        </ul>
      </aside>}

      {flash && <div className={`toast toast-${flash.kind}`} role={flash.kind === 'error' ? 'alert' : 'status'}><span className="toast-icon">{flash.kind === 'success' ? <CheckCircle size={19} /> : flash.kind === 'error' ? <WarningCircle size={19} /> : <Info size={19} />}</span><span>{flash.message}</span><button type="button" aria-label="关闭通知" onClick={() => setFlash(null)}><X size={16} /></button></div>}

      {jsonDialog && <div className="modal-scrim" role="presentation"><section className="leave-modal json-dialog" role="dialog" aria-modal="true" aria-labelledby="json-title"><button type="button" className="modal-close" aria-label="关闭 JSON" onClick={() => setJsonDialog(false)}><X size={17} /></button><h2 id="json-title">{jsonDialogType === 'proposal' ? '交给 Agent 的计划 JSON' : '交给 Agent 的标注 JSON'}</h2><p>{jsonDialogType === 'proposal' ? '包含图片哈希、当前建议与可能存在的确认信息。导入只创建新草稿，外来 confirmation 不会授予执行权限。' : '选区、意图和照片引用；不含图片字节或密钥。复制后可直接交给连接同一工作区的 Agent。'}</p><textarea aria-label={jsonDialogType === 'proposal' ? '计划 JSON' : '标注 JSON'} value={jsonText} readOnly onFocus={e => e.target.select()} spellCheck={false} /><div className="modal-actions"><button type="button" className="button button-outline" onClick={() => setJsonDialog(false)}>关闭</button><button type="button" className="button button-dark" onClick={() => void copyAnnotationJson()}>复制 JSON</button></div></section></div>}

      {proposalExitPrompt && <div className="modal-scrim" role="presentation"><section className="leave-modal" role="dialog" aria-modal="true" aria-labelledby="proposal-exit-title"><button type="button" className="modal-close" aria-label="继续审阅建议" onClick={() => setProposalExitPrompt(false)}><X size={17} /></button><div className="modal-icon"><WarningCircle size={22} /></div><h2 id="proposal-exit-title">建议修改尚未保存</h2><p>{activeProposal?.status === 'draft' ? '保存会更新这份建议草稿，正式标注仍不变。也可以放弃本页的改动，再载入最新正式标注。' : '服务端已将此建议标为已处理，本页仍有本地改动，不能再保存到原建议。放弃本页改动后才能查看最新正式标注。'}</p><div className="modal-actions"><button type="button" className="button button-soft" onClick={() => setProposalExitPrompt(false)}>继续审阅</button><button type="button" className="button button-outline" onClick={() => void exitProposal(true)} disabled={busy === 'proposal-exit'}>放弃并查看正式标注</button><button type="button" className="button button-dark" onClick={() => void exitProposal(false)} disabled={busy === 'proposal-exit' || busy === 'proposal-save' || activeProposal?.status !== 'draft'}>{busy === 'proposal-exit' || busy === 'proposal-save' ? '正在处理…' : activeProposal?.status === 'draft' ? '保存草稿并退出' : '无法保存已处理建议'}</button></div></section></div>}

      {leavePrompt && <div className="modal-scrim" role="presentation"><section className="leave-modal" role="dialog" aria-modal="true" aria-labelledby="leave-title"><button type="button" className="modal-close" aria-label="继续编辑" onClick={() => setLeavePrompt(false)}><X size={17} /></button><div className="modal-icon"><WarningCircle size={22} /></div><h2 id="leave-title">{activeProposal ? '建议修改尚未保存' : '标注尚未保存'}</h2><p>{activeProposal ? '保存会更新建议草稿，正式标注不会改变。保存后再返回，或明确放弃这些修改。' : '当前编辑只保存在此页面。保存后再返回，或明确放弃这些修改。'}</p><div className="modal-actions"><button type="button" className="button button-soft" onClick={() => setLeavePrompt(false)}>继续编辑</button><button type="button" className="button button-outline" onClick={discardAndLeave}>放弃并返回</button><button type="button" className="button button-dark" onClick={() => void saveAndLeave()} disabled={busy === 'save' || busy === 'proposal-save'}>{busy === 'save' || busy === 'proposal-save' ? '正在保存…' : '保存并返回'}</button></div></section></div>}

      <input ref={photoInputRef} type="file" accept="image/jpeg,image/png" hidden onChange={event => void onPhotoInput(event)} />
      <input ref={packageInputRef} type="file" accept=".json,application/json" hidden onChange={event => void onPackageInput(event)} />
      <input ref={candidateInputRef} type="file" accept="image/jpeg,image/png" hidden onChange={event => void importCandidate(event)} />
    </div>
  );
}
