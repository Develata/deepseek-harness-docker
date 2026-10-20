# Toolchain expansion draft

Initially prepared 2026-10-20 against `f1035ae9814825c62eb067b71dc43339865b48a3`;
now rebased as a private increment onto published hotfix `86ee9bdbdb2222edec33f06da01eadbe74bd6279`.
The toolchain candidate is not committed, published, installed, built, deployed,
or runtime-tested. Existing files omitted from the incremental patch remain intact.

The base HOME hotfix passed its [AMD64 build/native-auth smoke and publication](https://github.com/Develata/deepseek-harness-docker/actions/runs/39484093048).
That run did not contain or validate these toolchain additions. Current latest
is the hotfix image, not the private candidate.

An incremental deployment-hardening review and exact current validation record are in
[DEPLOYMENT-REVIEW.md](DEPLOYMENT-REVIEW.md). The historical static-check statements below
describe the initial toolchain draft; no container acceptance for the toolchain candidate has run.

## Exact scope

- Node 26.12.0 Current in the official Debian bookworm-slim image; DSH remains
  0.2.1-rc.2 and pnpm remains 10.14.0.
- Rust 1.99.1 (stable at preparation), rustup 1.29.1, rustfmt and clippy;
  cargo-binstall 1.26.0, sccache 0.18.0, cargo-clean-all 0.6.5.
- Bun 1.4.3 uses `bun add -g` (global installation) for published @colbymchenry/codegraph 1.6.2 and its matching
  Linux platform bundle, using integrity-checked local tarballs offline with
  lifecycle scripts and optional dependency resolution disabled.
- Python3 was already present; add python3-venv for project-local Python packages.
  No global pip/package installation or automatic cleanup is performed.
- CodeGraph MCP is enabled using an image-owned Cordis patch on every launch;
  set DSH_CODEGRAPH_MCP=0 to disable it or to use your existing CodeGraph entry.
  No persistent DSH profile, agent permissions, credentials, or user config is rewritten.

## Runtime separation and persistence

CodeGraph's source application rejects Node >=25. The npm thin launcher instead
executes the package's bundled Node24 runtime and native kernel. System Node26
remains the runtime for DSH. Do not use `bun run`, `bun --bun`, a source checkout,
or CODEGRAPH_ALLOW_UNSAFE_NODE to bypass the upstream compatibility guard.

Image binaries and Rust toolchains live under /opt, outside /data and /workspace.
CodeGraph is a real Bun global install: build-only BUN_INSTALL_GLOBAL_DIR selects
/opt/bun-global and BUN_INSTALL_BIN selects /opt/bun-global-bin. Bun itself creates
its global manifest and codegraph launcher. These settings are not forced on the
runtime user's Bun installs; the image global-bin directory is explicitly on PATH.
The smoke test checks command lookup and resolves the actual global-bin symlink.
They are root-owned/read-only to the node UID1000 runtime. Rustup can select/use
the bundled toolchain but cannot update its shared /opt tree as node. Rebuild the
image to update its tools. User `cargo install` / `cargo binstall` installs and
Cargo registry/git caches go to /data/home/.cargo. Additional user-managed Rust
toolchains need a separately configured writable RUSTUP_HOME and are not seeded
or migrated by this draft. The image's pinned tools precede user bins on PATH.

Bun user installs and caches remain under /data/home. sccache's local cache is
/data/home/.cache/sccache with a 2G limit. It is installed but NOT forced globally:
use RUSTC_WRAPPER=/opt/toolchain-bin/sccache for a project build when desired.
This avoids overwriting existing Cargo configuration or breaking unusual builds.
There is no scheduled or startup cache sweep; cargo-clean-all is an explicit tool.

CodeGraph stores project indexes in .codegraph/ inside the project. No automatic
`codegraph install` or `codegraph init` is run by the image. Initialize a project
explicitly when desired; the MCP can discover tools before an index exists. Once
an existing project index is opened, upstream CodeGraph may sync/watch it and run
its local shared daemon. Back up index/data with the workspace; local filesystems
are preferable to network filesystems for SQLite locking. Multi-project sessions,
DSH MCP probe/reconnect, and daemon shutdown require the tests below.

Telemetry is disabled for CodeGraph and cargo-binstall. CodeGraph's automatic
missing-bundle download fallback is disabled. No model or embedding credentials
are added and no broad environment-forwarding override is introduced. Existing
DSH stdio environment scrubbing and tool-permission behavior remain in force.

## Supply-chain boundaries

scripts/toolchains.lock.json records exact release URLs and SHA256 values from
GitHub release metadata/rustup checksum metadata, plus npm SHA512 integrity from
the official registry and the cargo-clean-all crate checksum. The installer
fails on a checksum mismatch before executing/extracting that artifact.

cargo-clean-all has no published GitHub binary asset, so its checksummed crate is
compiled with its bundled Cargo.lock in the discarded builder stage. This is an
explicit source build, not a silent binstall fallback to a third-party binary host.

This is NOT a claim of a fully reproducible or security-audited image. Node's tag
is not digest-frozen, Debian packages are not snapshot-pinned, existing DSH/pnpm
npm dependencies are not lockfile-frozen, and rustup obtains pinned-version
components with upstream checksums at build time. Checksums establish the pinned
bytes, not independent author identity or a security audit. A distributable release
should additionally verify provenance/attestations, resolve the Node image digest,
scan the resulting image, and generate the complete dependency/license inventory.

The inherited lock retains amd64/arm64 entries without changing their bytes. This
revision targets AMD64 only; no ARM work or compatibility claim is included.

## Static checks performed

- Python installer compiled as Python syntax only (no installer main executed).
- Node --check passed for the modified entrypoint (no DSH launched).
- Metadata verified against official registries/releases and source documents.
- JSON lockfile parsed and artifact hash lengths checked.
- Added test files pass Python AST and Node syntax checks only.
- Baseline file Git blob hashes match the fetched commit; patch applies in dry-run.

## Automated smoke coverage added (not executed here)

The existing workflow remains manual-only, with publish=false by default. Its
new toolchain smoke step runs before the unchanged native-authentication smoke.
The build-job timeout increases from 25 to 35 minutes for the added Rust source
build/tests. No new trigger, permission, or credentials are added. Publication
still requires publish=true on the default branch after the entire build job
passes. That job now pushes both the fixed commit tag and latest from the same
loaded/tested image, then compares their registry digests. It does not rebuild.
If digest verification fails, publication reports failure; it does not attempt
an automatic rollback or delete already-published tags.

The unchanged alias-latest.yml is historical: it hardcodes
sha256:38bce61913392e3eff0cb088b316c41c96733918b3c24f064c0bbb687f5e47e3.
Manually running it would roll latest back to that old image. README explicitly
warns not to use it to release this revision; normal releases use image.yml.

Standalone after an approved image build:

    python3 scripts/toolchain-smoke.py dsh-tested:local

The updated host test creates new synthetic bind directories, tests a genuinely
empty bind first, and then recreates UID1000 containers over retained data. It
checks actual Web-profile and global-patch bytes through UID1000 helpers, avoiding
host-UID permission assumptions. Container-side checks exercise pinned tools,
Python venv, offline Rust compile, sccache, retained cache-directory markers and
Cargo bins, plus standalone MCP discovery. The actual Web-session test and its
negative control are described in DEPLOYMENT-REVIEW.md. All runtime tests remain
unexecuted; test files passing syntax/unit checks is not container validation.

Only uniquely named synthetic containers and internal networks are removed;
bind fixtures are retained. No real user data path is accepted and no runtime data
is uploaded. Captured child logs, tokens and protocol payloads are not printed.

A direct MCP handshake proves installed server operation, not session registration.
The new test-only observer now exercises the real Web SessionController and checks
ctx.tools.schemas(agent) after loader settlement, then checks the same session
after recreation. An MCP-disabled negative control catches a falsely unconditional
pass. This integration test is implemented but NOT executed; its fake-service unit
tests verify the oracle only. See DEPLOYMENT-REVIEW.md for exact scope and limits.

## Required validation before publishing/deployment

1. Build on the approved architecture. Verify Bun offline/local-tarball install,
   executable permissions, crate Cargo.lock, Rust component downloads, and dynamic
   library requirements. Build must fail on an intentionally corrupted hash.
2. As UID1000, test node, python3, python3 -m venv, bun, cargo, rustc, rustup,
   cargo-binstall, cargo-clean-all, and sccache. CodeGraph --version must succeed
   while system Node is 26; confirm its launcher actually selects bundled Node24.
3. Mount a completely empty UID1000-owned /data bind directory and /workspace;
   verify every preinstalled binary still resolves. Repeat using existing data.
4. Compile a tiny Rust project; repeat with RUSTC_WRAPPER set and check sccache
   stats. Verify user Cargo cache writes succeed without changing /opt. Restart
   and recreate the container; confirm persistent caches and user-installed bins.
5. Perform MCP initialize and tools/list without a model call or credentials.
   Verify absent index does not create a new project index. Explicitly initialize
   only a disposable fixture project, confirm query/sync behavior, reconnect, and
   DSH's initial probe process. Check multiple clients share a safe daemon.
6. Hash existing DSH profile/patch and Cargo config before/after two starts;
   assert unchanged. Test DSH_CODEGRAPH_MCP=0, invalid value, custom user --patch,
   duplicate CodeGraph namespace, and multiple initialized workspace projects.
7. Run the existing native-auth Web UI smoke test. Preserve anonymous/invalid
   token rejection, loopback-only host publication, and signal forwarding. Never
   print native launch credentials. Check shutdown leaves no container children.
8. Remain AMD64-only. Validate kernel/CPU support, image size, startup latency,
   license inventory and image security scan. Repeat accepted runtime tests with
   compose.hardened.yml semantics before claiming read-only-rootfs compatibility.

## Primary sources

- https://nodejs.org/en/about/previous-releases
- https://github.com/docker-library/official-images/blob/master/library/node
- https://static.rust-lang.org/dist/channel-rust-stable.toml
- https://static.rust-lang.org/rustup/release-stable.toml
- https://rust-lang.github.io/rustup/installation/index.html
- https://github.com/cargo-bins/cargo-binstall/releases/tag/v1.26.0
- https://github.com/mozilla/sccache/releases/tag/v0.18.0
- https://github.com/dnlmlr/cargo-clean-all/releases/tag/v0.6.5
- https://crates.io/api/v1/crates/cargo-clean-all/0.6.5
- https://github.com/holmgr/cargo-sweep (explicitly unmaintained)
- https://github.com/oven-sh/bun/releases/tag/bun-v1.4.3
- https://bun.com/docs/pm/cli/install
- https://bun.com/docs/pm/cli/add#--global
- https://bun.com/docs/runtime/bunfig#installglobaldir
- https://registry.npmjs.org/@colbymchenry%2fcodegraph/1.6.2
- https://github.com/colbymchenry/codegraph/blob/v1.6.2/scripts/pack-npm.sh
- https://github.com/colbymchenry/codegraph/blob/v1.6.2/scripts/npm-shim.js
- https://github.com/colbymchenry/codegraph/blob/v1.6.2/src/bin/codegraph.ts
- https://github.com/colbymchenry/codegraph/blob/v1.6.2/src/mcp/engine.ts
- https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/mcp/mcp-client/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/user/guide/mcp-memory.md
