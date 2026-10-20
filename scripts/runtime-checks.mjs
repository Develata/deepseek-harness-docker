// Wrapper-only preflight; leaves upstream auth/configuration decisions to DSH.
import { networkInterfaces, tmpdir } from 'node:os';
import { prepareHomes } from './prepare-homes.mjs';
import { isIP } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { accessSync, constants, mkdirSync, mkdtempSync, renameSync, rmdirSync,
  statSync, unlinkSync, writeFileSync } from 'node:fs';

export class PreflightError extends Error {}
const fail = message => { throw new PreflightError(message); };

export function parseStartup(args, env = process.env, interfaces = networkInterfaces()) {
  const enabled = env.DSH_CODEGRAPH_MCP ?? '1';
  if (!['0', '1'].includes(enabled)) fail('DSH_CODEGRAPH_MCP must be 0 or 1.');
  const local = Object.values(interfaces).flat().filter(Boolean);
  const addresses = [...new Set(local.filter(row => row.family === 'IPv4' && !row.internal)
    .map(row => row.address))];
  const values = new Map();
  const checked = new Set(['--host', '--port', '--public-url', '--tls-cert', '--tls-key', '--patch']);
  for (let i = 0; i < args.length; i++) {
    // Upstream owns unknown/profile flags and their own diagnostics. Do not
    // reinterpret shell syntax, print values, or rebuild the user's argv.
    if (args[i] === '--') break;
    const equals = args[i].indexOf('=');
    const option = equals < 0 ? args[i] : args[i].slice(0, equals);
    if (!checked.has(option)) continue;
    const value = equals < 0 ? args[++i] : args[i].slice(equals + 1);
    if (!value || value.startsWith('--')) fail(`${option} requires a value.`);
    if (option === '--port' && (!/^\d+$/.test(value) || Number(value) > 65535)) {
      fail('--port must be an integer from 0 to 65535 (0 selects an ephemeral port).');
    }
    if (option === '--public-url') {
      let url;
      try { url = new URL(value); } catch { fail('--public-url must be an absolute HTTP(S) root URL.'); }
      const authority = value.slice(value.indexOf('://') + 3).split(/[/\\]/, 1)[0];
      if (!/^https?:\/\//i.test(value) || !authority || authority.includes('@') ||
          /[\x00-\x20\x7f?#]/.test(value) || !['http:', 'https:'].includes(url.protocol)) {
        fail('--public-url must be an HTTP(S) root URL without credentials, whitespace, query or fragment.');
      }
    }
    if (option === '--host') {
      if (!isIP(value) || ['0.0.0.0', '::'].includes(value) || !local.some(row => row.address === value)) {
        fail('--host must be a concrete local interface address, not a hostname or wildcard.');
      }
    }
    values.set(option, value);
  }
  if (values.has('--tls-cert') !== values.has('--tls-key')) fail('--tls-cert and --tls-key must be supplied together.');
  const host = values.get('--host') ?? (addresses.length === 1 ? addresses[0] : undefined);
  if (!host) fail('Expected one container IPv4 interface. Use one private bridge network, or explicitly select a concrete local --host.');
  return { host, mcpEnabled: enabled === '1', port: Number(values.get('--port') ?? 3080) };
}

export function probeDirectory(label, path, { create = true } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail(`${label} must be an absolute directory path.`);
  let probe;
  try {
    if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
    if (!statSync(path).isDirectory()) throw new Error('not a directory');
    // Test create/write/rename/unlink, not just mode bits (ACLs/readonly mounts matter).
    // Only a unique private probe is touched; existing files are never changed.
    probe = mkdtempSync(join(path, '.dsh-preflight-'));
    writeFileSync(join(probe, 'write'), 'ok', { mode: 0o600, flag: 'wx' });
    renameSync(join(probe, 'write'), join(probe, 'renamed'));
    unlinkSync(join(probe, 'renamed'));
    rmdirSync(probe);
    probe = undefined;
  } catch {
    fail(`${label} is not a writable directory for UID ${process.getuid?.() ?? 'unknown'}. Prepare the bind mount on the host; the image will not chmod or chown it.`);
  } finally {
    if (probe) {
      for (const file of ['write', 'renamed']) { try { unlinkSync(join(probe, file)); } catch {} }
      try { rmdirSync(probe); } catch {}
    }
  }
}

export function checkWritableDirectories(env = process.env, cwd = process.cwd()) {
  try { prepareHomes(env); } catch (error) { fail(error.message); }
  const defaults = {
    DSH_HOME: '/data/dsh', HOME: '/data/home', CARGO_HOME: '/data/home/.cargo',
    BUN_INSTALL: '/data/home/.bun', BUN_INSTALL_CACHE_DIR: '/data/home/.cache/bun',
    SCCACHE_DIR: '/data/home/.cache/sccache',
  };
  for (const [label, fallback] of Object.entries(defaults)) probeDirectory(label, env[label] ?? fallback);
  probeDirectory('Working directory', cwd, { create: false });
  probeDirectory('Temporary directory', env.TMPDIR ?? tmpdir(), { create: false });
}

export function checkExecutable(command, env = process.env) {
  const paths = command.includes('/') ? [command] : (env.PATH ?? '').split(':').filter(Boolean).map(dir => join(dir, command));
  for (const path of paths) {
    try { if (statSync(path).isFile()) { accessSync(path, constants.X_OK); return path; } } catch {}
  }
  fail(`${command.includes('/') ? 'Image executable' : command} is unavailable or not executable. Verify the image and PATH; no runtime download was attempted.`);
}

export function checkRuntimeIdentity(uid = process.getuid?.()) {
  if (uid === undefined || uid === 0) fail('Run this image as an unprivileged user (default UID 1000), not root. Prepare mount permissions on the host.');
}
