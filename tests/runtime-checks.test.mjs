import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDshArgs, parseStartup, probeDirectory, checkWritableDirectories, checkRuntimeIdentity, checkExecutable } from '../scripts/runtime-checks.mjs';

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
test('runtime identity rejects root but never chowns', () => {
  assert.throws(() => checkRuntimeIdentity(0), /unprivileged/);
  assert.doesNotThrow(() => checkRuntimeIdentity(1000));
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
const { safeDiagnostic, commandFacts, parseDiagnostic, emitDiagnostic, DIAGNOSTIC_STAGES } =
  await import('../scripts/self-check.mjs');
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
