"""Diagnostic redaction tests only; no Docker process or DSH is launched."""
from contextlib import redirect_stderr
import importlib.util
import io
import json
import ast
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('smoke', Path(__file__).resolve().parents[1] / 'scripts/toolchain-smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class SmokeDiagnostics(unittest.TestCase):
    def test_hardened_fixture_disables_native_copy_cache_without_relaxing_tmpfs(self):
        with tempfile.TemporaryDirectory() as root, \
             patch.object(smoke, 'command'), patch.object(smoke.subprocess, 'run'), \
             patch.object(smoke, 'run_dsh', side_effect=RuntimeError('stop before container launch')) as launch:
            with self.assertRaisesRegex(RuntimeError, 'stop before container launch'):
                smoke.run_fixture('synthetic-image', Path(root), True)
        common = launch.call_args.args[1]
        self.assertIn('--read-only', common)
        tmpfs = common[common.index('--tmpfs') + 1]
        self.assertEqual(tmpfs, '/tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777')
        self.assertEqual(common[common.index('-e') + 1], 'NARB_DISABLE_NATIVE_CACHE=1')
        self.assertEqual(common[common.index('--user') + 1], '1000:1000')
        self.assertEqual(common[common.index('--cap-drop') + 1], 'ALL')
        self.assertEqual(common[common.index('--security-opt') + 1], 'no-new-privileges')
        compose = (Path(__file__).resolve().parents[1] / 'compose.hardened.yml').read_text()
        self.assertIn('read_only: true', compose)
        self.assertIn('NARB_DISABLE_NATIVE_CACHE: "1"', compose)
        self.assertIn('- ' + tmpfs, compose)

    def test_default_fixture_does_not_change_native_loader_or_mount_policy(self):
        with tempfile.TemporaryDirectory() as root, \
             patch.object(smoke, 'command'), patch.object(smoke.subprocess, 'run'), \
             patch.object(smoke, 'run_dsh', side_effect=RuntimeError('stop before container launch')) as launch:
            with self.assertRaisesRegex(RuntimeError, 'stop before container launch'):
                smoke.run_fixture('synthetic-image', Path(root), False)
        common = launch.call_args.args[1]
        self.assertNotIn('--read-only', common)
        self.assertNotIn('--tmpfs', common)
        self.assertNotIn('NARB_DISABLE_NATIVE_CACHE=1', common)
        self.assertEqual(common[common.index('--user') + 1], '1000:1000')
        for file in ['Dockerfile', 'compose.yml', 'scripts/entrypoint.mjs']:
            self.assertNotIn('NARB_DISABLE_NATIVE_CACHE',
                             (Path(__file__).resolve().parents[1] / file).read_text())

    def test_failure_summary_never_stringifies_errors_or_output(self):
        secret = 'sensitive-sentinel-not-for-logs'
        errors = [
            (RuntimeError(secret), 'unexpected'),
            (AssertionError(secret), 'assertion'),
            (subprocess.CalledProcessError(125, [secret], output=secret, stderr=secret), 'command-exit-125'),
            (subprocess.TimeoutExpired([secret], 3, output=secret, stderr=secret), 'command-timeout'),
            (smoke.SmokeFailure('session-title'), 'session-title'),
            (smoke.SmokeFailure(secret), 'unknown'),
        ]
        for error, expected in errors:
            self.assertEqual(smoke.failure_summary(error), expected)

    def test_phase_accepts_only_fixed_labels(self):
        smoke.phase('backend')
        self.assertEqual(smoke.PHASE, 'backend')
        smoke.phase('sensitive-sentinel-not-for-logs')
        self.assertEqual(smoke.PHASE, 'unknown')

    def test_container_state_emits_only_validated_scalars(self):
        output = io.StringIO()
        with patch.object(smoke, 'command', return_value=SimpleNamespace(stdout='false 137 true\n')) as command:
            with redirect_stderr(output):
                smoke.diagnose_container('synthetic-container')
        self.assertEqual(output.getvalue(), 'Container state: running=false; exit=137; oom=true\n')
        self.assertEqual(command.call_args.args[0][1], 'inspect')

    def test_bad_state_and_diagnostic_errors_do_not_disclose(self):
        for kwargs in [dict(return_value=SimpleNamespace(stdout='sensitive-sentinel-not-for-logs')),
                       dict(side_effect=RuntimeError('sensitive-sentinel-not-for-logs'))]:
            output = io.StringIO()
            with patch.object(smoke, 'command', **kwargs), redirect_stderr(output):
                smoke.diagnose_container('synthetic-container')
            self.assertEqual(output.getvalue(), 'Container state unavailable; details suppressed.\n')

    def test_closed_schema_strips_child_secrets_and_invalid_scalar_types(self):
        secret = 'sensitive-sentinel-not-for-logs'
        value = smoke.safe_diagnostic({'source': 'tools', 'stage': 'rust-build', 'exit': True,
                                      'signal': secret, 'error': secret, 'stdoutMatch': secret,
                                      'stderrMatch': False, 'httpStatus': 999, 'stderr': secret,
                                      'path': secret, 'nested': {'secret': secret}})
        self.assertNotIn(secret, json.dumps(value))
        for key in ('exit', 'signal', 'error', 'httpStatus'):
            self.assertIsNone(value[key])
        self.assertIs(value['stderrMatch'], False)
        for source, stage in [(secret, 'rust-build'), ('tools', secret), ([], 'rust-build'), ('tools', {})]:
            self.assertIsNone(smoke.safe_diagnostic({'source': source, 'stage': stage}))

    def test_two_nested_records_reach_host_without_raw_output_or_swallowing_failure(self):
        secret = 'sensitive-sentinel-not-for-logs'
        child = '\n'.join([secret,
            'DSH_CHECK ' + json.dumps({'source': 'self', 'stage': 'rustc-version', 'exit': 1, 'stderr': secret}),
            'DSH_CHECK ' + json.dumps({'source': 'tools', 'stage': 'self-check', 'exit': 1, 'command': secret})])
        error = subprocess.CalledProcessError(1, [secret], output=secret, stderr=child)
        output = io.StringIO()
        with patch.object(smoke.subprocess, 'run', side_effect=error), redirect_stderr(output):
            with self.assertRaises(subprocess.CalledProcessError) as raised:
                smoke.command([secret])
        self.assertIs(raised.exception, error)
        records = smoke.read_diagnostics(output.getvalue())
        self.assertEqual([(r['source'], r['stage']) for r in records],
                         [('self', 'rustc-version'), ('tools', 'self-check')])
        self.assertNotIn(secret, output.getvalue())

    def test_malformed_oversized_unknown_and_duplicate_records_are_bounded(self):
        record = 'DSH_CHECK ' + json.dumps({'source': 'backend', 'stage': 'cookie', 'httpStatus': 401})
        text = '\n'.join(['DSH_CHECK null', 'DSH_CHECK []', 'DSH_CHECK {', 'DSH_CHECK ' + 'x' * 2049,
                          'DSH_CHECK ' + json.dumps({'source': 'secret', 'stage': 'secret'}), record, record])
        self.assertEqual(len(smoke.read_diagnostics(text)), 1)
        self.assertEqual(smoke.read_diagnostics(text, 'self'), [])
        self.assertEqual(smoke.read_diagnostics(text)[0]['httpStatus'], 401)

    def test_snapshot_reports_fixed_config_only_and_keeps_equality_gate(self):
        output = io.StringIO()
        with redirect_stderr(output), self.assertRaises(AssertionError):
            smoke.verify_snapshot({'/data/dsh/cordis.patch.yml': 'new-sensitive-hash'},
                                  {'/data/dsh/cordis.patch.yml': 'old-sensitive-hash'})
        self.assertNotIn('sensitive', output.getvalue())
        self.assertEqual(smoke.read_diagnostics(output.getvalue())[0]['stage'], 'global-patch')
        smoke.verify_snapshot({'same': 'value'}, {'same': 'value'})
        with patch.object(smoke, 'command', return_value=SimpleNamespace(stdout='{}')) as command:
            smoke.snapshot_config('synthetic-image', [], require_marker=True)
        ast.parse(command.call_args.args[0][-1])

    def test_session_failure_codes_are_allowlisted_and_fail_closed(self):
        output = io.StringIO()
        report = {'ok': False, 'stage': 'tools', 'code': 'sensitive-sentinel-not-for-logs'}
        with patch.object(smoke.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps(report))), redirect_stderr(output):
            with self.assertRaises(smoke.SmokeFailure) as error:
                smoke.wait_for_session('synthetic-container', 'synthetic-nonce', 1, True)
        self.assertEqual(error.exception.code, 'session-tools')
        self.assertNotIn('sensitive', output.getvalue())
        self.assertIsNone(smoke.read_diagnostics(output.getvalue())[0]['error'])

    def test_backend_keeps_last_probe_without_launch_token_or_cookie(self):
        secret = 'sensitive-sentinel-not-for-logs'
        probe = 'DSH_CHECK ' + json.dumps({'source': 'backend', 'stage': 'cookie', 'error': 'ERR_ASSERTION', 'cookie': secret})
        output = io.StringIO()
        with patch.object(smoke, 'command', side_effect=[SimpleNamespace(stdout='http://127.0.0.1:3080/?token=' + secret, stderr=''),
                                                        SimpleNamespace(stdout='false')]), \
             patch.object(smoke.subprocess, 'run', return_value=SimpleNamespace(returncode=1, stderr=probe)), redirect_stderr(output):
            with self.assertRaises(smoke.SmokeFailure):
                smoke.wait_for_backend('synthetic-container')
        self.assertNotIn(secret, output.getvalue())
        self.assertIn('token-seen=true', output.getvalue())
        self.assertEqual(smoke.read_diagnostics(output.getvalue())[0]['stage'], 'cookie')

    def test_javascript_and_python_diagnostic_schemas_remain_in_sync(self):
        module = (Path(__file__).resolve().parents[1] / 'scripts/self-check.mjs').as_uri()
        result = subprocess.run(['node', '--input-type=module', '-e',
                                 'import { DIAGNOSTIC_STAGES } from ' + json.dumps(module) + '; console.log(JSON.stringify(DIAGNOSTIC_STAGES));'],
                                check=True, capture_output=True, text=True, timeout=10)
        for source, stages in json.loads(result.stdout).items():
            self.assertEqual(set(stages), smoke.DIAGNOSTIC_STAGES[source])

    def test_real_nested_node_capture_preserves_only_safe_failure_records(self):
        module = (Path(__file__).resolve().parents[1] / 'scripts/self-check.mjs').as_uri()
        imports = 'import { safeDiagnostic, parseDiagnostic, emitDiagnostic } from ' + json.dumps(module) + ';'
        child = imports + "console.log('sensitive-sentinel-not-for-logs'); emitDiagnostic(safeDiagnostic('self', 'rustc-version', {exit: 1})); process.exitCode = 1;"
        parent = imports + "import { spawnSync } from 'node:child_process'; const result = spawnSync(process.execPath, ['--input-type=module', '-e', " + json.dumps(child) + "], {encoding: 'utf8'}); for (const line of result.stderr.split('\\n')) { const value = parseDiagnostic(line); if (value?.source === 'self') emitDiagnostic(value); } emitDiagnostic(safeDiagnostic('tools', 'self-check', {exit: result.status})); process.exitCode = result.status;"
        output = io.StringIO()
        with redirect_stderr(output), self.assertRaises(subprocess.CalledProcessError):
            smoke.command(['node', '--input-type=module', '-e', parent])
        self.assertNotIn('sensitive', output.getvalue())
        self.assertEqual([(r['source'], r['stage']) for r in smoke.read_diagnostics(output.getvalue())],
                         [('self', 'rustc-version'), ('tools', 'self-check')])


if __name__ == '__main__':
    unittest.main()
