import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, mkdirSync, chmodSync, constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDshArgs, parseStartup, probeDirectory, checkWritableDirectories, checkRuntimeIdentity, checkRootDataDirectories, checkExecutable, ROOT_DEVELOPMENT_NOTICE } from '../scripts/runtime-checks.mjs';

const interfaces = { lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
  eth0: [{ family: 'IPv4', internal: false, address: '172.18.0.2' }] };
const parse = (args = [], env = {}) => parseStartup(args, env, interfaces);
const fixture = () => mkdtempSync(join(tmpdir(), 'dsh-unit-'));

const webDefaults = ['--no-open', '--host', '172.18.0.2', '--port', '3080',
  '--public-url', 'http://127.0.0.1:3080/'];
test('image MCP patch precedes the first Web argument', () => {
  assert.deepEqual(buildDshArgs([], parse()),
    ['web', '--patch', '/opt/dsh-wrapper/codegraph.cordis.yml', ...webDefaults]);
});
test('empty-bind test patch remains a launcher flag with MCP disabled', () => {
  const args = ['--patch', '/opt/test/dsh-session-smoke.cordis.yml'];
  assert.deepEqual(buildDshArgs(args, parse(args, { DSH_CODEGRAPH_MCP: '0' })),
    ['web', ...args, ...webDefaults]);
});
test('repeated split/equal user patches follow the image patch in original order', () => {
  const args = ['--port', '4321', '--patch', '/user/first.yml', '--trusted-host', 'example.com',
    '--patch=/user/second.yml', '--future-web-flag', 'value'];
  const original = [...args];
  assert.deepEqual(buildDshArgs(args, parse(args)),
    ['web', '--patch', '/opt/dsh-wrapper/codegraph.cordis.yml', '--patch', '/user/first.yml',
      '--patch=/user/second.yml', ...webDefaults, '--port', '4321',
      '--trusted-host', 'example.com', '--future-web-flag', 'value']);
  assert.deepEqual(args, original);
});
test('explicit end-of-options and subsequent literal tokens are not rearranged', () => {
  const args = ['--patch=/user/first.yml', '--', '--patch', 'literal.yml'];
  assert.deepEqual(buildDshArgs(args, parse(args, { DSH_CODEGRAPH_MCP: '0' })),
    ['web', '--patch=/user/first.yml', ...webDefaults, '--', '--patch', 'literal.yml']);
});
test('disabled MCP without user patches preserves the existing Web defaults', () => {
  assert.deepEqual(buildDshArgs([], parse([], { DSH_CODEGRAPH_MCP: '0' })), ['web', ...webDefaults]);
});

