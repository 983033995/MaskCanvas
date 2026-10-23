import test from 'node:test';
import assert from 'node:assert/strict';
import { api, getPendingJobSubmissions, getPendingPlanJobSubmissions } from './api.js';
import type { AnnotationDocument, ProposalInput } from '../packages/shared/types.js';

test('browser submission keeps the same idempotency key after an ambiguous timeout', async () => {
  const storage = new Map<string, string>();
  const originalFetch = globalThis.fetch;
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } });
  const sent: { idempotencyKey: string }[] = [];
  let attempt = 0;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    sent.push(JSON.parse(init.body as string));
    if (attempt++ === 0) throw new TypeError('ambiguous connection loss');
    return Response.json({ id: 'confirmed-job', status: 'queued' });
  }) as typeof fetch;
  try {
    await assert.rejects(api.createJob('project-a', 2, 'region-a'), /connection loss/);
    assert.equal(getPendingJobSubmissions().length, 1);
    globalThis.fetch = (async () => Response.json({ error: { code: 'INVALID_SESSION', message: 'session changed' } }, { status: 403 })) as typeof fetch;
    await assert.rejects(api.createJob('project-a', 2, 'region-a'), /session changed/);
    assert.equal(getPendingJobSubmissions()[0].idempotencyKey, sent[0].idempotencyKey);
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string));
      return Response.json({ id: 'confirmed-job', status: 'queued' });
    }) as typeof fetch;
    await api.createJob('project-a', 2, 'region-a');
    assert.equal(sent[0].idempotencyKey, sent[1].idempotencyKey);
    assert.equal(getPendingJobSubmissions().length, 0);
    globalThis.fetch = (async () => Response.json({ error: { code: 'REVISION_CONFLICT', message: 'stale' } }, { status: 409 })) as typeof fetch;
    await assert.rejects(api.createJob('project-a', 3, 'region-a'), /stale/);
    assert.equal(getPendingJobSubmissions().length, 0);
    storage.set('maskcanvas.pendingJobs.v1', 'not json');
    await assert.rejects(api.createJob('project-a', 4, 'region-a'), /避免重复生成/);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldStorage) Object.defineProperty(globalThis, 'sessionStorage', oldStorage);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});

