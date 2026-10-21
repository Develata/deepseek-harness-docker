// Opt-in offline diagnostics. Does not start DSH, install or compile.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, accessSync, statSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkExecutable, checkRootDataDirectories, checkRuntimeIdentity, checkWritableDirectories, ROOT_DEVELOPMENT_NOTICE } from './runtime-checks.mjs';

const versions = ['node-version', 'bun-version', 'python-version', 'rustc-version', 'cargo-version',
  'rustup-version', 'rustfmt-version', 'clippy-version', 'binstall-version', 'clean-all-version',
  'sccache-version', 'codegraph-version', 'gh-version'];
export const DIAGNOSTIC_STAGES = {
  self: ['preflight', 'lock-read', 'dsh-executable', ...versions, 'codegraph-launcher', 'immutable-tools', 'root-tool-layout'],
  tools: ['identity', 'persistence-read', 'self-check', 'lock-read', ...versions, 'python-venv', 'rustup-active',
    'gh-config',
    'codegraph-path', 'codegraph-launcher', 'codegraph-node', 'rust-layout', 'rust-fixture', 'rust-build',
    'rust-execute', 'rust-build-sccache', 'sccache-stats', 'sccache-stop', 'persistence-write',
    'cargo-persistence', 'mcp-spawn', 'mcp-initialize', 'mcp-tools', 'mcp-shutdown', 'mcp-no-index'],
  backend: ['token-input', 'interface', 'anonymous-root', 'invalid-token', 'anonymous-api',
    'token-exchange', 'redirect', 'cookie', 'authenticated-root', 'html'],
};
const ERRORS = new Set(['ERR_ASSERTION', 'ENOENT', 'EACCES', 'EPERM', 'EROFS', 'ENOSPC',
  'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOBUFS', 'protocol', 'unknown']);
const SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGILL', 'SIGBUS', 'SIGINT']);
const scalar = (value, min, max) => Number.isInteger(value) && value >= min && value <= max ? value : null;
// Shared with disposable CI probes. This cannot serialize paths, command lines,
// output, expected versions, error messages or additional object properties.
export function safeDiagnostic(source, stage, fields = {}) {
  if (typeof source !== 'string' || typeof stage !== 'string'
    || !Object.hasOwn(DIAGNOSTIC_STAGES, source) || !DIAGNOSTIC_STAGES[source].includes(stage)) return null;
  return { source, stage, exit: scalar(fields.exit, -128, 255),
    signal: SIGNALS.has(fields.signal) ? fields.signal : null,
    error: fields.error == null ? null : ERRORS.has(fields.error) ? fields.error : 'unknown',
    stdoutMatch: typeof fields.stdoutMatch === 'boolean' ? fields.stdoutMatch : null,
    stderrMatch: typeof fields.stderrMatch === 'boolean' ? fields.stderrMatch : null,
    httpStatus: scalar(fields.httpStatus, 100, 599) };
}
export function commandFacts(result, expected) {
  const match = output => expected === undefined ? null : expected instanceof RegExp
    ? expected.test(typeof output === 'string' ? output : '')
    : (typeof output === 'string' ? output : '').includes(expected);
  return { exit: result.status, signal: result.signal, error: result.error?.code,
    stdoutMatch: match(result.stdout), stderrMatch: match(result.stderr) };
}
export function parseDiagnostic(line) {
  if (!line.startsWith('DSH_CHECK ') || line.length > 2048) return null;
  try { const value = JSON.parse(line.slice(10)); return safeDiagnostic(value.source, value.stage, value); }
  catch { return null; }
}
export function emitDiagnostic(value) {
  const safe = value && safeDiagnostic(value.source, value.stage, value);
  if (safe) console.error('DSH_CHECK ' + JSON.stringify(safe));
}