test('defaults preserve MCP and fixed runtime port without mutating argv', () => {
  const args = ['--patch', '/user/config.yml', '--unknown', 'value'];
  assert.deepEqual(parse(args), { host: '172.18.0.2', port: 3080, mcpEnabled: true });
  assert.deepEqual(args, ['--patch', '/user/config.yml', '--unknown', 'value']);
});
test('MCP has an explicit opt-out and rejects typos', () => {
  assert.equal(parse([], { DSH_CODEGRAPH_MCP: '0' }).mcpEnabled, false);
  for (const value of ['', 'true', 'false', '2']) assert.throws(() => parse([], { DSH_CODEGRAPH_MCP: value }), /must be 0 or 1/);
});
test('port range and split/equal syntax are validated without echoing inputs', () => {
  for (const value of ['0', '3080', '65535']) assert.equal(parse(['--port=' + value]).port, Number(value));
  assert.equal(parse(['--port', '4321']).port, 4321);
  for (const value of ['-1', '65536', '3.5', 'text', ' 80', '1e3']) assert.throws(() => parse(['--port', value]), /integer/);
  for (const args of [['--port'], ['--port='], ['--port', '--patch']]) assert.throws(() => parse(args), /requires a value/);
});
test('public URL rejects credential and root-address mistakes', () => {
  for (const value of ['https://dsh.example/prefix/', 'http://127.0.0.1:3080']) assert.doesNotThrow(() => parse(['--public-url', value]));
  for (const value of ['ftp://example.com', 'https://', 'https:///prefix', 'https://u:secret@example.com',
    'https://@example.com', 'https://example.com/?secret', 'https://example.com/#fragment', ' https://example.com', 'https://exa\nmple.com']) {
    assert.throws(() => parse(['--public-url', value]), error => !error.message.includes('secret') && /HTTP/.test(error.message));
  }
});
test('TLS values are paired; custom patch and trusted-host are passed through', () => {
  assert.throws(() => parse(['--tls-cert', '/cert']), /supplied together/);
  assert.throws(() => parse(['--tls-key=/key']), /supplied together/);
  assert.doesNotThrow(() => parse(['--tls-cert=/cert', '--tls-key=/key', '--trusted-host', 'example.com', '--patch', '/patch']));
});
test('single interface selection fails closed; explicit concrete interface can disambiguate', () => {
  assert.throws(() => parseStartup([], {}, {}), /Expected one/);
  const multi = { ...interfaces, eth1: [{ family: 'IPv4', internal: false, address: '172.19.0.2' }] };
  assert.throws(() => parseStartup([], {}, multi), /Expected one/);
  assert.equal(parseStartup(['--host=172.19.0.2'], {}, multi).host, '172.19.0.2');
  for (const value of ['0.0.0.0', '::', 'localhost', '192.0.2.1']) assert.throws(() => parse(['--host', value]), /concrete local/);
});
test('default identity rejects root and preserves other non-root UIDs', () => {
  for (const env of [{}, { DSH_ALLOW_ROOT: '0' }]) {
    assert.throws(() => checkRuntimeIdentity(0, env), /unprivileged/);
    for (const uid of [1, 1000, 1001, 65534]) assert.equal(checkRuntimeIdentity(uid, env), 'non-root');
  }
});
test('root development requires BOTH UID 0 and the exact explicit opt-in', () => {
  assert.equal(checkRuntimeIdentity(0, { DSH_ALLOW_ROOT: '1' }), 'root-development');
  for (const uid of [1, 1000, 65534]) {
    assert.throws(() => checkRuntimeIdentity(uid, { DSH_ALLOW_ROOT: '1' }), /requires UID 0/);
  }
  for (const value of ['', 'true', 'false', 'yes', '01', '1 ', '2', null, true, 1, 'secret-value']) {
    for (const uid of [0, 1000]) assert.throws(() => checkRuntimeIdentity(uid, { DSH_ALLOW_ROOT: value }),
      error => error.message === 'DSH_ALLOW_ROOT must be 0 or 1.');
  }
  for (const uid of [null, -1, NaN, 0.5, '0']) assert.throws(() => checkRuntimeIdentity(uid, {}), /verify/);
});

