// Container-side smoke against a disposable /data and /workspace only.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, accessSync, constants, realpathSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { safeDiagnostic, commandFacts, parseDiagnostic, emitDiagnostic } from './self-check.mjs';

let diagnostic;
const expectations = {};
function stage(label) { diagnostic = safeDiagnostic('tools', label); }
stage('identity');

function run(label, command, args = [], options = {}) {
  stage(label);
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60000,
    ...(command === 'gh' ? { env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' } } : {}), ...options });
  diagnostic = safeDiagnostic('tools', label, commandFacts(result, expectations[label]));
  // Preserve only recognized scalar diagnostics across the nested capture boundary.
  if (label === 'self-check' && result.status !== 0) {
    for (const line of (result.stderr ?? '').split('\n')) {
      const value = parseDiagnostic(line);
      if (value?.source === 'self') emitDiagnostic(value);
    }
  }
  // Do not include child output in failures: keep CI output free of arbitrary logs.
  assert.equal(result.status, 0, `${command} failed its smoke check`);
  return result.stdout.trim();
}

async function discoverMcp() {
  stage('mcp-spawn');
  const child = spawn('/opt/bun-global-bin/codegraph', ['serve', '--mcp', '--path', '/workspace'], {
    cwd: '/workspace', stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, CODEGRAPH_NO_DOWNLOAD: '1', CODEGRAPH_TELEMETRY: '0' },
  });
  const pending = new Map();
  let nextId = 0;
  const failPending = () => {
    for (const waiter of pending.values()) waiter.reject(new Error('MCP process stopped'));
    pending.clear();
  };
  const failProcess = error => {
    diagnostic = { ...diagnostic, error: error?.code ?? 'unknown' };
    failPending();
  };
  child.on('error', failProcess);
  child.stdin.on('error', failProcess);
  child.on('exit', (code, signal) => {
    diagnostic = { ...diagnostic, exit: code, signal };
    failPending();
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('error', failProcess);
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { diagnostic = { ...diagnostic, error: 'protocol' }; failPending(); return; }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      diagnostic = { ...diagnostic, error: 'protocol' }; failPending(); return;
    }
    if (!pending.has(message.id)) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) { diagnostic = { ...diagnostic, error: 'protocol' }; waiter.reject(new Error('MCP JSON-RPC error')); }
    else waiter.resolve(message.result);
  });
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      diagnostic = { ...diagnostic, error: 'ETIMEDOUT' };
      pending.delete(id); reject(new Error('MCP response timed out'));
    }, 30000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); } });
    send({ id, method, params });
  });
  let complete = false;
  try {
    stage('mcp-initialize');
    const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'dsh-image-smoke', version: '1.0.0' } });
    assert.ok(init?.serverInfo && init?.capabilities?.tools, 'MCP initialize missing tool capability');
    send({ method: 'notifications/initialized' });
    stage('mcp-tools');
    let cursor;
    const tools = [];
    const seen = new Set();
    do {
      const result = await request('tools/list', cursor ? { cursor } : {});
      assert.ok(Array.isArray(result?.tools), 'MCP tools/list malformed');
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (cursor) { assert.ok(!seen.has(cursor), 'MCP cursor repeated'); seen.add(cursor); }
      assert.ok(seen.size <= 20, 'MCP pagination exceeded smoke budget');
    } while (cursor);
    assert.ok(tools.some(tool => tool.name === 'codegraph_explore'), 'CodeGraph explore tool not discovered');
    // No tools/call, project initialization, model/provider request, or external auth.
    complete = true;
  } finally {
    // Keep the actual operation's failure facts; cleanup must not erase them.
    const failure = diagnostic;
    stage('mcp-shutdown');
    child.stdin.end();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    lines.close();
    if (!complete) diagnostic = failure;
  }
}