export function checkImageToolDirectories(mode, { realpath = realpathSync, stat = statSync, access = accessSync } = {}) {
  assert.ok(['non-root', 'root-development'].includes(mode), 'Unknown runtime mode');
  for (const path of ['/opt/rustup', '/opt/rust-cargo', '/opt/bun-global', '/opt/toolchain-bin']) {
    assert.equal(realpath(path), path, 'Unexpected image tool directory layout');
    assert.ok(stat(path).isDirectory(), 'Image tool path must be a directory');
    access(path, constants.R_OK | constants.X_OK);
    if (mode === 'non-root') {
      let writable = false;
      try { access(path, constants.W_OK); writable = true; } catch {}
      assert.equal(writable, false, 'Image tools must remain read-only to the runtime user');
    }
  }
}

export function selfCheck() {
  process.umask(0o077);
  let diagnostic;
  const stage = label => { diagnostic = safeDiagnostic('self', label); };
  stage('preflight');
  try {
    const mode = checkRuntimeIdentity();
    if (mode === 'root-development') {
      checkRootDataDirectories();
      console.error(ROOT_DEVELOPMENT_NOTICE);
    }
    checkWritableDirectories();
    stage('lock-read');
    const lock = JSON.parse(readFileSync('/opt/dsh-wrapper/toolchains.lock.json', 'utf8'));
    stage('node-version');
    assert.equal(process.versions.node, lock.versions.node);
    const checks = [
      ['gh-version', 'gh', ['--version'], `gh version ${lock.versions.gh} `],
      ['bun-version', 'bun', ['--version'], lock.versions.bun], ['python-version', 'python3', ['--version'], 'Python 3.'],
      ['rustc-version', 'rustc', ['--version'], lock.versions.rust], ['cargo-version', 'cargo', ['--version'], 'cargo '],
      ['rustup-version', 'rustup', ['--version'], lock.versions.rustup], ['rustfmt-version', 'cargo', ['fmt', '--version'], 'rustfmt '],
      ['clippy-version', 'cargo', ['clippy', '--version'], 'clippy '],
      ['binstall-version', 'cargo', ['binstall', '-V'], lock.versions['cargo-binstall']],
      ['clean-all-version', 'cargo', ['clean-all', '--version'], lock.versions['cargo-clean-all']],
      ['sccache-version', 'sccache', ['--version'], lock.versions.sccache], ['codegraph-version', 'codegraph', ['--version'], lock.versions.codegraph],
    ];
    stage('dsh-executable');
    checkExecutable('dsh');
    for (const [label, command, args, expected] of checks) {
      stage(label);
      checkExecutable(command);
      const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15000,
        ...(command === 'gh' ? { env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' } } : {}) });
      diagnostic = safeDiagnostic('self', label, commandFacts(result, expected));
      assert.equal(result.status, 0, `${command} failed`);
      assert.ok(result.stdout.includes(expected), `${command} version mismatch`);
      console.log(`OK: ${command}${args.length > 1 ? ' ' + args[0] : ''}`);
    }
    stage('codegraph-launcher');
    assert.equal(realpathSync(checkExecutable('codegraph')),
      '/opt/bun-global/node_modules/@colbymchenry/codegraph/npm-shim.js');
    stage(mode === 'non-root' ? 'immutable-tools' : 'root-tool-layout');
    checkImageToolDirectories(mode);
    console.log(mode === 'non-root'
      ? 'Self-check passed: non-root tools and writable data/home/workspace/tmp. No DSH, model, install or build started.'
      : 'Self-check passed in root development mode: pinned tools and writable data/home/workspace/tmp. Image-tool immutability was not asserted. No DSH, model, install or build started.');
  } catch (error) {
    emitDiagnostic({ ...diagnostic, error: diagnostic.error ?? error?.code ?? 'unknown' });
    console.error('Self-check failed. Check image tool availability and mount permissions; child output suppressed.');
    process.exitCode = 1;
  }
}
// Importing the scalar-only helpers in CI tests must not launch the self-check.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) selfCheck();
