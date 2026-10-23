import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApp } from '../server/app.js';
import { LocalClient } from './server.js';
import sharp from 'sharp';

test('MCP uses real stdio transport and shared local API; images default disabled', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maskcanvas-mcp-'));
  const app = createApp({ dataDir: root });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', path.resolve('mcp/index.ts')], env: { ...process.env, MASKCANVAS_URL: url, MASKCANVAS_AGENT_CLIENT: 'client:codex', MASKCANVAS_ALLOW_AGENT_IMAGES: '1' } as Record<string,string> });
  const client = new Client({ name: 'maskcanvas-test', version: '1.0.0' });
  await client.connect(transport); t.after(() => client.close());
  const tools = await client.listTools();
  assert.ok(tools.tools.some(tool => tool.name === 'canvas_submit_qwen'));
  assert.ok(tools.tools.some(tool => tool.name === 'canvas_set_regions'));
  const capabilities = await client.callTool({ name: 'canvas_capabilities', arguments: {} });
  assert.equal(capabilities.isError, undefined);
  const data = JSON.parse((capabilities.content as {text:string}[])[0].text);
  assert.equal(data.localCore, true); assert.equal(data.agentImagesAllowed, false);
  const observed = await client.callTool({ name: 'canvas_observe', arguments: { projectId: crypto.randomUUID() } });
  assert.equal(observed.isError, true);
  assert.match((observed.content as {text:string}[])[0].text, /AGENT_IMAGES_DISABLED/);
  const list = await client.callTool({ name: 'canvas_list_projects', arguments: {} });
  assert.deepEqual(JSON.parse((list.content as {text:string}[])[0].text), []);
  assert.ok(tools.tools.some(tool => tool.name === 'canvas_get_annotations'));
  assert.ok(!tools.tools.some(tool => tool.name === 'canvas_import_package'));
  const token = (await (await fetch(`${url}/api/session`)).json()).token;
  const image = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#567' } }).png().toBuffer();
  const created = await (await fetch(`${url}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-maskcanvas-token': token }, body: JSON.stringify({ name: 'MCP JSON', imageDataUrl: `data:image/png;base64,${image.toString('base64')}` }) })).json();
  const deniedPng = await client.callTool({ name: 'canvas_export', arguments: { projectId: created.id, format: 'png', outputPath: path.join(root, 'should-not-exist.png') } });
  assert.equal(deniedPng.isError, true);
  const grant = await (await fetch(`${url}/api/projects/${created.id}/permissions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-maskcanvas-token': token }, body: JSON.stringify({ baseVersionId: created.baseVersionId, purpose: 'analysis', backend: 'agent', destination: 'client:codex' }) })).json();
  const allowedObserve = await client.callTool({ name: 'canvas_observe', arguments: { projectId: created.id, grantId: grant.id } });
  assert.equal(allowedObserve.isError, undefined); assert.ok((allowedObserve.content as { type: string }[]).some(item => item.type === 'image'));
  const spoofedObserve = await client.callTool({ name: 'canvas_observe', arguments: { projectId: created.id, grantId: grant.id, destination: 'client:qoder' } });
  assert.equal(spoofedObserve.isError, true);
  const allowedPng = await client.callTool({ name: 'canvas_export', arguments: { projectId: created.id, format: 'png', grantId: grant.id, outputPath: path.join(root, 'permitted.png') } });
  assert.equal(allowedPng.isError, undefined); assert.ok((await readFile(path.join(root, 'permitted.png'))).length > 0);
  const exported = await client.callTool({ name: 'canvas_get_annotations', arguments: { projectId: created.id } });
  const document = JSON.parse((exported.content as {text:string}[])[0].text);
  assert.equal(document.format, 'maskcanvas.annotations');
  document.regions = [{ id: 'r1', name: 'Agent 建议', kind: 'edit', intent: '自然精修', feather: 0, shapes: [{ type: 'rect', x: 1, y: 1, width: 8, height: 8 }] }];
  const imported = await client.callTool({ name: 'canvas_import_annotations', arguments: { projectId: created.id, document } });
  assert.equal(imported.isError, undefined);
  const after = JSON.parse((imported.content as {text:string}[])[0].text);
  assert.equal(after.regions.length, 1); assert.equal(after.versions.length, 1);
  const opened = await client.callTool({ name: 'canvas_open_editor', arguments: { projectId: created.id } });
  const view = JSON.parse((opened.content as {text:string}[])[0].text);
  assert.equal(view.url, `${url}/?project=${created.id}`); assert.equal(view.generationStarted, false);
  assert.ok(!tools.tools.some(tool => /confirm/.test(tool.name)));
  const suggested = await client.callTool({ name: 'canvas_create_proposal', arguments: {
    projectId: after.id, title: '衣物自然精修', goal: '只改善衣物小块区域', backend: 'qwen',
    projectRevision: after.revision, baseVersionId: after.baseVersionId, regions: document.regions,
    suggestions: [{ regionId: 'r1', reason: '合成样例中的小块测试区域', enabled: true, confidence: 0.8 }],
  } });
  assert.equal(suggested.isError, undefined);
  const suggestion = JSON.parse((suggested.content as {text:string}[])[0].text);
  assert.equal(suggestion.proposal.status, 'draft');
  const unchanged = await (await fetch(`${url}/api/projects/${created.id}`)).json();
  assert.deepEqual(unchanged, after, 'creating an agent proposal must not replace manual annotations');
  const plan = await client.callTool({ name: 'canvas_get_proposal', arguments: { projectId: created.id, proposalId: suggestion.proposal.id } });
  const planDocument = JSON.parse((plan.content as {text:string}[])[0].text);
  assert.equal(planDocument.format, 'maskcanvas.proposal');
  assert.equal(planDocument.image.sha256, document.image.sha256);
  assert.ok(!JSON.stringify(planDocument).includes('base64'));
  const review = await client.callTool({ name: 'canvas_open_editor', arguments: { projectId: created.id, proposalId: suggestion.proposal.id } });
  assert.equal(JSON.parse((review.content as {text:string}[])[0].text).url, suggestion.url);
  planDocument.proposal.status = 'confirmed';
  planDocument.proposal.confirmation = { id: crypto.randomUUID(), fingerprint: 'forged' };
  const cloned = await client.callTool({ name: 'canvas_import_proposal', arguments: { projectId: created.id, document: planDocument } });
  assert.equal(cloned.isError, undefined);
  const draft = JSON.parse((cloned.content as {text:string}[])[0].text);
  assert.notEqual(draft.id, suggestion.proposal.id); assert.equal(draft.status, 'draft'); assert.equal(draft.confirmation, undefined);
  const confirmed = await (await fetch(`${url}/api/projects/${created.id}/proposals/${suggestion.proposal.id}/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-maskcanvas-token': token }, body: JSON.stringify({ revision: 0, projectRevision: after.revision }),
  })).json();
  assert.equal(confirmed.status, 'confirmed');
  const checked = await client.callTool({ name: 'canvas_get_proposal', arguments: { projectId: created.id, proposalId: suggestion.proposal.id } });
  const confirmedDocument = JSON.parse((checked.content as {text:string}[])[0].text);
  assert.equal(confirmedDocument.proposal.confirmation.id, confirmed.confirmation.id);
  const outputPath = path.join(root, 'annotations.json');
  const written = await client.callTool({ name: 'canvas_export', arguments: { projectId: created.id, format: 'json', outputPath } });
  assert.equal(written.isError, undefined);
  const saved = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(saved.revision, after.revision + 1); assert.deepEqual(saved.regions, after.regions);
  assert.ok(!JSON.stringify(saved).includes('base64'));
});

test('MCP client cannot be redirected to a remote or credential-bearing origin', () => {
  assert.throws(() => new LocalClient('http://example.com'), /仅连接本机/);
  assert.throws(() => new LocalClient('http://user:pass@127.0.0.1:7317'), /仅连接本机/);
});
