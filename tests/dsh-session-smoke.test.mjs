import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifySession } from '../scripts/dsh-session-smoke.mjs';

// These verify the test oracle with fake services, NOT installed DSH integration.
function fixture({ names = ['mcp__codegraph__codegraph_explore'], title } = {}) {
  const session = { header: { cwd: '/workspace' } };
  const agent = { session, status: 'idle' };
  const seen = [];
  const ctx = {
    sessionController: {
      async create(request) { seen.push(request); return { sessionId: request.sessionId }; },
      async rename(request) { title = request.title; },
    },
    agents: { get: () => agent }, sessions: { get: () => session, flush: async () => true },
    sessionTitle: { get: () => title === undefined ? undefined : { title } },
    tools: { schemas(scope) { assert.equal(scope, agent); return names.map(name => ({ name })); } },
  };
  return { ctx, seen, agent };
}
const options = { nonce: 'a'.repeat(32), cycle: '1', expected: '1' };
test('uses actual session controller and exact agent-scoped names, never a global-only catalog', async () => {
  const { ctx, seen } = fixture();
  assert.deepEqual(await verifySession(ctx, options), { ok: true, cycle: '1', mcpEnabled: true, sessionResumed: false });
  assert.deepEqual(seen, [{ sessionId: 'image-smoke-' + 'a'.repeat(32), cwd: '/workspace' }]);
});
test('missing or duplicate namespace cannot masquerade as successful integration', async () => {
  for (const names of [[], ['codegraph_explore'], Array(2).fill('mcp__codegraph__codegraph_explore')]) {
    await assert.rejects(verifySession(fixture({ names }).ctx, options));
  }
});
test('disabled control must have no CodeGraph namespace', async () => {
  assert.equal((await verifySession(fixture({ names: [] }).ctx, { ...options, expected: '0' })).mcpEnabled, false);
  for (const names of [['mcp__codegraph__other'], ['mcp__codegraph__codegraph_explore']]) {
    await assert.rejects(verifySession(fixture({ names }).ctx, { ...options, expected: '0' }));
  }
});
test('second cycle cannot recreate a missing persistence title and still pass', async () => {
  await assert.rejects(verifySession(fixture().ctx, { ...options, cycle: '2' }));
  assert.equal((await verifySession(fixture({ title: 'Image persistence probe' }).ctx,
    { ...options, cycle: '2' })).sessionResumed, true);
});
test('a running agent or unsuccessful durability checkpoint fails the test', async () => {
  const running = fixture(); running.agent.status = 'running';
  await assert.rejects(verifySession(running.ctx, options));
  const unflushed = fixture(); unflushed.ctx.sessions.flush = async () => false;
  await assert.rejects(verifySession(unflushed.ctx, options));
});
test('observer diagnostics identify a fixed stage without forwarding service errors', async () => {
  const stages = [];
  const ctx = fixture().ctx;
  ctx.sessionTitle.get = () => { throw new Error('sensitive-sentinel-not-for-logs'); };
  await assert.rejects(verifySession(ctx, { ...options, onStage: value => stages.push(value) }));
  assert.deepEqual(stages, ['create', 'agent', 'rename', 'title']);
});
