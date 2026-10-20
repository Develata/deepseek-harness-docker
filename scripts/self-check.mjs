// Opt-in, offline, non-root diagnostics. Does not start DSH, install or compile.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, accessSync, constants } from 'node:fs';
import { checkExecutable, checkRuntimeIdentity, checkWritableDirectories } from './runtime-checks.mjs';

process.umask(0o077);
try {
  checkRuntimeIdentity();
  checkWritableDirectories();
  const lock = JSON.parse(readFileSync('/opt/dsh-wrapper/toolchains.lock.json', 'utf8'));
  assert.equal(process.versions.node, lock.versions.node);
  const checks = [
    ['bun', ['--version'], lock.versions.bun], ['python3', ['--version'], 'Python 3.'],
    ['rustc', ['--version'], lock.versions.rust], ['cargo', ['--version'], 'cargo '],
    ['rustup', ['--version'], lock.versions.rustup], ['cargo', ['fmt', '--version'], 'rustfmt '],
    ['cargo', ['clippy', '--version'], 'clippy '],
    ['cargo', ['binstall', '--version'], lock.versions['cargo-binstall']],
    ['cargo', ['clean-all', '--version'], lock.versions['cargo-clean-all']],
    ['sccache', ['--version'], lock.versions.sccache], ['codegraph', ['--version'], lock.versions.codegraph],
  ];
  checkExecutable('dsh');
  for (const [command, args, expected] of checks) {
    checkExecutable(command);
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, `${command} failed`);
    assert.ok(result.stdout.includes(expected), `${command} version mismatch`);
    console.log(`OK: ${command}${args.length > 1 ? ' ' + args[0] : ''}`);
  }
  assert.equal(realpathSync(checkExecutable('codegraph')),
    '/opt/bun-global/node_modules/@colbymchenry/codegraph/npm-shim.js');
  for (const path of ['/opt/rustup', '/opt/rust-cargo', '/opt/bun-global', '/opt/toolchain-bin']) {
    let writable = false;
    try { accessSync(path, constants.W_OK); writable = true; } catch {}
    assert.equal(writable, false, 'Image tools must remain read-only to the runtime user');
  }
  console.log('Self-check passed: non-root tools and writable data/home/workspace/tmp. No DSH, model, install or build started.');
} catch {
  console.error('Self-check failed. Check image tool availability and mount permissions; child output suppressed.');
  process.exitCode = 1;
}
