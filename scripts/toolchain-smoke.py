"""Disposable AMD64 runtime checks. Run only against an approved built image.
No real data/credentials, model prompts, published ports, or internet egress.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import uuid


# Emit fixed labels and validated scalar state only, never exception text,
# child output, argv, environment values or native launch credentials.
CASE = 'setup'
PHASE = 'initialize'
SESSION_STAGES = {'loader', 'create', 'agent', 'rename', 'title', 'tools', 'flush'}

# Treat diagnostics from every child as untrusted. Emit only this closed schema.
DIAGNOSTIC_STAGES = {
    'backend': set((
        'anonymous-api anonymous-root authenticated-root cookie html interface invalid-token '
        'redirect token-exchange token-input'
    ).split()),
    'self': set((
        'binstall-version bun-version cargo-version clean-all-version clippy-version '
        'codegraph-launcher codegraph-version dsh-executable immutable-tools lock-read node-version '
        'preflight python-version rustc-version rustfmt-version rustup-version sccache-version'
    ).split()),
    'session': set((
        'agent create flush loader rename title tools'
    ).split()),
    'snapshot': set((
        'cargo-config cargo-marker global-patch no-index profile-manifest profile-patch'
    ).split()),
    'tools': set((
        'binstall-version bun-version cargo-persistence cargo-version clean-all-version '
        'clippy-version codegraph-launcher codegraph-node codegraph-path codegraph-version identity '
        'lock-read mcp-initialize mcp-no-index mcp-shutdown mcp-spawn mcp-tools node-version '
        'persistence-read persistence-write python-venv python-version rust-build rust-build-sccache '
        'rust-execute rust-fixture rust-layout rustc-version rustfmt-version rustup-active '
        'rustup-version sccache-stats sccache-stop sccache-version self-check'
    ).split()),
}
ERROR_CODES = {'ERR_ASSERTION', 'ENOENT', 'EACCES', 'EPERM', 'EROFS', 'ENOSPC',
               'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOBUFS', 'protocol', 'unknown'}
SIGNALS = {'SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGILL', 'SIGBUS', 'SIGINT'}

def safe_diagnostic(value):
    if not isinstance(value, dict):
        return None
    source, stage = value.get('source'), value.get('stage')
    if not isinstance(source, str) or not isinstance(stage, str) or stage not in DIAGNOSTIC_STAGES.get(source, set()):
        return None
    def integer(key, low, high):
        item = value.get(key)
        return item if type(item) is int and low <= item <= high else None
    def choice(key, allowed):
        item = value.get(key)
        return item if isinstance(item, str) and item in allowed else None
    return {'source': source, 'stage': stage, 'exit': integer('exit', -128, 255),
            'signal': choice('signal', SIGNALS), 'error': choice('error', ERROR_CODES),
            'stdoutMatch': value.get('stdoutMatch') if type(value.get('stdoutMatch')) is bool else None,
            'stderrMatch': value.get('stderrMatch') if type(value.get('stderrMatch')) is bool else None,
            'httpStatus': integer('httpStatus', 100, 599)}

def read_diagnostics(output, source=None):
    records = []
    if not isinstance(output, str):
        return records
    for line in output.splitlines():
        if not line.startswith('DSH_CHECK ') or len(line) > 2048:
            continue
        try:
            value = safe_diagnostic(json.loads(line[10:]))
        except (ValueError, TypeError, RecursionError):
            continue
        if value and (source is None or value['source'] == source) and value not in records:
            records.append(value)
        if len(records) >= 16:
            break
    return records

def emit_diagnostics(records):
    for value in records:
        safe = safe_diagnostic(value)
        if safe:
            print('DSH_CHECK ' + json.dumps(safe, separators=(',', ':')), file=sys.stderr)


class SmokeFailure(Exception):
    def __init__(self, code):
        allowed = {'backend-unready', 'session-report', 'session-timeout', 'shutdown'}
        allowed.update('session-' + stage for stage in SESSION_STAGES)
        self.code = code if code in allowed else 'unknown'


def phase(value):
    global PHASE
    allowed = {'initialize', 'network-create', 'container-start', 'backend', 'session',
               'shutdown', 'home-check', 'fixture-seed', 'config-snapshot', 'tools'}
    PHASE = value if value in allowed else 'unknown'


def failure_summary(error):
    if isinstance(error, SmokeFailure):
        return error.code
    if isinstance(error, subprocess.CalledProcessError):
        return 'command-exit-' + str(int(error.returncode))
    if isinstance(error, subprocess.TimeoutExpired):
        return 'command-timeout'
    if isinstance(error, AssertionError):
        return 'assertion'
    return 'unexpected'


def diagnose_container(name):
    # Query before deleting the disposable container. No raw inspect or logs.
    try:
        result = command(['docker', 'inspect', '--format',
                          '{{.State.Running}} {{.State.ExitCode}} {{.State.OOMKilled}}', name])
        match = re.fullmatch(r'(true|false) (-?\d+) (true|false)', result.stdout.strip())
        if match:
            print('Container state: running=' + match[1] + '; exit=' + str(int(match[2]))
                  + '; oom=' + match[3], file=sys.stderr)
        else:
            print('Container state unavailable; details suppressed.', file=sys.stderr)
    except Exception:
        print('Container state unavailable; details suppressed.', file=sys.stderr)


def command(args, **kwargs):
    try:
        return subprocess.run(args, check=True, capture_output=True, text=True, timeout=180, **kwargs)
    except subprocess.CalledProcessError as error:
        emit_diagnostics(read_diagnostics(error.stderr))
        raise


def snapshot_config(image, common, require_marker=False):
    # The CI host may be UID1001 while runtime homes correctly stay 0700/UID1000.
    # Read only these synthetic files through UID1000; never relax host modes.
    code = """import errno, hashlib, json, sys
