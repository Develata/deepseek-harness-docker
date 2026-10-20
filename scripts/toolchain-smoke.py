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


def command(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=180, **kwargs)


def snapshot_config(image, common, require_marker=False):
    # The CI host may be UID1001 while runtime homes correctly stay 0700/UID1000.
    # Read only these synthetic files through UID1000; never relax host modes.
    code = ('import hashlib,json; from pathlib import Path; '
            'files=["/data/dsh/cordis.patch.yml","/data/dsh/profiles/web/cordis.patch.yml",'
            '"/data/dsh/profiles/web/package.json","/data/home/.cargo/config.toml"]; '
            'print(json.dumps({p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in files})); ')
    if require_marker:
        code += ('assert Path("/data/home/.cargo/bin/cargo-persistence-probe").is_file(); '
                 'assert not Path("/workspace/.codegraph").exists()')
    result = command(['docker', 'run', '--rm', '--network', 'none', *common,
                      '--entrypoint', 'python3', image, '-c', code])
    return json.loads(result.stdout)


def remove_container(name):
    subprocess.run(['docker', 'rm', '-fv', name], capture_output=True, check=False)


def wait_for_backend(name):
    deadline = time.monotonic() + 150
    while time.monotonic() < deadline:
        logs = command(['docker', 'logs', name])
        match = re.search(r'http://127\.0\.0\.1:3080/\?token=([A-Za-z0-9_-]+)', logs.stdout + logs.stderr)
        if match:
            probe = subprocess.run(['docker', 'exec', '-i', name, 'node', '/opt/test/backend-probe.mjs'],
                                   input=match[1], capture_output=True, text=True, timeout=40)
            if probe.returncode == 0:
                return
        state = command(['docker', 'inspect', '--format', '{{.State.Running}}', name])
        if state.stdout.strip() != 'true':
            break
        time.sleep(2)
    raise AssertionError('Native authenticated backend did not become ready')


def wait_for_session(name, nonce, cycle, enabled):
    path = f'/data/session-smoke-{nonce}-{cycle}.json'
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        result = subprocess.run(['docker', 'exec', name, 'cat', path], capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            report = json.loads(result.stdout)
            assert report == {'ok': True, 'cycle': str(cycle), 'mcpEnabled': enabled,
                              'sessionResumed': cycle == 2}, 'DSH session integration failed'
            return
        if command(['docker', 'inspect', '--format', '{{.State.Running}}', name]).stdout.strip() != 'true':
            break
        time.sleep(1)
    raise AssertionError('DSH session integration timed out')


def run_fixture(image, root, hardened):
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
        common += ['--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m,mode=1777']
    # Reproduce the published image's empty-bind failure before seeding ANY
    # /data child. Docker's image-owned /data/home is hidden by this bind.
    assert not any(data.iterdir()), 'Empty-bind regression must start truly empty'
    empty_network = 'dsh-empty-' + uuid.uuid4().hex
    command(['docker', 'network', 'create', '--internal', empty_network])
    try:
        run_dsh(image, common, empty_network, uuid.uuid4().hex, 1, False)
        assert (data / 'home').is_dir() and (data / 'dsh').is_dir(), 'Entrypoint did not prepare missing homes'
    finally:
        subprocess.run(['docker', 'network', 'rm', empty_network], capture_output=True, check=False)
    print('Empty bind: real entrypoint created missing HOME/DSH_HOME as UID1000.')
    setup = ('from pathlib import Path; '
             'p=Path("/data/dsh"); p.mkdir(parents=True,exist_ok=True); '
             '(p/"cordis.patch.yml").write_text("# preserve smoke fixture\\n[]\\n"); '
             'p=Path("/data/home/.cargo"); p.mkdir(parents=True,exist_ok=True); '
             '(p/"config.toml").write_text("# preserve smoke fixture\\n[net]\\noffline = true\\n")')
    command(['docker', 'run', '--rm', '--network', 'none', *common,
             '--entrypoint', 'python3', image, '-c', setup])
    before = snapshot_config(image, common)
    # An internal bridge supplies DSH's required concrete IPv4 without internet
    # egress. No port is published. docker exec probes the native HTTP listener.
    network = 'dsh-smoke-' + uuid.uuid4().hex
    command(['docker', 'network', 'create', '--internal', network])
    nonce = uuid.uuid4().hex
    try:
        for cycle in (1, 2):
            tool_name = 'dsh-tools-' + uuid.uuid4().hex
            try:
                output = command(['docker', 'run', '--rm', '--name', tool_name, '--network', 'none', *common,
                                  '-e', f'DSH_SMOKE_CYCLE={cycle}', '--entrypoint', 'node', image,
                                  '/opt/test/toolchain-smoke.mjs'])
                assert 'Toolchain smoke passed:' in output.stdout
            finally:
                remove_container(tool_name)
            run_dsh(image, common, network, nonce, cycle, True)
            assert snapshot_config(image, common, require_marker=True) == before, 'Existing config changed'
            print(f'Cycle {cycle}: real Web session sees CodeGraph; native auth and persistent data verified.')
        # A real negative control: same image, default overlay disabled. Its
        # Web session must NOT inherit any mcp__codegraph__ tools.
        run_dsh(image, common, network, uuid.uuid4().hex, 1, False)
        assert snapshot_config(image, common, require_marker=True) == before, 'Disabled startup changed config'
    finally:
        subprocess.run(['docker', 'network', 'rm', network], capture_output=True, check=False)


def run_dsh(image, common, network, nonce, cycle, enabled):
    name = 'dsh-session-' + uuid.uuid4().hex
    try:
        command(['docker', 'run', '-d', '--name', name, '--network', network, *common,
                 '-e', f'DSH_CODEGRAPH_MCP={int(enabled)}', '-e', f'DSH_SMOKE_MCP={int(enabled)}',
                 '-e', f'DSH_SMOKE_NONCE={nonce}', '-e', f'DSH_SMOKE_CYCLE={cycle}',
                 image, '--patch', '/opt/test/dsh-session-smoke.cordis.yml'])
        wait_for_backend(name)
        wait_for_session(name, nonce, cycle, enabled)
        command(['docker', 'stop', '--time', '30', name])
        state = command(['docker', 'inspect', '--format', '{{.State.ExitCode}}', name])
        assert state.stdout.strip() == '0', 'DSH did not stop gracefully'
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
    except Exception:
        print('Toolchain/DSH-session smoke failed; child output and container logs suppressed.', file=sys.stderr)
        sys.exit(1)
