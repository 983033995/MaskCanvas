import { ArrowCounterClockwise, LockKey, ShieldCheck, WarningCircle } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import type { ProjectGrant, ProjectGrantInput, ProjectPermissions as ProjectPermissionsSnapshot } from './api';

interface ProjectPermissionsProps {
  projectId: string;
  baseVersionId: string;
  permissions: ProjectPermissionsSnapshot | null;
  gptAvailable: boolean;
  gptReason: string;
  loading: boolean;
  error: string;
  busyGrantId: string | null;
  creating: boolean;
  onRefresh: () => void;
  onCreate: (input: ProjectGrantInput) => void;
  onRevoke: (grant: ProjectGrant) => void;
}

const agentClients = [
  { value: 'client:codex', label: 'Codex' },
  { value: 'client:workbuddy', label: 'WorkBuddy' },
  { value: 'client:qoder', label: 'Qoder' },
  { value: 'client:external-agent', label: '其他 Agent' },
] as const;

function grantStatus(grant: ProjectGrant, currentBaseVersionId: string): { label: string; state: string } {
  if (grant.revokedAt) return { label: `已手动撤销 · ${formatDate(grant.revokedAt)}`, state: 'revoked' };
  if (grant.baseVersionId !== currentBaseVersionId) return { label: '照片基准已变化', state: 'stale' };
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) return { label: `已过期 · ${formatDate(grant.expiresAt)}`, state: 'expired' };
  if (grant.maxJobs !== undefined && grant.consumedJobs >= grant.maxJobs) return { label: '额度已用完', state: 'exhausted' };
  return { label: '有效', state: 'active' };
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function clientLabel(destination: string): string {
  return agentClients.find(client => client.value === destination)?.label ?? destination;
}

