"""Diagnostic redaction tests only; no Docker process or DSH is launched."""
from contextlib import redirect_stderr
import importlib.util
import io
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('smoke', Path(__file__).resolve().parents[1] / 'scripts/toolchain-smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class SmokeDiagnostics(unittest.TestCase):
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


if __name__ == '__main__':
    unittest.main()
