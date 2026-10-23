import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Project } from '../packages/shared/types.js';

export class LocalClient {
  private token?: string;
  readonly baseUrl: string;
  constructor(url = process.env.MASKCANVAS_URL ?? 'http://127.0.0.1:7317') {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('MCP 仅连接本机 MaskCanvas HTTP 根地址');
    this.baseUrl = parsed.origin;
  }
  async request(route: string, body?: unknown, method = 'POST'): Promise<any> {
    if (!this.token && body !== undefined) this.token = (await this.request('/api/session')).token;
    const response = await fetch(this.baseUrl + route, { method: body === undefined ? 'GET' : method, headers: { 'Content-Type': 'application/json', ...(this.token ? { 'x-maskcanvas-token': this.token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000), redirect: 'error' });
    const value = await response.json();
    if (!response.ok) throw new Error(`${value.error?.code ?? response.status}: ${value.error?.message ?? '请求失败'}`);
    return value;
  }
  async binary(route: string) {
    const response = await fetch(this.baseUrl + route, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!response.ok) throw new Error(`读取资产失败 HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
}

const point = z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() });
const subtract = z.boolean().optional();
const shape = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rect'), x: z.number().nonnegative(), y: z.number().nonnegative(), width: z.number().positive(), height: z.number().positive(), subtract }),
  z.object({ type: z.literal('brush'), points: z.array(point).min(1).max(10000), radius: z.number().positive(), subtract }),
  z.object({ type: z.literal('polygon'), points: z.array(point).min(3).max(10000), subtract }),
]);
const region = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), name: z.string().min(1).max(120), kind: z.enum(['edit', 'keep']), intent: z.string().max(4000), feather: z.number().min(0).max(512), shapes: z.array(shape).max(200), context: z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative(), width: z.number().finite().positive(), height: z.number().finite().positive() }).strict().optional() });
const projectId = z.string().uuid();
const revision = z.number().int().nonnegative();
const textResult = (value: any) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const p = (id: string) => `/api/projects/${encodeURIComponent(id)}`;
async function fileData(file: string, limit = 50 * 1024 * 1024) {
  if (!path.isAbsolute(file)) throw new Error('文件路径必须为绝对路径');
  if ((await stat(file)).size > limit) throw new Error('文件超过大小限制');
  return readFile(file);
}

export function createMcpServer(client = new LocalClient(), options: { allowAgentImages?: boolean; clientIdentity?: string } = {}) {
  // Legacy process flags never grant access to every project's photos.
  const allowImages = false;
  const clientIdentity = options.clientIdentity ?? process.env.MASKCANVAS_AGENT_CLIENT ?? 'client:external-agent';
  if (!['client:codex', 'client:workbuddy', 'client:qoder', 'client:external-agent'].includes(clientIdentity)) throw new Error('MASKCANVAS_AGENT_CLIENT 不是支持的客户端标识');
  const server = new McpServer({ name: 'maskcanvas', version: '0.1.0' }, { instructions: 'MaskCanvas 与本地画布共享项目，常规交接只用 JSON 和独立图片引用。用户给图后用 canvas_open 导入，再基于规范基准创建 canvas_create_proposal 草稿，canvas_open_editor 返回建议链接让用户审阅。查询 canvas_get_proposal，只有服务端 confirmed 且 confirmation 匹配时才 canvas_submit_plan。没有 MCP 确认或创建授权工具，Agent 不可冒充用户确认。修改计划、标注、基准或处理目的地会使旧确认失效。生成返回 job ID，查询原任务，不换幂等键重发。保护优先，候选需范围与视觉验收。识别来自调用方 Agent。观察图片须用户在编辑器授予当前照片和分析客户端的项目权限，并提供匹配的grantId和destination。GPT需远端显式配置及当前图片生成授权；进程开关不替代项目权限，不静默换模型或目的地。' });
  const tool = (name: string, description: string, schema: Record<string, z.ZodType>, handler: (args: any) => Promise<any>, readOnly = false) => {
    server.registerTool(name, { description, inputSchema: schema, annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false } }, async (args) => {
      try { return await handler(args); }
      catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : '操作失败' }] }; }
    });
  };
  tool('canvas_capabilities', '查询本地编辑、Qwen 与视觉能力，不提交生成。', {}, async () => textResult({ ...(await client.request('/api/capabilities')), agentImagesAllowed: allowImages, clientIdentity, imageAccess: 'per-project-grant' }), true);
  tool('canvas_list_projects', '列出本地项目。', {}, async () => textResult(await client.request('/api/projects')), true);
  tool('canvas_open', '导入明确指定的本机 JPEG/PNG，创建不可变基准，不上传云端。', { imagePath: z.string(), name: z.string().min(1).max(120) }, async ({ imagePath, name }) => {
    const bytes = await fileData(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    if (!['.jpg', '.jpeg', '.png'].includes(ext)) throw new Error('仅支持 JPEG/PNG');
    const project = await client.request('/api/projects', { name, imageDataUrl: `data:image/${ext === '.png' ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}` });
    const annotations = await client.request(`${p(project.id)}/annotations`);
    return textResult({ project, image: annotations.image, url: `${client.baseUrl}/?project=${project.id}` });
  });
  tool('canvas_get_project', '读取项目、原图坐标区域、版本和验收报告；不返回照片字节。', { projectId }, async ({ projectId }) => textResult(await client.request(p(projectId))), true);
  tool('canvas_get_annotations', '取得可直接交接的一段标注 JSON：图片引用/哈希、基准、revision、区域/保护/意图；不打包、不返回照片字节。', { projectId }, async ({ projectId }) => textResult(await client.request(`${p(projectId)}/annotations`)), true);
  tool('canvas_import_annotations', '将标注 JSON 载入同一项目供使用者检查。校验图片/基准/revision；只修改标注，不生成、不代表用户已确认计划。', { projectId, document: z.unknown() }, async ({ projectId, document }) => textResult(await client.request(`${p(projectId)}/annotations`, { document })));
  tool('canvas_create_proposal', '创建待用户确认的独立修图建议，不覆盖正式标注、不生成。范围按规范基准原图坐标，keep全部强保护，每个edit须一条建议。', {
    projectId, title: z.string().min(1).max(160), goal: z.string().min(1).max(4000),
    backend: z.enum(['qwen', 'gpt']), baseVersionId: z.string(), projectRevision: revision,
    regions: z.array(region).max(200),
    suggestions: z.array(z.object({ regionId: z.string(), reason: z.string().min(1).max(2000), enabled: z.boolean(), confidence: z.number().min(0).max(1).optional() })).max(200),
  }, async ({ projectId, ...body }) => {
    const proposal = await client.request(`${p(projectId)}/proposals`, { ...body, source: 'agent' });
    return textResult({ proposal, url: `${client.baseUrl}/?project=${projectId}&proposal=${proposal.id}`, generationStarted: false });
  });
  tool('canvas_list_proposals', '列出项目建议与当前确认/失效状态。不返回图片。', { projectId }, async ({ projectId }) => textResult(await client.request(`${p(projectId)}/proposals`)), true);
  tool('canvas_get_proposal', '取得完整计划 JSON、图片引用/哈希和服务端当前确认状态。确认只对当前基准有效，不把导出的确认当跨设备授权。', { projectId, proposalId: z.string().uuid() }, async ({ projectId, proposalId }) => textResult(await client.request(`${p(projectId)}/proposals/${proposalId}/document`)), true);
  tool('canvas_update_proposal', '按建议revision修改草稿。修改已确认计划会撤销旧确认，必须再次请用户在编辑器确认。', {
    projectId, proposalId: z.string().uuid(), revision,
    title: z.string().min(1).max(160).optional(), goal: z.string().min(1).max(4000).optional(), backend: z.enum(['qwen', 'gpt']).optional(),
    regions: z.array(region).max(200).optional(),
    suggestions: z.array(z.object({ regionId: z.string(), reason: z.string().min(1).max(2000), enabled: z.boolean(), confidence: z.number().min(0).max(1).optional() })).max(200).optional(),
  }, async ({ projectId, proposalId, ...body }) => textResult(await client.request(`${p(projectId)}/proposals/${proposalId}`, body, 'PATCH')));
  tool('canvas_import_proposal', '导入同图同版本的计划 JSON 为新的待审草稿。外来status/confirmation绝不能确认或执行，也不覆盖人工标注。', { projectId, document: z.unknown() }, async ({ projectId, document }) => textResult(await client.request(`${p(projectId)}/proposal-documents`, { document })));
  tool('canvas_rebind_json', '显式将外来标注/计划JSON绑定已导入的目标照片；核对规范图片哈希，不读任意路径，只创建待审草稿。须用户明确要求图片重绑定。', { targetProjectId: projectId, document: z.unknown() }, async ({ targetProjectId, document }) => textResult(await client.request(`${p(targetProjectId)}/rebind-json`, { document })));
  tool('canvas_open_editor', '返回项目或指定建议的审阅链接，供调用方打开给用户确认；不直接控制浏览器、不提交生成。', { projectId, proposalId: z.string().uuid().optional() }, async ({ projectId, proposalId }) => {
    const project: Project = await client.request(p(projectId));
    if (proposalId) await client.request(`${p(projectId)}/proposals/${proposalId}`);
    return textResult({ projectId, revision: project.revision, baseVersionId: project.baseVersionId, url: `${client.baseUrl}/?project=${project.id}${proposalId ? `&proposal=${proposalId}` : ''}`, action: proposalId ? 'review_proposal' : 'review_annotations', generationStarted: false });
  }, true);
  tool('canvas_set_regions', '按原图像素坐标保存区域；支持矩形/笔画/多边形与擦除，keep 为硬保护。revision 不匹配返回冲突，不覆盖。', { projectId, revision, regions: z.array(region).max(200) }, async ({ projectId, revision, regions }) => textResult(await client.request(`${p(projectId)}/regions`, { revision, regions }, 'PUT')));
  tool('canvas_observe', '观察当前照片或其候选，必须提供用户在编辑器授予的当前项目分析grantId及匹配的客户端destination；进程开关不替代授权。', { projectId, versionId: z.string().optional(), grantId: z.string().uuid().optional(), destination: z.string().optional() }, async ({ projectId, versionId, grantId, destination }) => {
    if (!grantId) throw new Error('AGENT_IMAGES_DISABLED: 请用户在编辑器为当前照片和实际分析客户端授权，再提供 grantId。');
    if (destination && destination !== clientIdentity) throw new Error('CLIENT_IDENTITY_MISMATCH: destination 与本 MCP 连接的可信客户端配置不一致');
    const observed = await client.request(`${p(projectId)}/observe`, { grantId, destination: clientIdentity, ...(versionId ? { versionId } : {}) });
    return { content: [{ type: 'text' as const, text: `${observed.width}×${observed.height} 版本 ${observed.versionId}` }, { type: 'image' as const, data: observed.data, mimeType: 'image/png' }] };
  }, true);
  tool('canvas_get_permissions', '查询当前项目中匹配本连接客户端身份的分析授权及生成授权，不能自行授权。客户端标识不表示其模型一定在本地。', { projectId }, async ({ projectId }) => {
    const permissions = await client.request(`${p(projectId)}/permissions`);
    return textResult({ ...permissions, clientIdentity, grants: permissions.grants.filter((grant: { purpose: string; destination: string }) => grant.purpose !== 'analysis' || grant.destination === clientIdentity) });
  }, true);
  tool('canvas_import_candidate', '导入同尺寸的外部候选图，按当前 edit/keep 蒙版本地合成并检查；不会直接接受。', { projectId, revision, baseVersionId: z.string(), regionId: z.string(), imagePath: z.string() }, async ({ projectId, imagePath, ...rest }) => {
    const bytes = await fileData(imagePath);
    return textResult(await client.request(`${p(projectId)}/candidates`, { ...rest, imageDataUrl: `data:image/png;base64,${bytes.toString('base64')}` }));
  });
  const planSubmission = { projectId, proposalId: z.string().uuid(), confirmationId: z.string().uuid(), idempotencyKey: z.string().uuid(), grantId: z.string().uuid().optional() };
  const submitPlan = async ({ projectId, ...body }: { projectId: string; proposalId: string; confirmationId: string; idempotencyKey: string; grantId?: string }) => textResult(await client.request(`${p(projectId)}/plan-jobs`, body));
  tool('canvas_submit_plan', '按用户已确认快照执行整份计划；启用edit按顺序生成，keep强保护。须真实服务端confirmationId，草稿/过期/伪造确认拒绝。返回job后只查询原ID。', planSubmission, submitPlan);
  tool('canvas_submit_qwen', '兼容名称：执行已确认Qwen计划，同canvas_submit_plan，不能绕过用户确认。', planSubmission, submitPlan);
  tool('canvas_get_job', '查询已有作业，不提交生成。', { jobId: z.string().uuid() }, async ({ jobId }) => textResult(await client.request(`/api/jobs/${jobId}`)), true);
  tool('canvas_list_jobs', '查询指定项目的已有作业、候选引用与步骤进度；用于重连后找回原任务，不提交或重发。', { projectId }, async ({ projectId }) => textResult(await client.request(`/api/jobs?projectId=${encodeURIComponent(projectId)}`)), true);
  tool('canvas_accept', '接受已完成像素与视觉检查的候选为新基准。旧 revision 或基准返回冲突。', { projectId, revision, versionId: z.string() }, async ({ projectId, ...body }) => textResult(await client.request(`${p(projectId)}/accept`, body)));
  tool('canvas_reject', '拒绝不满意的候选，保留其图像和历史供追踪，不修改当前基准或标注。', { projectId, revision, versionId: z.string() }, async ({ projectId, ...body }) => textResult(await client.request(`${p(projectId)}/reject`, body)));
  tool('canvas_export', '将标注 JSON 或接受版 PNG 写入明确指定的新文件；PNG须当前照片的本客户端图像授权，JSON不含图片，拒绝覆盖已有文件。', { projectId, format: z.enum(['png', 'json']), outputPath: z.string(), grantId: z.string().uuid().optional() }, async ({ projectId, format, outputPath, grantId }) => {
    if (!path.isAbsolute(outputPath)) throw new Error('输出路径必须为绝对路径');
    if (!outputPath.toLowerCase().endsWith(format === 'png' ? '.png' : '.json')) throw new Error('输出扩展名与格式不符');
    let bytes: Buffer;
    if (format === 'png') {
      if (!grantId) throw new Error('AGENT_IMAGES_DISABLED: PNG 导出需要当前照片的本客户端图像授权');
      const observed = await client.request(`${p(projectId)}/observe`, { grantId, destination: clientIdentity });
      bytes = Buffer.from(observed.data, 'base64');
    } else bytes = Buffer.from(JSON.stringify(await client.request(`${p(projectId)}/annotations`), null, 2) + '\n');
    await writeFile(outputPath, bytes, { flag: 'wx', mode: 0o600 });
    return textResult({ outputPath, bytes: bytes.length });
  });
  return server;
}
