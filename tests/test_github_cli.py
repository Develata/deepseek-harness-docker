"""Inert GitHub CLI installer/config contracts; no network, install or login."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('install_toolchains', ROOT / 'scripts/install-toolchains.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class GitHubCliTests(unittest.TestCase):
    def test_official_archive_pins(self):
        lock = json.loads((ROOT / 'scripts/toolchains.lock.json').read_text())
        self.assertEqual(lock['versions']['gh'], '2.102.1')
        checksums = {
            'amd64': '77b9e297e94c50336823d0f84de7ef1be60cba704601fa0d98f129f47a94987b',
            'arm64': '5019b3cc6e8a03bb4d88600f8dbda2add8e6407705c159b0c63151036e77a1af',
        }
        for arch, digest in checksums.items():
            self.assertEqual(lock['platforms'][arch]['gh'], {
                'url': f'https://github.com/cli/cli/releases/download/v2.102.1/gh_2.102.1_linux_{arch}.tar.gz',
                'sha256': digest,
            })

    def test_checksum_is_verified_before_extraction_or_install(self):
        data = b'synthetic public archive bytes'
        response = io.BytesIO(data)
        response.url = 'https://example.com/archive'
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(installer.urllib.request, 'urlopen', return_value=response), \
                patch.object(installer, 'run') as run, patch.object(installer, 'install_binary') as install:
            with self.assertRaisesRegex(ValueError, 'integrity mismatch'):
                installer.install_github_cli({'url': response.url, 'sha256': '0' * 64}, Path(directory))
            run.assert_not_called()
            install.assert_not_called()

    def test_good_checksum_accepts_only_https(self):
        data = b'synthetic public archive bytes'
        response = io.BytesIO(data)
        response.url = 'https://example.com/archive'
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(installer.urllib.request, 'urlopen', return_value=response) as fetch:
            target = Path(directory) / 'archive'
            installer.download({'url': response.url, 'sha256': hashlib.sha256(data).hexdigest()}, target)
            self.assertEqual(target.read_bytes(), data)
            with self.assertRaisesRegex(ValueError, 'HTTPS'):
                installer.download({'url': 'http://example.com/archive'}, target)
            self.assertEqual(fetch.call_count, 1)

    def test_verified_layout_installs_binary_and_preserves_license(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            def unpack(*args):
                self.assertEqual(args, ('tar', '--no-same-owner', '-xzf', str(work / 'gh.tar.gz'),
                                        '--strip-components=1', '-C', str(work / 'gh')))
                (work / 'gh/bin').mkdir()
                (work / 'gh/bin/gh').write_bytes(b'not executed')
                (work / 'gh/LICENSE').write_text('Synthetic license notice\n')
            with patch.object(installer, 'download') as download, patch.object(installer, 'run', side_effect=unpack), \
                    patch.object(installer, 'install_binary') as install:
                installer.install_github_cli({'url': 'https://example.com/archive'}, work, work / 'licenses')
                download.assert_called_once_with({'url': 'https://example.com/archive'}, work / 'gh.tar.gz')
                install.assert_called_once_with(work / 'gh/bin/gh', 'gh')
                self.assertEqual((work / 'licenses/gh/LICENSE').read_text(), 'Synthetic license notice\n')

    def test_missing_license_fails_without_binary_install(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            def unpack(*_args):
                (work / 'gh/bin').mkdir()
                (work / 'gh/bin/gh').write_bytes(b'not executed')
            with patch.object(installer, 'download'), patch.object(installer, 'run', side_effect=unpack), \
                    patch.object(installer, 'install_binary') as install:
                with self.assertRaisesRegex(ValueError, 'missing license'):
                    installer.install_github_cli({}, work, work / 'licenses')
                install.assert_not_called()

    def test_runtime_does_not_configure_authentication(self):
        dockerfile = (ROOT / 'Dockerfile').read_text()
        self.assertIn('XDG_CONFIG_HOME=/data/home/.config GH_CONFIG_DIR=/data/home/.config/gh', dockerfile)
        self.assertIn('COPY --from=toolchains /opt/toolchain-licenses/ /opt/dsh-wrapper/licenses/', dockerfile)
        self.assertIn('USER node', dockerfile)
        for name in ['entrypoint.mjs', 'self-check.mjs', 'runtime-checks.mjs', 'toolchain-smoke.mjs']:
            text = (ROOT / 'scripts' / name).read_text()
            for forbidden in ['--show-token', '--insecure-storage', "['auth',", 'gh auth login', 'gh auth setup-git', 'gh auth status']:
                self.assertNotIn(forbidden, text, name)
        smoke = (ROOT / 'scripts/toolchain-smoke.mjs').read_text()
        self.assertIn("['config', 'get', 'prompt']", smoke)
        self.assertIn("[ghConfig]: readFileSync(ghConfig, 'utf8')", smoke)


if __name__ == '__main__':
    unittest.main()
