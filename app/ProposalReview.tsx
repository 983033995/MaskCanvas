import { ArrowCounterClockwise, CheckCircle, Clock, FileCode, Info, LockKey, PencilSimple, ShieldCheck, X } from '@phosphor-icons/react';
import type { EditProposal, ImageBackend, ProposalSuggestion, Region } from '../packages/shared/types';
import type { PlanJob, ProjectGrant, ProjectGrantInput, ProjectPermissions as ProjectPermissionsSnapshot } from './api';
import { ProjectPermissions } from './ProjectPermissions';
import { RegionContextControl } from './RegionContextControl';

export interface ProposalDraftFields {
  title: string;
  goal: string;
  backend: ImageBackend;
  suggestions: ProposalSuggestion[];
}

interface ProposalReviewProps {
  proposals: EditProposal[];
  selectedProposalId: string | null;
  selectedProposal: EditProposal | null;
  activeProposal: EditProposal | null;
  draft: ProposalDraftFields | null;
  regions: Region[];
  selectedRegion: Region | null;
  selectedRegionId: string | null;
  annotationKind: Region['kind'];
  tool: string;
  brushSize: number;
  projectRevision: number;
  loading: boolean;
  dirty: boolean;
  busy: string | null;
  error: string;
  qwenAvailable: boolean;
  qwenReason: string;
  gptAvailable: boolean;
  gptReason: string;
  gptExecutionAvailable: boolean;
  projectId: string;
  currentBaseVersionId: string;
  imageWidth: number;
  imageHeight: number;
  pendingPlanSubmission: boolean;
  executionStorageAvailable: boolean;
  executionBusy: boolean;
  executionError: string;
  executionJob: PlanJob | null;
  permissions: ProjectPermissionsSnapshot | null;
  permissionsLoading: boolean;
  permissionsError: string;
  permissionCreating: boolean;
  busyGrantId: string | null;
  selectedGrantId: string;
  matchingGptGrants: ProjectGrant[];
  onPermissionRefresh: () => void;
  onCreatePermission: (input: ProjectGrantInput) => void;
  onRevokePermission: (grant: ProjectGrant) => void;
  onSelectGrant: (grantId: string) => void;
  onRefresh: () => void;
  onSelect: (id: string) => void;
  onStartEditing: (proposal: EditProposal) => void;
  onCancel: (proposal: EditProposal) => void;
  onDraftChange: (update: Partial<ProposalDraftFields>) => void;
  onToggleSuggestion: (regionId: string) => void;
  onAnnotationKindChange: (kind: Region['kind']) => void;
  onRegionSelect: (region: Region) => void;
  onAddRegion: (kind: Region['kind']) => void;
  onUpdateRegion: (id: string, update: Partial<Region>) => void;
  onDeleteRegion: (id: string) => void;
  onBrushSizeChange: (size: number) => void;
  onSave: () => void;
  onConfirm: () => void;
  onExecute: () => void;
  onCopyDocument: () => void;
  onExit: () => void;
}

const statusLabel: Record<EditProposal['status'], string> = {
  draft: '待审阅',
  confirmed: '已确认',
  stale: '已过期',
  cancelled: '已取消',
};

function backendLabel(backend: ImageBackend): string {
  return backend === 'qwen' ? 'Qwen Image · 本地' : 'GPT Image · 远端';
}

function dateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function jobStatusLabel(status: PlanJob['status']): string {
  return { queued: '排队中', running: '正在执行', reconciling: '状态待核对', candidate: '合并候选已就绪', failed: '执行失败', cancelled: '已取消' }[status];
}