async function main() {
  process.umask(0o077);
  assert.equal(process.getuid(), 1000, 'Must run as UID1000');
  assert.equal(process.arch, 'x64', 'This acceptance suite supports amd64 only');
  const cycle = process.env.DSH_SMOKE_CYCLE;
  assert.ok(['1', '2'].includes(cycle), 'Host smoke must specify its recreation cycle');
  // Assert BEFORE any test recreates its files. Existing previous smoke could
  // pass cycle two after losing all data because it regenerated its own marker.
  stage('persistence-read');
  const manifest = '/data/home/.dsh-smoke-persistence.json';
  if (cycle === '2') {
    const saved = JSON.parse(readFileSync(manifest, 'utf8'));
    for (const [path, value] of Object.entries(saved)) assert.equal(readFileSync(path, 'utf8'), value);
  } else assert.equal(existsSync(manifest), false, 'First cycle must use fresh fixture data');
  run('self-check', 'node', ['/opt/dsh-wrapper/self-check.mjs']);
  stage('lock-read');
  const lock = JSON.parse(readFileSync('/opt/dsh-wrapper/toolchains.lock.json', 'utf8'));
  Object.assign(expectations, { 'gh-version': `gh version ${lock.versions.gh} `,
    'bun-version': lock.versions.bun, 'python-version': 'Python 3.',
    'rustc-version': lock.versions.rust, 'cargo-version': 'cargo ', 'rustup-version': lock.versions.rustup,
    'rustfmt-version': 'rustfmt ', 'clippy-version': 'clippy ', 'binstall-version': lock.versions['cargo-binstall'],
    'clean-all-version': lock.versions['cargo-clean-all'], 'sccache-version': lock.versions.sccache,
    'codegraph-version': lock.versions.codegraph, 'codegraph-node': /^v24\./ });
  stage('node-version');
  assert.equal(process.versions.node, lock.versions.node);
  assert.ok(run('gh-version', 'gh', ['--version']).startsWith(`gh version ${lock.versions.gh} `));
  // Disposable fixture only: no login, API call, token read or credential helper.
  stage('gh-config');
  assert.equal(process.env.XDG_CONFIG_HOME, '/data/home/.config');
  assert.equal(process.env.GH_CONFIG_DIR, '/data/home/.config/gh');
  const ghConfig = '/data/home/.config/gh/config.yml';
  assert.equal(existsSync('/data/home/.config/gh/hosts.yml'), false);
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
    assert.ok(!process.env[name], 'Smoke must not receive account tokens');
  }
  if (cycle === '1') {
    assert.equal(existsSync(ghConfig), false, 'First cycle needs empty GH config');
    run('gh-config', 'gh', ['config', 'set', 'prompt', 'disabled']);
  }
  assert.equal(run('gh-config', 'gh', ['config', 'get', 'prompt']), 'disabled');
  assert.equal(statSync(ghConfig).mode & 0o777, 0o600);
  assert.equal(statSync(ghConfig).uid, 1000);
  assert.equal(statSync('/data/home/.config/gh').mode & 0o777, 0o700);
  assert.equal(existsSync('/data/home/.config/gh/hosts.yml'), false);
  assert.equal(run('bun-version', 'bun', ['--version']), lock.versions.bun);
  assert.ok(run('python-version', 'python3', ['--version']).startsWith('Python 3.'));
  run('python-venv', 'python3', ['-m', 'venv', '/workspace/python-venv']);
  assert.ok(run('rustc-version', 'rustc', ['--version']).includes(lock.versions.rust));
  run('cargo-version', 'cargo', ['--version']);
  assert.ok(run('rustup-version', 'rustup', ['--version']).includes(lock.versions.rustup));
  run('rustup-active', 'rustup', ['show', 'active-toolchain']);
  run('rustfmt-version', 'cargo', ['fmt', '--version']);
  run('clippy-version', 'cargo', ['clippy', '--version']);
  assert.ok(run('binstall-version', 'cargo', ['binstall', '-V']).includes(lock.versions['cargo-binstall']));
  assert.ok(run('clean-all-version', 'cargo', ['clean-all', '--version']).includes(lock.versions['cargo-clean-all']));
  assert.ok(run('sccache-version', 'sccache', ['--version']).includes(lock.versions.sccache));
  assert.equal(run('codegraph-path', 'sh', ['-c', 'command -v codegraph']), '/opt/bun-global-bin/codegraph');
  stage('codegraph-launcher');
  assert.equal(realpathSync('/opt/bun-global-bin/codegraph'),
    '/opt/bun-global/node_modules/@colbymchenry/codegraph/npm-shim.js');
  assert.ok(run('codegraph-version', 'codegraph', ['--version']).includes(lock.versions.codegraph));
  const platform = process.arch === 'x64' ? 'x64' : 'arm64';
  const bundledNode = `/opt/bun-global/node_modules/@colbymchenry/codegraph-linux-${platform}/node`;
  assert.match(run('codegraph-node', bundledNode, ['--version']), /^v24\./, 'CodeGraph must retain supported bundled Node24');
  stage('rust-layout');
  assert.equal(process.env.CARGO_HOME, '/data/home/.cargo');
  assert.equal(process.env.RUSTUP_HOME, '/opt/rustup');
  let writable = true;
  try { accessSync('/opt/rustup', constants.W_OK); } catch { writable = false; }
  assert.equal(writable, false, 'Image Rust toolchain unexpectedly writable');
  // Cargo subcommand lookup above proves /opt/toolchain-bin and /opt/rust-cargo/bin
  // work even though CARGO_HOME points to a fresh bind-mounted home.
  stage('rust-fixture');
  mkdirSync('/workspace/rust-fixture/src', { recursive: true });
  writeFileSync('/workspace/rust-fixture/Cargo.toml', '[package]\nname="dsh-smoke"\nversion="0.0.0"\nedition="2021"\n');
  writeFileSync('/workspace/rust-fixture/src/main.rs', 'fn main() { println!("rust-smoke-ok"); }\n');
  run('rust-build', 'cargo', ['build', '--offline'], { cwd: '/workspace/rust-fixture' });
  assert.equal(run('rust-execute', '/workspace/rust-fixture/target/debug/dsh-smoke'), 'rust-smoke-ok');
  run('rust-build-sccache', 'cargo', ['build', '--offline'], { cwd: '/workspace/rust-fixture', env: {
    ...process.env, RUSTC_WRAPPER: '/opt/toolchain-bin/sccache', CARGO_INCREMENTAL: '0',
    CARGO_TARGET_DIR: '/workspace/rust-fixture/target-cached',
  } });
  run('sccache-stats', 'sccache', ['--show-stats']);
  run('sccache-stop', 'sccache', ['--stop-server']);
  stage('persistence-write');
  mkdirSync('/data/home/.cargo/bin', { recursive: true });
  const marker = '/data/home/.cargo/bin/cargo-persistence-probe';
  if (cycle === '1') writeFileSync(marker, '#!/bin/sh\nprintf "persistent-cargo-bin\\n"\n', { mode: 0o755, flag: 'wx' });
  assert.equal(run('cargo-persistence', 'cargo', ['persistence-probe']), 'persistent-cargo-bin');
  stage('persistence-write');
  if (cycle === '1') {
    const saved = { [marker]: readFileSync(marker, 'utf8'), [ghConfig]: readFileSync(ghConfig, 'utf8'),
      '/workspace/python-venv/pyvenv.cfg': readFileSync('/workspace/python-venv/pyvenv.cfg', 'utf8') };
    for (const directory of ['/data/home/.cargo/registry', '/data/home/.cache/bun',
      '/data/home/.cache/sccache', '/workspace']) {
      mkdirSync(directory, { recursive: true });
      const path = directory + '/.dsh-persistence-probe';
      const value = randomUUID();
      writeFileSync(path, value, { flag: 'wx', mode: 0o600 });
      saved[path] = value;
    }
    writeFileSync(manifest, JSON.stringify(saved), { flag: 'wx', mode: 0o600 });
  }
  await discoverMcp();
  stage('mcp-no-index');
  assert.equal(existsSync('/workspace/.codegraph'), false, 'MCP discovery initialized a project unexpectedly');
  console.log('Toolchain smoke passed: UID1000, pinned tools, Rust compilation, wrapper, persistent Cargo bin/GH config and MCP discovery. No account login or model calls.');
}
main().catch(error => {
  emitDiagnostic({ ...diagnostic, error: diagnostic.error ?? error?.code ?? 'unknown' });
  console.error('Toolchain smoke failed. Child output and protocol payloads suppressed.');
  process.exitCode = 1;
});
