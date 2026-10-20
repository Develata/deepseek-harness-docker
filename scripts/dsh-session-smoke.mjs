// TEST-ONLY Cordis observer. Mounted into disposable CI containers, never copied
// into the production image. Uses the real Web session controller and registry.
import assert from 'node:assert/strict';
import { writeFileSync, renameSync } from 'node:fs';

export const name = 'image-session-smoke';
export const inject = ['loader', 'sessionController', 'agents', 'sessions', 'tools', 'sessionTitle'];

export function apply(ctx) {
  const nonce = process.env.DSH_SMOKE_NONCE;
  const cycle = process.env.DSH_SMOKE_CYCLE;
  const expected = process.env.DSH_SMOKE_MCP;
  assert.match(nonce ?? '', /^[a-f0-9]{32}$/);
  assert.ok(['1', '2'].includes(cycle));
  assert.ok(['0', '1'].includes(expected));
  const report = `/data/session-smoke-${nonce}-${cycle}.json`;
  const save = value => {
    writeFileSync(report + '.tmp', JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(report + '.tmp', report);
  };
  // Do not await Loader settlement inside apply: that would await this plugin
  // itself. This mirrors the upstream Web readiness announcement lifecycle.
  let stage = 'loader';
  void ctx.loader.await().then(async () => {
    save(await verifySession(ctx, { nonce, cycle, expected, onStage: value => { stage = value; } }));
  }).catch(error => {
    // No upstream errors, serialized tools, paths, logs or credentials escape.
    const codes = new Set(['ERR_ASSERTION', 'ENOENT', 'EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'ETIMEDOUT']);
    const code = codes.has(error?.code) ? error.code : 'unknown';
    try { save({ ok: false, cycle, stage, code }); } catch {}
  });
}

// Exported only so light, fake-service tests can verify the acceptance oracle.
export async function verifySession(ctx, { nonce, cycle, expected, onStage = () => {} }) {
    const sessionId = `image-smoke-${nonce}`;
    onStage('create');
    const created = await ctx.sessionController.create({ sessionId, cwd: '/workspace' });
    assert.equal(created.sessionId, sessionId);
    onStage('agent');
    const agent = ctx.agents.get(sessionId);
    assert.ok(agent && agent.session === ctx.sessions.get(sessionId));
    assert.equal(agent.status, 'idle');
    assert.equal(agent.session.header.cwd, '/workspace');
    const title = 'Image persistence probe';
    onStage('rename');
    if (cycle === '1') await ctx.sessionController.rename({ sessionId, title });
    // Cycle two resumes the SAME persisted session in a new container. An empty
    // replacement home/session cannot pass this assertion by recreating a marker.
    onStage('title');
    assert.equal(ctx.sessionTitle.get(agent.session)?.title, title);
    onStage('tools');
    const names = ctx.tools.schemas(agent).map(tool => tool.name);
    const count = names.filter(name => name === 'mcp__codegraph__codegraph_explore').length;
    assert.equal(count, Number(expected));
    if (expected === '0') assert.ok(!names.some(name => name.startsWith('mcp__codegraph__')));
    assert.equal(names.includes('codegraph_explore'), false);
    onStage('flush');
    assert.equal(await ctx.sessions.flush(agent.session), true);
    return { ok: true, cycle, mcpEnabled: expected === '1', sessionResumed: cycle === '2' };
}
