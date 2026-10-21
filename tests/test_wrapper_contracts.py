"""Light static contracts; this does not build/run Docker or validate Compose."""
import ast
import fnmatch
import json
from pathlib import Path
import re
import shlex
import unittest

ROOT = Path(__file__).resolve().parents[1]


def build_context_includes(path):
    included = True
    for line in (ROOT / '.dockerignore').read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        negate = line.startswith('!')
        pattern = line[1:] if negate else line
        candidates = [path, *[parent.as_posix() for parent in Path(path).parents if parent.as_posix() != '.']]
        if any(pattern == '**' or fnmatch.fnmatchcase(candidate, pattern.rstrip('/')) for candidate in candidates):
            included = negate
    return included


class WrapperContracts(unittest.TestCase):
    def test_every_local_docker_copy_source_is_in_context(self):
        for line in (ROOT / 'Dockerfile').read_text().splitlines():
            if not line.startswith('COPY ') or '--from=' in line:
                continue
            arguments = [part for part in shlex.split(line)[1:] if not part.startswith('--')]
            for source in arguments[:-1]:
                path = ROOT / source
                self.assertTrue(path.exists(), source)
                paths = [child for child in path.rglob('*') if child.is_file()] if path.is_dir() else [path]
                for child in paths:
                    self.assertTrue(build_context_includes(child.relative_to(ROOT).as_posix()), str(child))

    def test_real_data_and_test_instrumentation_not_in_image_context(self):
        for path in ['.env', 'data/dsh/credentials.yml', 'workspace/private.txt',
                     'tests/runtime-checks.test.mjs', 'scripts/dsh-session-smoke.mjs',
                     'scripts/dsh-session-smoke.cordis.yml', 'scripts/backend-probe.mjs']:
            self.assertFalse(build_context_includes(path), path)
        dockerfile = (ROOT / 'Dockerfile').read_text()
        self.assertNotIn('dsh-session-smoke', dockerfile)
        self.assertIn('USER node', dockerfile)

    def test_default_and_optional_security_separate(self):
        base = (ROOT / 'compose.yml').read_text()
        hardened = (ROOT / 'compose.hardened.yml').read_text()
        self.assertNotIn('read_only:', base)
        self.assertIn('read_only: true', hardened)
        self.assertIn('/tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777', hardened)
        self.assertIn('NARB_DISABLE_NATIVE_CACHE: "1"', hardened)
        self.assertNotIn('NARB_DISABLE_NATIVE_CACHE', base)
        self.assertIn('127.0.0.1:3080:3080', base)
        self.assertEqual(base.count('create_host_path: false'), 2)
        self.assertIn('platform: linux/amd64', base)
        self.assertIn('cap_drop: [ALL]', base)
        self.assertIn('no-new-privileges:true', base)
        self.assertIn('user: "1000:1000"', base)

    def test_root_development_is_standalone_and_bounded(self):
        text = (ROOT / 'compose.dev-root.yml').read_text()
        active = '\n'.join(line for line in text.splitlines() if not line.lstrip().startswith('#'))
        self.assertIn('name: dsh-dev-root', active)
        self.assertIn('user: "0:0"', active)
        self.assertIn('DSH_ALLOW_ROOT: "1"', active)
        self.assertIn('${DSH_DEV_IMAGE:?', active)
        self.assertIn('read_only: false', active)
        self.assertIn('privileged: false', active)
        self.assertIn('restart: "no"', active)
        self.assertIn('no-new-privileges:true', active)
        self.assertIn('/tmp:rw,exec,nosuid,nodev,size=1g,mode=1777', active)
        self.assertIn('127.0.0.1:3081:3080', active)
        self.assertIn('http://127.0.0.1:3081/', active)
        self.assertEqual(active.count('type: bind'), 2)
        self.assertEqual(active.count('create_host_path: false'), 2)
        self.assertIn('source: ./data-root-dev', active)
        self.assertIn('source: ./workspace-root-dev', active)
        self.assertNotRegex(active, r'(?m)^volumes:')
        self.assertNotRegex(active, r'(?m)^\s*(cap_add|cap_drop|pid|ipc|network_mode|devices|device_cgroup_rules|userns_mode|use_api_socket|entrypoint|extends|build|secrets|env_file):')
        for forbidden in ['docker.sock', 'unconfined', 'host-gateway', 'NARB_DISABLE_NATIVE_CACHE', '0.0.0.0:', 'type: volume']:
            self.assertNotIn(forbidden, active)

    def test_nonroot_development_keeps_identity_and_image_unchanged(self):
        text = (ROOT / 'compose.dev.yml').read_text()
        active = '\n'.join(line for line in text.splitlines() if not line.lstrip().startswith('#'))
        self.assertNotRegex(active, r'(?m)^\s*(user|image|entrypoint|cap_add|cap_drop|security_opt|volumes|ports):')
        self.assertNotIn('DSH_ALLOW_ROOT', active)
        self.assertIn('/tmp:rw,exec,nosuid,nodev,size=1g,mode=1777', active)
        for key in ['npm_config_prefix', 'npm_config_cache', 'BUN_INSTALL_GLOBAL_DIR', 'BUN_INSTALL_BIN']:
            self.assertRegex(active, rf'{key}: /data/home/')
        self.assertNotIn('${PATH}', active)

    def test_root_guard_runs_before_home_creation_and_cannot_repair_permissions(self):
        for name in ['entrypoint.mjs', 'self-check.mjs']:
            source = (ROOT / 'scripts' / name).read_text()
            self.assertLess(source.index('const mode = checkRuntimeIdentity();'), source.index('checkRootDataDirectories();'))
            self.assertLess(source.index('checkRootDataDirectories();'), source.index('checkWritableDirectories();'))
        preflight = (ROOT / 'scripts/runtime-checks.mjs').read_text()
        self.assertIn('inspect = lstatSync', preflight)
        self.assertNotRegex(preflight, r'\b(chownSync|chmodSync|execSync|readdirSync)\(')

    def test_development_data_is_not_in_build_context(self):
        for path in ['data-root-dev/dsh/.credentials.yaml', 'workspace-root-dev/private.txt',
                     'compose.dev.yml', 'compose.dev-root.yml']:
            self.assertFalse(build_context_includes(path), path)

    def test_integrity_lock_and_python_sources_parse(self):
        lock = json.loads((ROOT / 'scripts/toolchains.lock.json').read_text())
        self.assertEqual(lock['versions']['node'], '26.12.0')
        self.assertEqual(lock['versions']['codegraph'], '1.6.2')
        def check(value):
            if isinstance(value, dict):
                for key, child in value.items():
                    if key == 'sha256':
                        self.assertRegex(child, r'^[a-f0-9]{64}$')
                    if key == 'integrity':
                        self.assertTrue(child.startswith('sha512-'))
                    check(child)
            elif isinstance(value, list):
                for child in value:
                    check(child)
        check(lock)
        for path in (ROOT / 'scripts').glob('*.py'):
            ast.parse(path.read_text(), filename=str(path))

    def test_manual_ci_has_real_session_and_readonly_checks_before_publish(self):
        workflow = (ROOT / '.github/workflows/image.yml').read_text()
        self.assertIn('workflow_dispatch:', workflow)
        self.assertIn('default: false', workflow)
        self.assertNotRegex(workflow, r'^  (push|pull_request|schedule):')
        self.assertIn('python3 scripts/toolchain-smoke.py dsh-tested:local --hardened', workflow)
        self.assertIn('needs: build', workflow)
        self.assertIn('scripts/smoke.py', workflow)

    def test_no_root_permission_fixup_or_model_call_in_instrumentation(self):
        preflight = (ROOT / 'scripts/runtime-checks.mjs').read_text()
        self.assertNotRegex(preflight, r'\b(chownSync|chmodSync|execSync)\(')
        plugin = (ROOT / 'scripts/dsh-session-smoke.mjs').read_text()
        self.assertIn('ctx.sessionController.create(', plugin)
        self.assertIn('ctx.tools.schemas(agent)', plugin)
        self.assertIn('ctx.sessions.flush(agent.session)', plugin)
        self.assertNotRegex(plugin, r'\.(prompt|followup|steer|send|execute|stream)\(')
        smoke = (ROOT / 'scripts/toolchain-smoke.py').read_text()
        self.assertIn("'--internal'", smoke)
        self.assertNotIn("'-p'", smoke)
        self.assertIn('wait_for_backend(name)', smoke)
        self.assertIn('wait_for_session(name, nonce, cycle, enabled)', smoke)
        self.assertIn('snapshot_config(image, common', smoke)
        self.assertNotIn('digest(path)', smoke)


if __name__ == '__main__':
    unittest.main()
