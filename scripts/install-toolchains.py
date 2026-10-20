#!/usr/bin/env python3
"""Image-build only. Fetch pinned artifacts, verify them, then install.
Do not invoke from the runtime entrypoint. Supports Debian amd64/arm64 only.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile


def run(*args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def download(spec, target):
    if not spec['url'].startswith('https://'):
        raise ValueError('Only HTTPS artifact URLs are allowed')
    with urllib.request.urlopen(spec['url'], timeout=120) as response, open(target, 'wb') as output:
        if not response.url.startswith('https://'):
            raise ValueError('Refusing HTTPS downgrade')
        shutil.copyfileobj(response, output)
    if 'sha256' in spec:
        algorithm, expected = 'sha256', bytes.fromhex(spec['sha256'])
    else:
        algorithm, digest = spec['integrity'].split('-', 1)
        if algorithm != 'sha512':
            raise ValueError('Expected npm SHA-512 integrity')
        expected = base64.b64decode(digest, validate=True)
    with open(target, 'rb') as source:
        actual = hashlib.file_digest(source, algorithm).digest()
    if actual != expected:
        raise ValueError(f'Artifact integrity mismatch: {target.name}')


def install_binary(source, name):
    dest = Path('/opt/toolchain-bin') / name
    shutil.copy2(source, dest)
    dest.chmod(0o755)


def main():
    lock = json.loads(Path(__file__).with_name('toolchains.lock.json').read_text())
    arch = sys.argv[1]
    if arch not in lock['platforms']:
        raise SystemExit('Only amd64 and arm64 are supported')
    platform = lock['platforms'][arch]
    versions = lock['versions']
    Path('/opt/toolchain-bin').mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, CARGO_HOME='/opt/rust-cargo', RUSTUP_HOME='/opt/rustup',
               CARGO_TARGET_DIR='/tmp/cargo-clean-build', BINSTALL_DISABLE_TELEMETRY='true')
    env['PATH'] = '/opt/rust-cargo/bin:/opt/toolchain-bin:' + env['PATH']
    with tempfile.TemporaryDirectory(prefix='toolchains-') as tmp:
        work = Path(tmp)
        rustup = work / 'rustup-init'
        download(platform['rustup'], rustup)
        rustup.chmod(0o755)
        run(str(rustup), '-y', '--no-modify-path', '--profile', 'minimal',
            '--default-host', platform['rustTarget'], '--default-toolchain', versions['rust'], env=env)
        run('/opt/rust-cargo/bin/rustup', 'component', 'add', 'rustfmt', 'clippy', env=env)
        # Image toolchains are intentionally immutable at runtime. User cargo installs
        # and registry caches use the separate persistent CARGO_HOME.
        for name in ('cargo-binstall', 'sccache'):
            archive = work / (name + '.tgz')
            download(platform[name], archive)
            unpack = work / name
            unpack.mkdir()
            run('tar', '--no-same-owner', '-xzf', str(archive), '-C', str(unpack))
            matches = list(unpack.rglob(name))
            files = [f for f in matches if f.is_file()]
            if len(files) != 1:
                raise ValueError(f'Unexpected {name} archive layout')
            install_binary(files[0], name)
        bunzip = work / 'bun.zip'
        download(platform['bun'], bunzip)
        with zipfile.ZipFile(bunzip) as archive:
            matches = [n for n in archive.namelist() if n.endswith('/bun')]
            if len(matches) != 1:
                raise ValueError('Unexpected Bun archive layout')
            binary = work / 'bun'
            binary.write_bytes(archive.read(matches[0]))
            install_binary(binary, 'bun')
        # No upstream prebuilt cargo-clean-all release asset is published. Build the
        # checksummed crate with its bundled Cargo.lock in this discarded build stage.
        clean = work / 'cargo-clean-all.crate'
        download(lock['cargo-clean-all'], clean)
        source = work / 'clean-source'
        source.mkdir()
        run('tar', '--no-same-owner', '-xzf', str(clean), '--strip-components=1', '-C', str(source))
        if not (source / 'Cargo.lock').is_file():
            raise ValueError('cargo-clean-all crate lacks Cargo.lock; refusing unlocked build')
        run('/opt/rust-cargo/bin/cargo', 'install', '--locked', '--path', str(source),
            '--root', '/opt/rust-cargo', env=env)
        # Install the verified published shim and the correct platform bundle using
        # Bun. The platform dependency is explicit, not optional. No lifecycle scripts,
        # registry resolution, other architectures, or runtime downloads are needed.
        cg = Path('/opt/bun-global')
        bins = Path('/opt/bun-global-bin')
        cg.mkdir(parents=True, exist_ok=True)
        bins.mkdir(parents=True, exist_ok=True)
        main_tgz, platform_tgz = work / 'codegraph-main.tgz', work / 'codegraph-platform.tgz'
        download(lock['codegraph'], main_tgz)
        download(platform['codegraph'], platform_tgz)
        platform_name = '@colbymchenry/codegraph-linux-' + platform['codegraphPlatform']
        global_env = dict(os.environ, BUN_INSTALL_GLOBAL_DIR=str(cg),
                          BUN_INSTALL_BIN=str(bins), BUN_INSTALL_CACHE_DIR=str(work / 'bun-cache'))
        # Real Bun global installation. Bun owns package.json and the global bin link;
        # no hand-created global launcher or mutable runtime HOME path is involved.
        run('/opt/toolchain-bin/bun', 'add', '-g', '--offline', '--ignore-scripts',
            '--omit=dev', '--omit=peer', '--omit=optional', '--linker=hoisted',
            str(main_tgz), str(platform_tgz), cwd=work, env=global_env)
        for package in ('@colbymchenry/codegraph', platform_name):
            manifest = json.loads((cg / 'node_modules' / package / 'package.json').read_text())
            if manifest['version'] != versions['codegraph']:
                raise ValueError('Unexpected CodeGraph package version')
        launcher = cg / 'node_modules/@colbymchenry/codegraph/npm-shim.js'
        if not launcher.is_file() or (bins / 'codegraph').resolve() != launcher.resolve():
            raise ValueError('Bun global CodeGraph launcher missing or incorrect')
        if not os.access(bins / 'codegraph', os.X_OK):
            raise ValueError('Bun global CodeGraph launcher is not executable')
    # Only selected /opt paths are copied into the final stage; discard build caches.
    for relative in ('registry', 'git'):
        shutil.rmtree(Path('/opt/rust-cargo') / relative, ignore_errors=True)


if __name__ == '__main__':
    main()