const rootDirectory = (uid = 0) => ({ uid, isDirectory: () => true, isSymbolicLink: () => false });
const missing = () => { throw Object.assign(new Error('sensitive filesystem detail'), { code: 'ENOENT' }); };
test('root home guard checks only three metadata paths; missing homes are allowed', () => {
  const paths = [];
  checkRootDataDirectories({}, path => {
    paths.push(path);
    if (path === '/data') return rootDirectory(1000); // Bind parent can belong to the host user.
    return missing();
  });
  assert.deepEqual(paths, ['/data', '/data/home', '/data/dsh']);
  assert.doesNotThrow(() => checkRootDataDirectories({}, () => rootDirectory()));
});
test('root home guard rejects mixed UID, symlinks, non-directories and inspection failures without repair', () => {
  for (const target of ['/data/home', '/data/dsh']) {
    assert.throws(() => checkRootDataDirectories({}, path => rootDirectory(path === target ? 1000 : 0)), /non-root user/);
  }
  for (const target of ['/data', '/data/home', '/data/dsh']) {
    for (const bad of [
      { ...rootDirectory(), isSymbolicLink: () => true },
      { ...rootDirectory(), isDirectory: () => false },
    ]) assert.throws(() => checkRootDataDirectories({}, path => path === target ? bad : rootDirectory()), /real directory/);
    assert.throws(() => checkRootDataDirectories({}, path => {
      if (path === target) throw Object.assign(new Error('secret-sentinel'), { code: 'EACCES' });
      return rootDirectory();
    }), error => /Cannot inspect/.test(error.message) && !error.message.includes('secret-sentinel'));
  }
  assert.throws(() => checkRootDataDirectories({}, missing), /Cannot inspect Data mount/);
});
test('root home guard rejects custom or ambiguous locations before filesystem access', () => {
  for (const label of ['HOME', 'DSH_HOME']) for (const value of ['/root', '/data/home/../home', 'relative', '', '/private-secret']) {
    let inspected = false;
    assert.throws(() => checkRootDataDirectories({ [label]: value }, () => { inspected = true; return rootDirectory(); }),
      error => /dedicated default/.test(error.message) && !error.message.includes('private-secret'));
    assert.equal(inspected, false);
  }
  assert.match(ROOT_DEVELOPMENT_NOTICE, /UID 0/);
  assert.match(ROOT_DEVELOPMENT_NOTICE, /immutability is not provided/);
});
test('writability probe preserves existing bytes and permissions and cleans only its own files', () => {
  const root = fixture();
  try {
    chmodSync(root, 0o750);
    writeFileSync(join(root, 'existing'), 'untouched');
    probeDirectory('Test', root);
    assert.equal(readFileSync(join(root, 'existing'), 'utf8'), 'untouched');
    assert.deepEqual(readdirSync(root), ['existing']);
    assert.equal(statSync(root).mode & 0o777, 0o750);
    probeDirectory('New', join(root, 'new'));
    assert.equal(statSync(join(root, 'new')).mode & 0o777, 0o700);
  } finally { rmSync(root, { recursive: true }); }
});
test('bad path diagnostics name the setting, not potentially sensitive values', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'secret-file'), 'unchanged');
    assert.throws(() => probeDirectory('HOME', 'relative-secret'), error => error.message === 'HOME must be an absolute directory path.');
    assert.throws(() => probeDirectory('HOME', join(root, 'secret-file')), error => /HOME is not a writable/.test(error.message) && !error.message.includes('secret'));
    assert.equal(readFileSync(join(root, 'secret-file'), 'utf8'), 'unchanged');
    assert.throws(() => probeDirectory('Working directory', join(root, 'missing'), { create: false }), /not a writable directory/);
  } finally { rmSync(root, { recursive: true }); }
});
test('all writable runtime paths are probed using configured absolute paths', () => {
  const root = fixture();
  try {
    const env = Object.fromEntries(['HOME', 'DSH_HOME', 'CARGO_HOME', 'BUN_INSTALL', 'BUN_INSTALL_CACHE_DIR', 'SCCACHE_DIR']
      .map((label, index) => [label, join(root, String(index))]));
    env.TMPDIR = root;
    checkWritableDirectories(env, root);
    for (const path of Object.values(env)) assert.ok(statSync(path).isDirectory());
  } finally { rmSync(root, { recursive: true }); }
});
test('GH/XDG and development package-manager locations are probed only when configured', () => {
  const root = fixture();
  try {
    const labels = ['HOME', 'DSH_HOME', 'CARGO_HOME', 'BUN_INSTALL', 'BUN_INSTALL_CACHE_DIR', 'SCCACHE_DIR',
      'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'npm_config_prefix', 'npm_config_cache', 'BUN_INSTALL_GLOBAL_DIR', 'BUN_INSTALL_BIN'];
    const env = Object.fromEntries(labels.map((label, index) => [label, join(root, String(index))]));
    env.TMPDIR = root;
    checkWritableDirectories(env, root);
    for (const path of Object.values(env)) assert.ok(statSync(path).isDirectory());
    const previous = JSON.stringify(env);
    writeFileSync(join(env.GH_CONFIG_DIR, 'config.yml'), 'prompt: disabled\n', { mode: 0o600 });
    checkWritableDirectories(env, root);
    assert.equal(JSON.stringify(env), previous);
    assert.equal(readFileSync(join(env.GH_CONFIG_DIR, 'config.yml'), 'utf8'), 'prompt: disabled\n');
    assert.equal(statSync(join(env.GH_CONFIG_DIR, 'config.yml')).mode & 0o777, 0o600);
    for (const label of ['npm_config_prefix', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR']) {
      assert.throws(() => checkWritableDirectories({ ...env, [label]: 'private-secret-relative' }, root),
        error => error.message === `${label} must be an absolute directory path.`);
    }
  } finally { rmSync(root, { recursive: true }); }
});
test('executable check does not run or download binaries', () => {
  const root = fixture();
  try {
    const bin = join(root, 'test-tool');
    writeFileSync(bin, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    assert.equal(checkExecutable('test-tool', { PATH: root }), bin);
    assert.throws(() => checkExecutable('missing-tool', { PATH: root }), /unavailable/);
    mkdirSync(join(root, 'not-executable'));
    assert.throws(() => checkExecutable('not-executable', { PATH: root }), /unavailable/);
  } finally { rmSync(root, { recursive: true }); }
});
test('empty /data bind regression: HOME and DSH_HOME are created non-destructively', () => {
  const root = fixture();
  try {
    const data = join(root, 'data'); mkdirSync(data);
    const env = { HOME: join(data, 'home'), DSH_HOME: join(data, 'dsh'), CARGO_HOME: join(data, 'home/.cargo'),
      BUN_INSTALL: join(data, 'home/.bun'), BUN_INSTALL_CACHE_DIR: join(data, 'home/.cache/bun'),
      SCCACHE_DIR: join(data, 'home/.cache/sccache'), TMPDIR: root };
    assert.deepEqual(readdirSync(data), []);
    checkWritableDirectories(env, root);
    assert.ok(statSync(env.HOME).isDirectory());
    assert.ok(statSync(env.DSH_HOME).isDirectory());
    writeFileSync(join(env.HOME, 'preserve'), 'existing');
    checkWritableDirectories(env, root);
    assert.equal(readFileSync(join(env.HOME, 'preserve'), 'utf8'), 'existing');
  } finally { rmSync(root, { recursive: true }); }
});

// Importing helpers must not run the opt-in image self-check or change umask.
const umaskBeforeDiagnosticImport = process.umask();
const { safeDiagnostic, commandFacts, parseDiagnostic, emitDiagnostic, DIAGNOSTIC_STAGES, checkImageToolDirectories } =
  await import('../scripts/self-check.mjs');
test('non-root self-check still fails when image tools are writable', () => {
  const api = { realpath: path => path, stat: () => ({ isDirectory: () => true }), access: () => {} };
  assert.throws(() => checkImageToolDirectories('non-root', api), /read-only/);
  api.access = (_path, mode) => { if (mode === constants.W_OK) throw Object.assign(new Error(), { code: 'EACCES' }); };
  assert.doesNotThrow(() => checkImageToolDirectories('non-root', api));
});
test('root self-check validates layout without asserting image tools are immutable', () => {
  const accessModes = [];
  const api = { realpath: path => path, stat: () => ({ isDirectory: () => true }), access: (_path, mode) => accessModes.push(mode) };
  checkImageToolDirectories('root-development', api);
  assert.equal(accessModes.length, 4);
  assert.ok(accessModes.every(mode => mode === (constants.R_OK | constants.X_OK)));
  for (const mode of ['non-root', 'root-development']) {
    assert.throws(() => checkImageToolDirectories(mode, { ...api, realpath: () => '/unexpected' }), /layout/);
    assert.throws(() => checkImageToolDirectories(mode, { ...api, stat: () => ({ isDirectory: () => false }) }), /directory/);
  }
  assert.throws(() => checkImageToolDirectories('unrecognized', api), /Unknown/);
  assert.ok(safeDiagnostic('self', 'root-tool-layout'));
});
test('diagnostic helpers are inert on import and drop arbitrary child data', () => {
  assert.equal(process.umask(), umaskBeforeDiagnosticImport);
  const secret = 'sensitive-sentinel-not-for-logs';
  const safe = safeDiagnostic('self', 'rustc-version', { exit: secret, signal: secret,
    error: secret, stdoutMatch: secret, stderrMatch: true, httpStatus: secret,
    stdout: secret, stderr: secret, command: secret, path: secret });
  assert.equal(JSON.stringify(safe).includes(secret), false);
  assert.deepEqual(safe, { source: 'self', stage: 'rustc-version', exit: null,
    signal: null, error: 'unknown', stdoutMatch: null, stderrMatch: true, httpStatus: null });
  for (const source of [secret, '__proto__', ['self'], {}, null]) assert.equal(safeDiagnostic(source, 'rustc-version'), null);
  assert.equal(safeDiagnostic('self', secret), null);
});
test('version diagnostics distinguish stdout and stderr without returning their bytes', () => {
  const facts = commandFacts({ status: 0, signal: null, stdout: 'unexpected-sensitive-value',
    stderr: 'expected-version extra-sensitive-value' }, 'expected-version');
  assert.equal(facts.stdoutMatch, false);
  assert.equal(facts.stderrMatch, true);
  assert.equal(JSON.stringify(facts).includes('sensitive'), false);
  assert.deepEqual(safeDiagnostic('tools', 'rust-build', commandFacts({ status: null,
    signal: 'SIGKILL', error: { code: 'ETIMEDOUT', message: 'sensitive' } })),
  { source: 'tools', stage: 'rust-build', exit: null, signal: 'SIGKILL', error: 'ETIMEDOUT',
    stdoutMatch: null, stderrMatch: null, httpStatus: null });
});
test('nested diagnostics are parsed and re-serialized through a closed schema', () => {
  const secret = 'sensitive-sentinel-not-for-logs';
  const value = parseDiagnostic('DSH_CHECK ' + JSON.stringify({ source: 'self', stage: 'binstall-version',
    exit: 127, error: 'ENOENT', stdout: secret, stderr: secret, unexpected: secret }));
  const output = [];
  const original = console.error;
  try { console.error = line => output.push(line); emitDiagnostic(value); }
  finally { console.error = original; }
  assert.equal(output.length, 1);
  assert.equal(output[0].includes(secret), false);
  assert.deepEqual(parseDiagnostic(output[0]), value);
  for (const line of [secret, 'DSH_CHECK null', 'DSH_CHECK {',
    'DSH_CHECK ' + JSON.stringify({ source: secret, stage: 'binstall-version' }),
    'DSH_CHECK ' + 'x'.repeat(2049)]) assert.equal(parseDiagnostic(line), null);
});
test('all explicit tool and backend stages have fixed allowlist entries', () => {
  for (const [file, source] of [['toolchain-smoke.mjs', 'tools'], ['backend-probe.mjs', 'backend']]) {
    const contents = readFileSync(new URL('../scripts/' + file, import.meta.url), 'utf8');
    for (const match of contents.matchAll(/\b(?:stage|run)\('([a-z-]+)'/g)) {
      assert.ok(DIAGNOSTIC_STAGES[source].includes(match[1]), `${file}: ${match[1]}`);
    }
  }
});

// cargo-binstall 1.26.0 uses --version for a package version constraint.
// Its own version is -V; inspect both actual probe declarations without running tools.
for (const file of ['self-check.mjs', 'toolchain-smoke.mjs']) {
  test(`${file} queries cargo-binstall itself with -V, not the install selector`, () => {
    const contents = readFileSync(new URL('../scripts/' + file, import.meta.url), 'utf8');
    const probes = [...contents.matchAll(/'binstall-version',\s*'cargo',\s*(\[[^\]\n]*\])/g)];
    assert.equal(probes.length, 1, 'Expected exactly one cargo-binstall version probe');
    assert.deepEqual(JSON.parse(probes[0][1].replaceAll("'", '"')), ['binstall', '-V']);
  });
}