test('normal annotation/proposal imports remain strict while rebind uses an explicit target route', async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; method: string; body?: unknown; token?: string | null }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url === '/api/session') return Response.json({ token: 'test-session' });
    requests.push({
      url,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      token: new Headers(init.headers).get('x-maskcanvas-token'),
    });
    return Response.json({ id: 'proposal-1', projectId: 'project-1', status: 'draft' });
  }) as typeof fetch;
  try {
    await api.openSession();
    const input: ProposalInput = {
      title: '发丝修整', goal: '保留发际线', backend: 'qwen', source: 'agent',
      baseVersionId: 'base-1', projectRevision: 4,
      regions: [], suggestions: [{ regionId: 'hair-1', reason: '边缘碎发', enabled: true, confidence: 0.88 }],
    };
    await api.getProposals('project/one');
    await api.createProposal('project-1', input);
    await api.getProposal('project-1', 'proposal/one');
    await api.getProposalDocument('project-1', 'proposal/one');
    await api.patchProposal('project-1', 'proposal-1', { revision: 2, goal: '收窄边界' });
    await api.confirmProposal('project-1', 'proposal-1', 3, 4);
    await api.cancelProposal('project-1', 'proposal-1', 5);
    const annotations: AnnotationDocument = {
      format: 'maskcanvas.annotations', schemaVersion: 1, projectId: 'source-project', baseVersionId: 'source-base', revision: 7,
      image: { assetUri: 'maskcanvas://source', sha256: 'a'.repeat(64), width: 10, height: 8, colourSpace: 'srgb', coordinates: 'original-pixels' },
      regions: [],
    };
    await api.importAnnotations(annotations);
    await api.rebindJson('target-project', annotations);

    assert.deepEqual(requests.map(({ url, method }) => [url, method]), [
      ['/api/projects/project%2Fone/proposals', 'GET'],
      ['/api/projects/project-1/proposals', 'POST'],
      ['/api/projects/project-1/proposals/proposal%2Fone', 'GET'],
      ['/api/projects/project-1/proposals/proposal%2Fone/document', 'GET'],
      ['/api/projects/project-1/proposals/proposal-1', 'PATCH'],
      ['/api/projects/project-1/proposals/proposal-1/confirm', 'POST'],
      ['/api/projects/project-1/proposals/proposal-1/cancel', 'POST'],
      ['/api/projects/source-project/annotations', 'POST'],
      ['/api/projects/target-project/rebind-json', 'POST'],
    ]);
    assert.equal(requests[0].token, 'test-session');
    assert.deepEqual(requests[1].body, input);
    assert.deepEqual(requests[4].body, { revision: 2, goal: '收窄边界' });
    assert.deepEqual(requests[5].body, { revision: 3, projectRevision: 4 });
    assert.deepEqual(requests[6].body, { revision: 5 });
    assert.deepEqual(requests[7].body, { document: annotations });
    assert.deepEqual(requests[8].body, { document: annotations });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('project permission API uses scoped routes and never creates a grant without an explicit input', async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; method: string; body?: unknown; token?: string | null }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url === '/api/session') return Response.json({ token: 'permission-session' });
    requests.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined, token: new Headers(init.headers).get('x-maskcanvas-token') });
    return Response.json({ grants: [], processing: {}, remoteGenerationEnabled: false });
  }) as typeof fetch;
  try {
    await api.openSession();
    await api.getProjectPermissions('project-1');
    const input = { baseVersionId: 'base-1', purpose: 'generation' as const, backend: 'gpt' as const, destination: 'https://images.example', maxJobs: 1, expiresAt: '2026-10-22T13:00:00.000Z' };
    await api.createProjectGrant('project-1', input);
    await api.revokeProjectGrant('project-1', 'grant-1');

    assert.deepEqual(requests.map(({ url, method }) => [url, method]), [
      ['/api/projects/project-1/permissions', 'GET'],
      ['/api/projects/project-1/permissions', 'POST'],
      ['/api/projects/project-1/permissions/grant-1/revoke', 'POST'],
    ]);
    assert.equal(requests[0].token, 'permission-session');
    assert.deepEqual(requests[1].body, input);
    assert.deepEqual(requests[2].body, {});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('plan execution persists and reuses one idempotency key after an ambiguous response', async () => {
  const originalFetch = globalThis.fetch;
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } });
  const requests: { url: string; body?: Record<string, string> }[] = [];
  let planAttempt = 0;
  const grantId = 'grant-for-gpt-plan';
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url === '/api/session') return Response.json({ token: 'test-session' });
    requests.push({ url, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    if (url.endsWith('/plan-jobs') && planAttempt++ === 0) throw new TypeError('ambiguous plan response');
    if (url.endsWith('/plan-jobs')) return Response.json({ id: 'plan-job-1', projectId: 'project-1', proposalId: 'proposal-1', confirmationId: 'confirm-1', grantId, backend: 'gpt', status: 'queued' });
    if (url === '/api/jobs/plan-job-1') return Response.json({ id: 'plan-job-1', projectId: 'project-1', proposalId: 'proposal-1', confirmationId: 'confirm-1', grantId, backend: 'gpt', status: 'queued' });
    throw new Error(`Unexpected request ${url}`);
  }) as typeof fetch;
  try {
    await api.openSession();
    await assert.rejects(api.createPlanJob('project-1', 'proposal-1', 'confirm-1', grantId), /ambiguous plan response/);
    const pending = getPendingPlanJobSubmissions('project-1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].grantId, grantId);
    const originalKey = pending[0].idempotencyKey;

    await assert.rejects(api.createPlanJob('project-1', 'proposal-1', 'confirm-1', 'different-grant'), /原授权/);
    const submitted = await api.createPlanJob('project-1', 'proposal-1', 'confirm-1', grantId);
    assert.equal(submitted.id, 'plan-job-1');
    assert.equal(getPendingPlanJobSubmissions('project-1')[0].idempotencyKey, originalKey);
    assert.equal(getPendingPlanJobSubmissions('project-1')[0].jobId, 'plan-job-1');
    assert.equal(getPendingPlanJobSubmissions('project-1')[0].grantId, grantId);

    const recovered = await api.createPlanJob('project-1', 'proposal-1', 'confirm-1', grantId);
    assert.equal(recovered.id, 'plan-job-1');
    assert.equal(requests.filter(item => item.url.endsWith('/plan-jobs')).length, 2);
    assert.deepEqual(requests.filter(item => item.url.endsWith('/plan-jobs')).map(item => item.body?.idempotencyKey), [originalKey, originalKey]);
    assert.deepEqual(requests.filter(item => item.url.endsWith('/plan-jobs')).map(item => item.body?.grantId), [grantId, grantId]);
    assert.equal(requests.filter(item => item.url === '/api/jobs/plan-job-1').length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
