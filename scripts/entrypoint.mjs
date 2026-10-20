import { spawn } from 'node:child_process';
import { buildDshArgs, checkExecutable, checkRuntimeIdentity, checkWritableDirectories, parseStartup, PreflightError } from './runtime-checks.mjs';

process.umask(0o077);
try {
  const args = process.argv.slice(2);
  const startup = parseStartup(args);
  checkRuntimeIdentity();
  checkWritableDirectories();
  checkExecutable('dsh');
  if (startup.mcpEnabled) checkExecutable('/opt/bun-global-bin/codegraph');
  const child = spawn('dsh', buildDshArgs(args, startup), { stdio: 'inherit' });
  let timer;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    child.kill('SIGTERM');
    timer ??= setTimeout(() => child.kill('SIGKILL'), 20000);
  });
  child.once('error', () => console.error('Could not launch the official DSH executable.'));
  child.once('close', code => { clearTimeout(timer); process.exit(code ?? 1); });
} catch (error) {
  // Do not print argv, environment, file contents, native credentials or stacks.
  console.error(`DSH preflight: ${error instanceof PreflightError ? error.message : 'Unexpected preflight failure.'}`);
  process.exitCode = 1;
}