export function ProposalReview({
  proposals,
  selectedProposalId,
  selectedProposal,
  activeProposal,
  draft,
  regions,
  selectedRegion,
  selectedRegionId,
  annotationKind,
  tool,
  brushSize,
  projectRevision,
  loading,
  dirty,
  busy,
  error,
  qwenAvailable,
  qwenReason,
  gptAvailable,
  gptReason,
  gptExecutionAvailable,
  projectId,
  currentBaseVersionId,
  imageWidth,
  imageHeight,
  pendingPlanSubmission,
  executionStorageAvailable,
  executionBusy,
  executionError,
  executionJob,
  permissions,
  permissionsLoading,
  permissionsError,
  permissionCreating,
  busyGrantId,
  selectedGrantId,
  matchingGptGrants,
  onPermissionRefresh,
  onCreatePermission,
  onRevokePermission,
  onSelectGrant,
  onRefresh,
  onSelect,
  onStartEditing,
  onCancel,
  onDraftChange,
  onToggleSuggestion,
  onAnnotationKindChange,
  onRegionSelect,
  onAddRegion,
  onUpdateRegion,
  onDeleteRegion,
  onBrushSizeChange,
  onSave,
  onConfirm,
  onExecute,
  onCopyDocument,
  onExit,
}: ProposalReviewProps) {
  const proposal = activeProposal ?? selectedProposal;
  const isEditing = Boolean(activeProposal);
  const isEditable = isEditing && proposal?.status === 'draft';
  const proposalRegions = activeProposal ? regions : proposal?.regions ?? regions;
  const suggestionRows = (draft?.suggestions ?? proposal?.suggestions ?? []).map(suggestion => ({
    suggestion,
    region: proposalRegions.find(item => item.id === suggestion.regionId),
  }));
  const enabledEdits = suggestionRows.filter(({ suggestion, region }) => suggestion.enabled && region?.kind === 'edit' && region.shapes.length > 0);
  const keepRegions = proposalRegions.filter(region => region.kind === 'keep');
  const confirmedTarget = proposal?.confirmation?.processing;
  const selectedGptGrant = matchingGptGrants.find(grant => grant.id === selectedGrantId);

  return (
    <div className="inspector-scroll proposal-inspector">
      <ProjectPermissions
        projectId={projectId}
        baseVersionId={currentBaseVersionId}
        permissions={permissions}
        gptAvailable={gptAvailable}
        gptReason={gptReason}
        loading={permissionsLoading}
        error={permissionsError}
        busyGrantId={busyGrantId}
        creating={permissionCreating}
        onRefresh={onPermissionRefresh}
        onCreate={onCreatePermission}
        onRevoke={onRevokePermission}
      />
      <div className="proposal-heading-row">
        <div className="inspector-heading"><div className="eyebrow">AGENT PROPOSALS</div><h2>建议审阅</h2><p>提议先保存在草稿中；只有你确认后才写入正式标注。</p></div>
        <button type="button" className="icon-button proposal-refresh" onClick={onRefresh} disabled={loading || busy === 'proposal-refresh'} aria-label="刷新建议" title="刷新建议"><ArrowCounterClockwise size={17} /></button>
      </div>

      {error && <div className="proposal-error" role="alert"><Info size={17} /><span>{error}</span></div>}

      <section className="proposal-list-section" aria-label="项目建议列表">
        <div className="panel-label-row"><span>项目建议</span><span>{loading ? '读取中…' : proposals.length}</span></div>
        {proposals.length ? <div className="proposal-list">{proposals.map(item => (
          <article className={item.id === selectedProposalId ? 'proposal-list-item selected' : 'proposal-list-item'} key={item.id}>
            <button type="button" className="proposal-list-select" onClick={() => onSelect(item.id)} aria-current={item.id === selectedProposalId ? 'true' : undefined}>
              <span className={`proposal-status-dot status-${item.status}`} />
              <span className="proposal-list-copy"><strong>{item.title || '未命名建议'}</strong><small>{statusLabel[item.status]} · {dateLabel(item.updatedAt)}</small></span>
            </button>
            {item.status === 'draft' && <button type="button" className="proposal-cancel" aria-label={`取消建议：${item.title}`} title="取消建议" onClick={() => onCancel(item)} disabled={busy === 'proposal-cancel' || activeProposal?.id === item.id && dirty}><X size={15} /></button>}
          </article>
        ))}</div> : <div className="proposal-empty"><Clock size={23} /><strong>{loading ? '正在读取建议' : '还没有 Agent 建议'}</strong><span>{loading ? '列表会从本地项目服务加载。' : '外部 Agent 可通过 MCP 为此项目创建独立草稿，随后在这里审阅。'}</span></div>}
      </section>

      {proposal && (
        <section className="proposal-detail" aria-label="建议详情">
          <div className="proposal-detail-head"><span className={`proposal-status-pill status-${proposal.status}`}>{statusLabel[proposal.status]}</span><span>提议修订 {proposal.revision}</span></div>
          <button type="button" className="button button-outline full-button proposal-document-button" onClick={onCopyDocument} disabled={busy === 'proposal-document' || busy === 'proposal-save'}><FileCode size={16} />{busy === 'proposal-document' ? '正在准备 JSON…' : '复制计划 JSON'}</button>
          {isEditable && draft ? (
            <>
              <label className="field-label">建议名称<input value={draft.title} maxLength={120} onChange={event => onDraftChange({ title: event.target.value })} /></label>
              <label className="field-label">修饰目标<textarea value={draft.goal} maxLength={2000} onChange={event => onDraftChange({ goal: event.target.value })} /></label>
              <label className="field-label">处理后端<select value={draft.backend} onChange={event => onDraftChange({ backend: event.target.value as ImageBackend })}><option value="qwen">Qwen Image · 本地</option><option value="gpt">GPT Image · 远端</option></select></label>
            </>
          ) : (
            <>
              <h3>{proposal.title || '未命名建议'}</h3>
              <p className="proposal-goal">{proposal.goal || '未提供修饰目标。'}</p>
              <div className="proposal-meta"><span>后端</span><strong>{backendLabel(proposal.backend)}</strong><span>来源</span><strong>{proposal.source === 'agent' ? 'Agent' : '人工'}</strong><span>依据项目修订</span><strong>{proposal.confirmation?.projectRevision ?? proposal.projectRevision} {(proposal.confirmation?.projectRevision ?? proposal.projectRevision) === projectRevision ? '· 当前' : '· 已变化'}</strong></div>
            </>
          )}

          {isEditable && <>
            <div className="annotation-switch proposal-annotation-switch" role="group" aria-label="建议区域类型">
              <button type="button" className={annotationKind === 'edit' ? 'active edit-choice' : ''} onClick={() => { onAnnotationKindChange('edit'); if (selectedRegion && selectedRegion.kind !== 'edit') onUpdateRegion(selectedRegion.id, { kind: 'edit' }); }}>编辑范围</button>
              <button type="button" className={annotationKind === 'keep' ? 'active keep-choice' : ''} onClick={() => { onAnnotationKindChange('keep'); if (selectedRegion && selectedRegion.kind !== 'keep') onUpdateRegion(selectedRegion.id, { kind: 'keep' }); }}><LockKey size={15} />保护范围</button>
            </div>
            <div className="proposal-region-editor">
              <div className="panel-label-row"><span>画布区域</span><span>{regions.length}</span></div>
              <div className="proposal-region-list">{regions.map(region => (
                <div className={selectedRegionId === region.id ? `proposal-region-row selected ${region.kind}` : `proposal-region-row ${region.kind}`} key={region.id}>
                  <button type="button" onClick={() => onRegionSelect(region)}><span className={`region-swatch ${region.kind}`}>{region.kind === 'keep' ? <LockKey size={12} /> : null}</span><span><strong>{region.name}</strong><small>{region.kind === 'edit' ? '编辑' : '保护'} · {region.shapes.length} 个形状</small></span></button>
                  {selectedRegionId === region.id && <button type="button" className="proposal-region-delete" onClick={() => onDeleteRegion(region.id)} aria-label={`删除${region.name}`}><X size={14} /></button>}
                </div>
              ))}</div>
              <div className="region-add-row"><button type="button" onClick={() => onAddRegion('edit')}>＋ 新建编辑区</button><button type="button" onClick={() => onAddRegion('keep')}><LockKey size={14} />新建保护区</button></div>
              {selectedRegion ? <>
                <label className="field-label">区域名称<input value={selectedRegion.name} maxLength={64} onChange={event => onUpdateRegion(selectedRegion.id, { name: event.target.value })} /></label>
                <label className="field-label">局部意图<textarea value={selectedRegion.intent} maxLength={2000} placeholder={selectedRegion.kind === 'edit' ? '描述要修改什么，以及哪些细节需要保留…' : '描述此区域需要保护的对象…'} onChange={event => onUpdateRegion(selectedRegion.id, { intent: event.target.value })} /></label>
                {selectedRegion.kind === 'edit' && <RegionContextControl region={selectedRegion} width={imageWidth} height={imageHeight} onChange={context => onUpdateRegion(selectedRegion.id, { context })} />}
                <div className="slider-field"><div className="slider-heading"><label htmlFor="proposal-feather">向内羽化</label><span>{selectedRegion.feather} px</span></div><input id="proposal-feather" type="range" min="0" max="64" value={selectedRegion.feather} onChange={event => onUpdateRegion(selectedRegion.id, { feather: Number(event.target.value) })} /><small>羽化向区域内收，不扩大编辑范围。</small></div>
                {(tool === 'brush' || tool === 'erase') && <div className="slider-field brush-setting"><div className="slider-heading"><label htmlFor="proposal-brush-size">{tool === 'erase' ? '橡皮直径' : '画笔直径'}</label><span>{brushSize} px</span></div><input id="proposal-brush-size" type="range" min="1" max="512" value={brushSize} onChange={event => onBrushSizeChange(Number(event.target.value))} /></div>}
              </> : <div className="proposal-no-region">选择已有区域，或先新建编辑区 / 保护区。</div>}
            </div>
          </>}

          {(isEditable ? draft?.suggestions : proposal.suggestions)?.length ? (
            <div className="proposal-suggestions">
              <div className="panel-label-row"><span>编辑建议</span><span>{enabledEdits.length} 项启用</span></div>
              {(isEditable ? draft?.suggestions : proposal.suggestions)?.map(suggestion => {
                const region = proposalRegions.find(item => item.id === suggestion.regionId);
                return <div className="proposal-suggestion" key={suggestion.regionId}>
                  <div className="proposal-suggestion-head">
                    <strong>{region?.name ?? `区域 ${suggestion.regionId.slice(0, 8)}`}</strong>
                    <button type="button" className={`switch ${suggestion.enabled ? 'on' : ''}`} role="switch" aria-checked={suggestion.enabled} aria-label={`${region?.name ?? '建议区域'}${suggestion.enabled ? '已启用' : '已停用'}`} disabled={!isEditable} onClick={() => onToggleSuggestion(suggestion.regionId)}><span /></button>
                  </div>
                  <p>{suggestion.reason || 'Agent 未填写建议原因。'}</p>
                  <div className="proposal-suggestion-foot"><span>{region ? `${region.kind === 'edit' ? '编辑' : '保护'}区域 · ${region.shapes.length} 个形状` : '找不到对应区域'}</span>{suggestion.confidence !== undefined && <span>置信度 {Math.round(suggestion.confidence * 100)}%</span>}</div>
                </div>;
              })}
            </div>
          ) : <div className="proposal-empty compact"><strong>没有编辑建议项</strong><span>此计划尚未指定可执行的编辑区域。</span></div>}

          <div className="proposal-protection">
            <div className="panel-label-row"><span><ShieldCheck size={15} />保护对象</span><span>{keepRegions.length}</span></div>
            {keepRegions.length ? keepRegions.map(region => <div className="protection-item" key={region.id}><LockKey size={14} /><span><strong>{region.name}</strong><small>{region.intent || '保持此区域不变'} · {region.shapes.length} 个形状</small></span></div>) : <p className="helper-text">当前没有额外保护区域；请确认照片主体与需要保留的细节。</p>}
          </div>

          {proposal.status === 'confirmed' && proposal.confirmation && <div className="proposal-confirmed" role="status"><CheckCircle size={18} /><span><strong>已确认，等待 Agent 续跑</strong><small>确认编号 {proposal.confirmation.id}</small></span></div>}
          {proposal.status === 'stale' && <p className="proposal-stale-note">项目基准或正式标注已变化。此建议不能按旧修订确认，请让 Agent 基于当前项目创建新建议。</p>}

          {proposal.status === 'confirmed' && proposal.confirmation && <div className="proposal-execution">
            {proposal.backend === 'gpt' ? <>
              <p className="proposal-execution-note">此计划指定 GPT Image · 远端{confirmedTarget ? ` · ${confirmedTarget.destination} · ${confirmedTarget.modelId}` : ''}。图片会发送到该远端处理服务。</p>
              {matchingGptGrants.length ? <label className="field-label permission-job-grant-select">选择此计划使用的有效授权<select value={selectedGrantId} onChange={event => onSelectGrant(event.target.value)} disabled={pendingPlanSubmission}><option value="">请选择授权，不会自动选择</option>{matchingGptGrants.map(grant => <option key={grant.id} value={grant.id}>{grant.id.slice(0, 8)} · 已用 {grant.consumedJobs}/{grant.maxJobs ?? '不限'} 个计划作业</option>)}</select></label> : <p className="helper-text">{pendingPlanSubmission ? '这份提交待核对；继续时会复用本地保存的 grantId 和幂等键。' : '没有匹配当前照片基准与处理目的地的有效 GPT generation 授权。请先在上方“项目图像授权”创建授权。'}</p>}
              {permissions?.remoteGenerationEnabled === false && <p className="proposal-execution-note">远端图像生成当前已关闭。</p>}
            </> : <div className="proposal-execution-note">此计划使用 Qwen 本地处理；不会向远端发送照片。</div>}
            <button type="button" className="button button-dark full-button" onClick={onExecute} disabled={dirty || proposal.backend === 'gpt' && !gptExecutionAvailable && !executionJob || proposal.backend === 'gpt' && !selectedGptGrant && !executionJob && !pendingPlanSubmission || proposal.backend === 'qwen' && !qwenAvailable && !executionJob && !pendingPlanSubmission || !executionStorageAvailable && !executionJob && !pendingPlanSubmission || executionBusy}><CheckCircle size={17} />{executionBusy ? '正在提交 / 核对…' : executionJob ? '查看执行进度' : pendingPlanSubmission ? '使用原授权和幂等键继续' : '执行已确认计划'}</button>
            {proposal.backend === 'gpt' && !gptAvailable && gptReason && <p className="helper-text">{gptReason}</p>}
            {proposal.backend === 'qwen' && !qwenAvailable && <p className="helper-text">{qwenReason || '本地 Qwen 当前不可用。已有任务仍可查询。'}</p>}
            {!executionStorageAvailable && !executionJob && <p className="helper-text">本地幂等记录不可用；新执行已禁用，避免重复任务。</p>}
            {dirty && <p className="helper-text">存在未保存的本地改动；保存或放弃后才能执行已确认快照。</p>}
            {executionError && <p className="proposal-execution-error" role="alert">{executionError}</p>}
            {executionJob && <div className={`proposal-job-summary state-${executionJob.status}`}>
              <strong>{jobStatusLabel(executionJob.status)}</strong>
              {executionJob.backend && <span>{executionJob.backend === 'gpt' ? 'GPT Image · 远端' : 'Qwen · 本地'}</span>}
              {executionJob.grantId && <span>授权 {executionJob.grantId.slice(0, 8)}</span>}
              {executionJob.stepCount && <span>{executionJob.status === 'queued' ? `等待第 ${Math.max(1, (executionJob.stepIndex ?? 0) + 1)}/${executionJob.stepCount} 步` : executionJob.status === 'candidate' ? `步骤 ${executionJob.stepCount}/${executionJob.stepCount} · 全部完成` : `步骤 ${Math.max(1, (executionJob.stepIndex ?? 0) + 1)}/${executionJob.stepCount}`}</span>}
                {executionJob.waitReason && <small role="status">{executionJob.waitReason}</small>}
                {executionJob.error && <small>{executionJob.error}</small>}
            </div>}
          </div>}

          {isEditing ? <>
            <div className="proposal-editor-note"><PencilSimple size={16} /><span>{proposal.status === 'draft' ? '画布正在显示这份建议草稿。画笔、擦除、矩形与磁性套索的修改只写入提议。' : '画布正在显示此建议快照，当前为只读状态。退出后可查看最新正式标注。'}</span></div>
            <div className="proposal-actions">
              <button type="button" className="button button-outline full-button" onClick={onSave} disabled={!dirty || !isEditable || busy === 'proposal-save' || busy === 'proposal-confirm'}>{busy === 'proposal-save' ? '正在保存…' : '保存建议修改'}</button>
              <button type="button" className="button button-dark full-button" onClick={onConfirm} disabled={!isEditable || enabledEdits.length === 0 || busy === 'proposal-save' || busy === 'proposal-confirm'}><CheckCircle size={17} />{busy === 'proposal-confirm' ? '正在确认…' : dirty ? '保存并确认此计划' : '确认此计划'}</button>
              {dirty && <span className="helper-text">未保存改动只保留在当前页面；保存冲突时草稿会留在此处。</span>}
              <button type="button" className="text-button proposal-exit-button" onClick={onExit}>退出建议，查看正式标注</button>
            </div>
          </> : proposal.status === 'draft' ? <button type="button" className="button button-dark full-button" onClick={() => onStartEditing(proposal)} disabled={busy === 'proposal-load'}><PencilSimple size={17} />在画布中审阅与调整</button> : null}
        </section>
      )}
    </div>
  );
}
