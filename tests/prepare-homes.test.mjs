import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareHomes } from '../scripts/prepare-homes.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-home-test-'));
  return { root, env: { HOME: join(root, 'home'), DSH_HOME: join(root, 'dsh') } };
}
test('empty bind creates HOME and DSH_HOME under the current UID', () => {
  const { root, env } = fixture();
  try {
    assert.deepEqual(readdirSync(root), []);
    prepareHomes(env);
    for (const path of Object.values(env)) {
      const stat = statSync(path);
      assert.ok(stat.isDirectory());
      assert.equal(stat.uid, process.getuid());
      assert.equal(stat.mode & 0o777, 0o700);
    }
  } finally { rmSync(root, { recursive: true }); }
});
test('repeat startup preserves existing modes, owners and config bytes', () => {
  const { root, env } = fixture();
  try {
    for (const path of Object.values(env)) { mkdirSync(path); chmodSync(path, 0o750); }
    const config = join(env.DSH_HOME, 'cordis.patch.yml');
    writeFileSync(config, '# keep existing settings\n[]\n', { mode: 0o600 });
    const before = Object.values(env).map(path => statSync(path));
    prepareHomes(env); prepareHomes(env);
    assert.equal(readFileSync(config, 'utf8'), '# keep existing settings\n[]\n');
    Object.values(env).forEach((path, i) => {
      assert.equal(statSync(path).uid, before[i].uid);
      assert.equal(statSync(path).mode, before[i].mode);
    });
  } finally { rmSync(root, { recursive: true }); }
});
test('an existing file fails clearly without replacement or disclosure', () => {
  const { root, env } = fixture();
  try {
    writeFileSync(env.HOME, 'preserve');
    assert.throws(() => prepareHomes(env), error => /Cannot prepare HOME/.test(error.message) && !error.message.includes(root));
    assert.equal(readFileSync(env.HOME, 'utf8'), 'preserve');
  } finally { rmSync(root, { recursive: true }); }
});
test('custom absolute homes work; relative and empty paths fail closed', () => {
  const { root, env } = fixture();
  try {
    prepareHomes({ HOME: join(root, 'custom/home'), DSH_HOME: join(root, 'custom/state') });
    assert.ok(statSync(join(root, 'custom/home')).isDirectory());
    assert.throws(() => prepareHomes({ ...env, HOME: '' }), /HOME must be an absolute/);
    assert.throws(() => prepareHomes({ ...env, DSH_HOME: 'relative' }), /DSH_HOME must be an absolute/);
  } finally { rmSync(root, { recursive: true }); }
});