function expiresInOneHour(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

export function ProjectPermissions({
  projectId,
  baseVersionId,
  permissions,
  gptAvailable: capabilityGptAvailable,
  gptReason,
  loading,
  error,
  busyGrantId,
  creating,
  onRefresh,
  onCreate,
  onRevoke,
}: ProjectPermissionsProps) {
  const [expanded, setExpanded] = useState(false);
  const [analysisClient, setAnalysisClient] = useState<(typeof agentClients)[number]['value']>('client:codex');
  const [analysisConsent, setAnalysisConsent] = useState(false);
  useEffect(() => { setAnalysisConsent(false); }, [projectId, baseVersionId]);
  const generationTarget = permissions?.processing.gpt;
  const gptAvailable = Boolean(permissions?.remoteGenerationEnabled && capabilityGptAvailable && generationTarget?.destination && generationTarget.modelId);
  const grants = permissions?.grants ?? [];

  const createAnalysisGrant = () => {
    onCreate({
      baseVersionId,
      purpose: 'analysis',
      backend: 'agent',
      destination: analysisClient,
      expiresAt: expiresInOneHour(),
    });
    setAnalysisConsent(false);
  };

  const createGptGrant = () => {
    if (!generationTarget?.destination || !generationTarget.modelId || !gptAvailable) return;
    onCreate({
      baseVersionId,
      purpose: 'generation',
      backend: 'gpt',
      destination: generationTarget.destination,
      maxJobs: 1,
      expiresAt: expiresInOneHour(),
    });
  };

  return (
    <section className="project-permissions" aria-labelledby="project-permissions-title">
      <button type="button" className="permissions-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        <span className="permissions-title"><ShieldCheck size={17} /><span><strong id="project-permissions-title">项目图像授权</strong><small>仅对当前基准照片有效；每项授权均可撤销</small></span></span>
        <span className="permissions-count">{grants.length} 项</span>
      </button>
      {expanded && <div className="permissions-content">
        <div className="permissions-topline"><span>当前照片基准 <code>{baseVersionId}</code></span><button type="button" className="permissions-refresh" aria-label="刷新项目授权" onClick={onRefresh} disabled={loading}><ArrowCounterClockwise size={15} /></button></div>
        {error && <p className="permissions-error" role="alert"><WarningCircle size={15} />{error}</p>}
        {!permissions && !loading && !error && <p className="permissions-muted">尚未读取项目授权状态。</p>}

        <div className="permission-create-block">
          <h3>允许 Agent 分析当前图像</h3>
          <p>这会允许所选客户端读取当前项目图像用于分析。客户端可能使用远端模型；此授权不会允许生成。</p>
          <label className="field-label">分析客户端<select value={analysisClient} onChange={event => { setAnalysisClient(event.target.value as typeof analysisClient); setAnalysisConsent(false); }}>
            {agentClients.map(client => <option key={client.value} value={client.value}>{client.label}</option>)}
          </select></label>
          <label className="permission-consent"><input type="checkbox" checked={analysisConsent} onChange={event => setAnalysisConsent(event.target.checked)} /><span>我允许 {clientLabel(analysisClient)} 客户端分析当前项目图像</span></label>
          <button type="button" className="button button-outline full-button" onClick={createAnalysisGrant} disabled={!analysisConsent || creating || loading || !permissions}>{creating ? '正在创建授权…' : '授权图像分析 · 1 小时'}</button>
        </div>

        <div className="permission-create-block generation-permission-block">
          <h3>允许 GPT Image 生成</h3>
          {gptAvailable ? <>
            <p>图片会经下面的 ComfyUI 节点转发至 GPT 远端服务；最终云服务路由由该节点的私有配置决定。此授权最多允许提交 1 个确认计划作业，并在 1 小时后过期。多区域计划可能触发多次远端生成/API 请求；额度按计划作业计数。</p>
            <div className="permission-target"><span>目的地</span><strong>{generationTarget?.destination}</strong><span>模型</span><strong>{generationTarget?.modelId}</strong></div>
            <button type="button" className="button button-dark full-button" onClick={createGptGrant} disabled={creating || loading}>{creating ? '正在创建授权…' : '授权 GPT Image · 1 个计划作业'}</button>
          </> : <>
            <p className="permissions-unavailable">远端 GPT Image 当前未配置或未启用，不会创建授权，也不能执行远端生成。</p>
            {gptReason && <small className="permissions-muted">{gptReason}</small>}
          </>}
        </div>

        <div className="permission-list-heading"><strong>已有授权</strong><span>{grants.length}</span></div>
        {grants.length ? <div className="permission-grant-list">{grants.map(grant => {
          const status = grantStatus(grant, baseVersionId);
          return <article className={`permission-grant permission-${status.state}`} key={grant.id}>
            <div className="permission-grant-top"><span className={`permission-status permission-status-${status.state}`}>{status.label}</span><span>{grant.purpose === 'analysis' ? '图像分析' : '图像生成'} · {grant.backend === 'agent' ? clientLabel(grant.destination) : grant.backend === 'gpt' ? 'GPT Image' : 'Qwen'}</span></div>
            <div className="permission-grant-destination">{grant.destination}</div>
            <div className="permission-grant-meta"><span>创建于 {formatDate(grant.createdAt)}</span><span>{grant.expiresAt ? `到期 ${formatDate(grant.expiresAt)}` : '无到期时间'}</span><span>{grant.backend === 'gpt' && grant.purpose === 'generation' ? `计划作业 ${grant.consumedJobs}/${grant.maxJobs ?? '不限'}` : `授权使用 ${grant.consumedJobs} 次`}</span></div>
            <div className="permission-grant-base">绑定基准：{grant.baseVersionId}</div>
            {!grant.revokedAt && <button type="button" className="text-button permission-revoke" onClick={() => onRevoke(grant)} disabled={busyGrantId === grant.id}><LockKey size={14} />{busyGrantId === grant.id ? '正在撤销…' : '手动撤销'}</button>}
          </article>;
        })}</div> : <p className="permissions-muted">当前项目没有授权。未勾选并点击授权按钮之前，不会创建任何授权。</p>}
      </div>}
      <span className="sr-only">项目 {projectId} 的授权状态</span>
    </section>
  );
}
