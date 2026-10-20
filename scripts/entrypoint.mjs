// DSH rejects wildcard bind addresses. Bind one concrete container interface.
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import { prepareHomes } from './prepare-homes.mjs';
process.umask(0o077);
prepareHomes();
const addresses = [...new Set(Object.values(networkInterfaces()).flat()
  .filter(row => row && row.family === 'IPv4' && !row.internal)
  .map(row => row.address))];
if (addresses.length !== 1) throw new Error('Expected one container IPv4 interface. Use a single private Docker bridge network.');
const child = spawn('dsh', ['web', '--no-open', '--host', addresses[0], '--port', '3080',
  '--public-url', 'http://127.0.0.1:3080/', ...process.argv.slice(2)], { stdio: 'inherit' });
let timer;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  child.kill('SIGTERM');
  timer ??= setTimeout(() => child.kill('SIGKILL'), 20000);
});
child.once('error', () => console.error('Could not launch the official DSH executable.'));
child.once('close', code => { clearTimeout(timer); process.exit(code ?? 1); });