from pathlib import Path
files = {'global-patch': '/data/dsh/cordis.patch.yml',
         'profile-patch': '/data/dsh/profiles/web/cordis.patch.yml',
         'profile-manifest': '/data/dsh/profiles/web/package.json',
         'cargo-config': '/data/home/.cargo/config.toml'}
result = {}
try:
    for stage, path in files.items():
        result[path] = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    if REQUIRE_MARKER:
        stage = 'cargo-marker'
        assert Path('/data/home/.cargo/bin/cargo-persistence-probe').is_file()
        stage = 'no-index'
        assert not Path('/workspace/.codegraph').exists()
    print(json.dumps(result))
except Exception as error:
    code = 'ERR_ASSERTION' if isinstance(error, AssertionError) else errno.errorcode.get(getattr(error, 'errno', None), 'unknown')
    print('DSH_CHECK ' + json.dumps({'source': 'snapshot', 'stage': stage, 'error': code}), file=sys.stderr)
    sys.exit(1)
""".replace('REQUIRE_MARKER', repr(require_marker))
    result = command(['docker', 'run', '--rm', '--network', 'none', *common,
                      '--entrypoint', 'python3', image, '-c', code])
    return json.loads(result.stdout)


def verify_snapshot(actual, expected):
    labels = {'/data/dsh/cordis.patch.yml': 'global-patch',
              '/data/dsh/profiles/web/cordis.patch.yml': 'profile-patch',
              '/data/dsh/profiles/web/package.json': 'profile-manifest',
              '/data/home/.cargo/config.toml': 'cargo-config'}
    for path, stage in labels.items():
        if actual.get(path) != expected.get(path):
            emit_diagnostics([{'source': 'snapshot', 'stage': stage, 'error': 'ERR_ASSERTION'}])
    assert actual == expected, 'Existing config changed'


def remove_container(name):
    subprocess.run(['docker', 'rm', '-fv', name], capture_output=True, check=False)


def wait_for_backend(name):
    deadline = time.monotonic() + 150
    last_diagnostics = []
    token_seen = False
    while time.monotonic() < deadline:
        logs = command(['docker', 'logs', name])
        match = re.search(r'http://127\.0\.0\.1:3080/\?token=([A-Za-z0-9_-]+)', logs.stdout + logs.stderr)
        if match:
            token_seen = True
            probe = subprocess.run(['docker', 'exec', '-i', name, 'node', '/opt/test/backend-probe.mjs'],
                                   input=match[1], capture_output=True, text=True, timeout=40)
            if probe.returncode == 0:
                return
            last_diagnostics = read_diagnostics(probe.stderr, 'backend')
        state = command(['docker', 'inspect', '--format', '{{.State.Running}}', name])
        if state.stdout.strip() != 'true':
            break
        time.sleep(2)
    emit_diagnostics(last_diagnostics)
    print('Backend readiness: token-seen=' + str(token_seen).lower(), file=sys.stderr)
    raise SmokeFailure('backend-unready')


def wait_for_session(name, nonce, cycle, enabled):
    path = f'/data/session-smoke-{nonce}-{cycle}.json'
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        result = subprocess.run(['docker', 'exec', name, 'cat', path], capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            report = json.loads(result.stdout)
            if report.get('ok') is False:
                stage = report.get('stage')
                emit_diagnostics([{'source': 'session', 'stage': stage, 'error': report.get('code')}])
                raise SmokeFailure('session-' + stage if stage in SESSION_STAGES else 'session-report')
            assert report == {'ok': True, 'cycle': str(cycle), 'mcpEnabled': enabled,
                              'sessionResumed': cycle == 2}, 'DSH session integration failed'
            return
        if command(['docker', 'inspect', '--format', '{{.State.Running}}', name]).stdout.strip() != 'true':
            break
        time.sleep(1)
    raise SmokeFailure('session-timeout')


def run_fixture(image, root, hardened):
    global CASE
    scripts = Path(__file__).resolve().parent
    root.chmod(0o755)
    data, workspace = root / 'data', root / 'workspace'
    for directory in (data, workspace):
        directory.mkdir(mode=0o777)
        directory.chmod(0o777)  # Disposable CI fixture only, NEVER an operator recommendation.
    mounts = ['--mount', f'type=bind,src={data},dst=/data',
              '--mount', f'type=bind,src={workspace},dst=/workspace',
              '--mount', f'type=bind,src={scripts},dst=/opt/test,readonly']
    common = ['--init', '--user', '1000:1000', '--cap-drop', 'ALL',
              '--security-opt', 'no-new-privileges', *mounts]
    if hardened:
        # The upstream native loader otherwise copies .node files into noexec /tmp.
        # Load the original image files instead; do not grant tmpfs executable mappings.
        common += ['--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777',
                   '-e', 'NARB_DISABLE_NATIVE_CACHE=1']
    # Reproduce the published image's empty-bind failure before seeding ANY
    # /data child. Docker's image-owned /data/home is hidden by this bind.
    assert not any(data.iterdir()), 'Empty-bind regression must start truly empty'
    empty_network = 'dsh-empty-' + uuid.uuid4().hex
    CASE = 'empty-bind'
    phase('network-create')
    command(['docker', 'network', 'create', '--internal', empty_network])
    try:
        run_dsh(image, common, empty_network, uuid.uuid4().hex, 1, False)
        phase('home-check')
        assert (data / 'home').is_dir() and (data / 'dsh').is_dir(), 'Entrypoint did not prepare missing homes'
    finally:
        subprocess.run(['docker', 'network', 'rm', empty_network], capture_output=True, check=False)
    print('Empty bind: real entrypoint created missing HOME/DSH_HOME as UID1000.')
    CASE = 'seed'
    phase('fixture-seed')
    setup = ('from pathlib import Path; '
             'p=Path("/data/dsh"); p.mkdir(parents=True,exist_ok=True); '
             '(p/"cordis.patch.yml").write_text("# preserve smoke fixture\\n[]\\n"); '
             'p=Path("/data/home/.cargo"); p.mkdir(parents=True,exist_ok=True); '
             '(p/"config.toml").write_text("# preserve smoke fixture\\n[net]\\noffline = true\\n")')
    command(['docker', 'run', '--rm', '--network', 'none', *common,
             '--entrypoint', 'python3', image, '-c', setup])
    phase('config-snapshot')
    before = snapshot_config(image, common)
    # An internal bridge supplies DSH's required concrete IPv4 without internet
    # egress. No port is published. docker exec probes the native HTTP listener.
    network = 'dsh-smoke-' + uuid.uuid4().hex
    phase('network-create')
    command(['docker', 'network', 'create', '--internal', network])
    nonce = uuid.uuid4().hex
    try:
        for cycle in (1, 2):
            CASE = 'enabled-cycle-1' if cycle == 1 else 'enabled-cycle-2'
            phase('tools')
            tool_name = 'dsh-tools-' + uuid.uuid4().hex
            try:
                output = command(['docker', 'run', '--rm', '--name', tool_name, '--network', 'none', *common,
                                  '-e', f'DSH_SMOKE_CYCLE={cycle}', '--entrypoint', 'node', image,
                                  '/opt/test/toolchain-smoke.mjs'])
                assert 'Toolchain smoke passed:' in output.stdout
            finally:
                remove_container(tool_name)
            run_dsh(image, common, network, nonce, cycle, True)
            phase('config-snapshot')
            verify_snapshot(snapshot_config(image, common, require_marker=True), before)
            print(f'Cycle {cycle}: real Web session sees CodeGraph; native auth and persistent data verified.')
        # A real negative control: same image, default overlay disabled. Its
        # Web session must NOT inherit any mcp__codegraph__ tools.
        CASE = 'disabled-control'
        run_dsh(image, common, network, uuid.uuid4().hex, 1, False)
        phase('config-snapshot')
        verify_snapshot(snapshot_config(image, common, require_marker=True), before)
    finally:
        subprocess.run(['docker', 'network', 'rm', network], capture_output=True, check=False)


def run_dsh(image, common, network, nonce, cycle, enabled):
    name = 'dsh-session-' + uuid.uuid4().hex
    try:
        phase('container-start')
        command(['docker', 'run', '-d', '--name', name, '--network', network, *common,
                 '-e', f'DSH_CODEGRAPH_MCP={int(enabled)}', '-e', f'DSH_SMOKE_MCP={int(enabled)}',
                 '-e', f'DSH_SMOKE_NONCE={nonce}', '-e', f'DSH_SMOKE_CYCLE={cycle}',
                 image, '--patch', '/opt/test/dsh-session-smoke.cordis.yml'])
        phase('backend')
        wait_for_backend(name)
        phase('session')
        wait_for_session(name, nonce, cycle, enabled)
        phase('shutdown')
        command(['docker', 'stop', '--time', '30', name])
        state = command(['docker', 'inspect', '--format', '{{.State.ExitCode}}', name])
        if state.stdout.strip() != '0':
            raise SmokeFailure('shutdown')
    except Exception:
        diagnose_container(name)
        raise
    finally:
        remove_container(name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image', nargs='?', default='dsh-tested:local')
    parser.add_argument('--hardened', action='store_true', help='Also restrict rootfs to read-only and /tmp to tmpfs')
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix='dsh-toolchain-smoke-'))
    run_fixture(args.image, root, args.hardened)
    print('Toolchain/DSH-session smoke complete. No model calls, credentials or logs emitted.')
    print('Synthetic fixture directory retained: ' + str(root))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Toolchain/DSH-session smoke failed: case={CASE}; phase={PHASE}; code={failure_summary(error)}. '
              'Child output and container logs suppressed.', file=sys.stderr)
        sys.exit(1)
