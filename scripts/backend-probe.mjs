// TEST-ONLY native auth/readiness probe run inside the isolated container.
// Read the launch token on stdin, never argv or output. All output is fixed text.
import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';
import http from 'node:http';

const MAX = 2 * 1024 * 1024;
const host = Object.values(networkInterfaces()).flat()
  .find(row => row && row.family === 'IPv4' && !row.internal)?.address;
async function request(path, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port: 3080, path, timeout: 5000,
      headers: { Host: '127.0.0.1:3080', ...(cookie ? { Cookie: cookie } : {}) } }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; if (data.length > MAX) req.destroy(new Error('size limit')); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
try {
  let token = '';
  for await (const chunk of process.stdin) { token += chunk; assert.ok(token.length <= 512); }
  token = token.trim();
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.ok(host);
  assert.equal((await request('/')).status, 401);
  assert.equal((await request('/?token=invalid-smoke-token')).status, 401);
  assert.equal((await request('/api/remote.mux')).status, 401);
  const exchange = await request('/?token=' + token);
  assert.equal(exchange.status, 303);
  assert.equal(exchange.headers.location, './');
  const cookie = exchange.headers['set-cookie']?.find(value => value.startsWith('dsh-auth-'));
  assert.ok(cookie && /HttpOnly/i.test(cookie));
  const authenticated = await request('/', cookie.split(';', 1)[0]);
  assert.equal(authenticated.status, 200);
  assert.ok(authenticated.body.toLowerCase().includes('<html'));
  console.log('Backend/native-auth probe passed.');
} catch {
  console.error('Backend/native-auth probe failed; details suppressed.');
  process.exitCode = 1;
}
