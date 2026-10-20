// Container-side smoke against a disposable /data and /workspace only.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, accessSync, constants, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60000, ...options });
  // Do not include child output in failures: keep CI output free of arbitrary logs.
  assert.equal(result.status, 0, `${command} failed its smoke check`);
  return result.stdout.trim();
}

async function discoverMcp() {
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
  child.on('error', failPending);
  child.stdin.on('error', failPending);
  child.on('exit', failPending);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { failPending(); return; }
    if (!pending.has(message.id)) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error('MCP JSON-RPC error'));
    else waiter.resolve(message.result);
  });
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP response timed out')); }, 30000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); } });
    send({ id, method, params });
  });
  try {
    const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'dsh-image-smoke', version: '1.0.0' } });
    assert.ok(init?.serverInfo && init?.capabilities?.tools, 'MCP initialize missing tool capability');
    send({ method: 'notifications/initialized' });
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
  } finally {
    child.stdin.end();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    lines.close();
  }
}

async function main() {
  assert.equal(process.getuid(), 1000, 'Must run as UID1000');
  assert.equal(process.arch, 'x64', 'This acceptance suite supports amd64 only');
  const cycle = process.env.DSH_SMOKE_CYCLE;
  assert.ok(['1', '2'].includes(cycle), 'Host smoke must specify its recreation cycle');
  // Assert BEFORE any test recreates its files. Existing previous smoke could
  // pass cycle two after losing all data because it regenerated its own marker.
  const manifest = '/data/home/.dsh-smoke-persistence.json';
  if (cycle === '2') {
    const saved = JSON.parse(readFileSync(manifest, 'utf8'));
    for (const [path, value] of Object.entries(saved)) assert.equal(readFileSync(path, 'utf8'), value);
  } else assert.equal(existsSync(manifest), false, 'First cycle must use fresh fixture data');
  run('node', ['/opt/dsh-wrapper/self-check.mjs']);
  const lock = JSON.parse(readFileSync('/opt/dsh-wrapper/toolchains.lock.json', 'utf8'));
  assert.equal(process.versions.node, lock.versions.node);
  assert.equal(run('bun', ['--version']), lock.versions.bun);
  assert.ok(run('python3', ['--version']).startsWith('Python 3.'));
  run('python3', ['-m', 'venv', '/workspace/python-venv']);
  assert.ok(run('rustc', ['--version']).includes(lock.versions.rust));
  run('cargo', ['--version']);
  assert.ok(run('rustup', ['--version']).includes(lock.versions.rustup));
  run('rustup', ['show', 'active-toolchain']);
  run('cargo', ['fmt', '--version']);
  run('cargo', ['clippy', '--version']);
  assert.ok(run('cargo', ['binstall', '--version']).includes(lock.versions['cargo-binstall']));
  assert.ok(run('cargo', ['clean-all', '--version']).includes(lock.versions['cargo-clean-all']));
  assert.ok(run('sccache', ['--version']).includes(lock.versions.sccache));
  assert.equal(run('sh', ['-c', 'command -v codegraph']), '/opt/bun-global-bin/codegraph');
  assert.equal(realpathSync('/opt/bun-global-bin/codegraph'),
    '/opt/bun-global/node_modules/@colbymchenry/codegraph/npm-shim.js');
  assert.ok(run('codegraph', ['--version']).includes(lock.versions.codegraph));
  const platform = process.arch === 'x64' ? 'x64' : 'arm64';
  const bundledNode = `/opt/bun-global/node_modules/@colbymchenry/codegraph-linux-${platform}/node`;
  assert.match(run(bundledNode, ['--version']), /^v24\./, 'CodeGraph must retain supported bundled Node24');
  assert.equal(process.env.CARGO_HOME, '/data/home/.cargo');
  assert.equal(process.env.RUSTUP_HOME, '/opt/rustup');
  let writable = true;
  try { accessSync('/opt/rustup', constants.W_OK); } catch { writable = false; }
  assert.equal(writable, false, 'Image Rust toolchain unexpectedly writable');
  // Cargo subcommand lookup above proves /opt/toolchain-bin and /opt/rust-cargo/bin
  // work even though CARGO_HOME points to a fresh bind-mounted home.
  mkdirSync('/workspace/rust-fixture/src', { recursive: true });
  writeFileSync('/workspace/rust-fixture/Cargo.toml', '[package]\nname="dsh-smoke"\nversion="0.0.0"\nedition="2021"\n');
  writeFileSync('/workspace/rust-fixture/src/main.rs', 'fn main() { println!("rust-smoke-ok"); }\n');
  run('cargo', ['build', '--offline'], { cwd: '/workspace/rust-fixture' });
  assert.equal(run('/workspace/rust-fixture/target/debug/dsh-smoke'), 'rust-smoke-ok');
  run('cargo', ['build', '--offline'], { cwd: '/workspace/rust-fixture', env: {
    ...process.env, RUSTC_WRAPPER: '/opt/toolchain-bin/sccache', CARGO_INCREMENTAL: '0',
    CARGO_TARGET_DIR: '/workspace/rust-fixture/target-cached',
  } });
  run('sccache', ['--show-stats']);
  run('sccache', ['--stop-server']);
  mkdirSync('/data/home/.cargo/bin', { recursive: true });
  const marker = '/data/home/.cargo/bin/cargo-persistence-probe';
  if (cycle === '1') writeFileSync(marker, '#!/bin/sh\nprintf "persistent-cargo-bin\\n"\n', { mode: 0o755, flag: 'wx' });
  assert.equal(run('cargo', ['persistence-probe']), 'persistent-cargo-bin');
  if (cycle === '1') {
    const saved = { [marker]: readFileSync(marker, 'utf8'),
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
  assert.equal(existsSync('/workspace/.codegraph'), false, 'MCP discovery initialized a project unexpectedly');
  console.log('Toolchain smoke passed: UID1000, pinned tools, Rust compilation, wrapper, persistent Cargo bin and MCP discovery. No model calls.');
}
main().catch(() => {
  console.error('Toolchain smoke failed. Child output and protocol payloads suppressed.');
  process.exitCode = 1;
});
