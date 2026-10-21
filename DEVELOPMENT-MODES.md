# DSH development modes

This is an experimental, unbuilt development-mode and GitHub CLI extension to published commit
`6c7c7001adc88c9b38cd73263729e805a49e6bda`. No new container, root-mode startup,
installation, registry publication or deployment has been performed. The baseline
passed [CI 39561266153](https://github.com/Develata/deepseek-harness-docker/actions/runs/39561266153)
on 2026-10-21, including ordinary/hardened AMD64 tools, real DSH sessions,
persistence, native authentication and publication. That run does not validate
this extension. The baseline image rejects root regardless of DSH_ALLOW_ROOT.

## Choose a mode

| Mode | Identity and capabilities | Filesystem | Persistent sources |
| --- | --- | --- | --- |
| Existing compose.yml | UID 1000, all capabilities dropped | Writable rootfs; system paths not writable by UID 1000 | ./data and ./workspace |
| Existing hardened override | Same UID 1000/capability policy | Read-only rootfs; noexec/nosuid/nodev /tmp; native copy cache disabled | Same default directories |
| New compose.dev.yml override | Same UID 1000/capability policy | Writable rootfs; explicit exec/nosuid/nodev /tmp tmpfs | Same default directories |
| New standalone compose.dev-root.yml | UID 0 and DSH_ALLOW_ROOT=1; Docker's limited default capabilities | Writable rootfs and system paths; explicit exec/nosuid/nodev /tmp tmpfs | Separate ./data-root-dev and ./workspace-root-dev |

All modes retain no-new-privileges. No development template requests privileged,
additional capabilities, unconfined seccomp/LSM, host PID/network/IPC, extra host
devices, a Docker socket/API proxy, host-root/home or host-credential mounts.
compose.yml and compose.hardened.yml are unchanged. The Dockerfile adds pinned
gh and its license plus explicit GH/XDG config paths, but retains USER node and
the prior application/tool versions. It does not enable root by default.

Root's default capabilities are a material expansion from cap_drop ALL. They
allow operations such as ownership changes and discretionary-access bypass,
while Docker still excludes powers such as SYS_ADMIN and NET_ADMIN by default.
Actual capability/namespace mappings depend on the Engine and host policy.
Inspect them during acceptance rather than assuming rootless, user namespaces
or a particular LSM is enabled. We do not reconfigure any of those host features.
[Docker capabilities](https://docs.docker.com/engine/containers/run/#runtime-privilege-and-linux-capabilities)

no-new-privileges prevents acquiring new privileges through exec; it does not
remove UID 0's existing access. Do not expect sudo to elevate the non-root mode.
Root package scripts inherit the root process's existing access. Containers
share the host kernel and root can alter writable mounts; none of these modes
is an isolation guarantee for hostile code. DSH's native authentication and
upstream tool permissions remain unchanged and separate from the OS identity.
[Docker security](https://docs.docker.com/engine/security/)

## Non-root development

Use compose.dev.yml only with compose.yml, not with compose.hardened.yml:

```sh
# Set DSH_IMAGE to an approved fixed tag/digest first.
docker compose -f compose.yml -f compose.dev.yml config
# After reviewing configuration and preparing the dedicated UID1000 bind paths:
docker compose -f compose.yml -f compose.dev.yml up -d
```

It adds npm_config_prefix/cache and explicit Bun global/bin locations under
/data/home, and a 1 GiB executable /tmp tmpfs. It does not grant root, modify
the image user, or remove cap_drop ALL. The base root filesystem was already
writable; /usr and /opt remain protected by ordinary ownership. The extra
package-manager paths are probed only when their variables are explicitly set,
so ordinary startup does not gain new default cache directories.

This combination is source-compatible with the old non-root identity check,
but its new package-manager/tmpfs behavior still needs the acceptance tests below.

## Standalone root development

Use only compose.dev-root.yml. Do not combine it with other Compose files.
It requires DSH_DEV_IMAGE to identify an approved new image built from the
candidate after testing; no mutable latest fallback or automatic build is used.
The default user of that image remains node. Only the standalone template
selects user: "0:0" and DSH_ALLOW_ROOT: "1" together.

The template binds ./data-root-dev to /data and ./workspace-root-dev to
/workspace with create_host_path: false. These are relative to the Compose
file's directory on the Docker host. They must not overlap the default data or
workspace. Do not assume a client's directory is on a remote Docker host.
Before initialization, confirm both paths are new, are not symlinks, and refer
to the intended Docker host. If either exists, inspect its purpose/ownership
first; do not reuse the initialization command as permission repair.

```sh
# Only for the two confirmed, genuinely new dedicated paths:
mkdir -m 700 ./data-root-dev ./workspace-root-dev

# Set DSH_DEV_IMAGE to the approved new image first.
docker compose -f compose.dev-root.yml config

# Requires approval of the actual instance, image, bind paths and root settings:
docker compose -f compose.dev-root.yml up -d
docker compose -f compose.dev-root.yml exec dsh sh
```

mkdir has no -p and does not modify existing directories. Startup does not
chmod/chown them. rootless/userns mappings may affect bind access and must be
checked on the actual host. Choose a specific existing project only after
reviewing and backing up its contents; do not substitute an entire repository
parent directory or home. The template uses directory binds, not named volumes;
named volumes are an optional operator-selected alternative, not a default.

It publishes only 127.0.0.1:3081, with matching advertised URL and trusted host.
Open the native launch URL privately using that exact host/port. Do not share
logs, launch tokens or cookies. If an external proxy is deliberately configured,
keep public examples at dsh.example.com, and review URL/Host/Origin/TLS settings
separately. No gateway, credentials or new authentication plugin is added.
restart is "no" for explicit trial startup; no automatic boot-time root service
is requested. init and the existing 30-second stop grace remain enabled.

The separate file avoids inheritance of cap_drop ALL, read_only, noexec tmpfs
or NARB_DISABLE_NATIVE_CACHE from other modes. An ordinary empty YAML list is
not a reliable reset of an earlier Compose list. Do not use a stack of overrides
to turn the production configuration into root mode.
[Compose merge rules](https://docs.docker.com/reference/compose-file/merge/)

## Identity and existing data checks

The entrypoint and self-check share these fail-closed checks:

- DSH_ALLOW_ROOT unset or "0": UID 0 is rejected; existing positive non-root
  UIDs remain allowed. This does not change the image's default UID 1000.
- DSH_ALLOW_ROOT="1": actual UID must be 0. Setting only the environment variable
  on a non-root process fails; setting only user: "0:0" also fails.
- Unknown identity and other opt-in values fail. The variable is configuration
  intent, not a privilege escalation mechanism or an adversarial security boundary.
- Root mode requires HOME=/data/home and DSH_HOME=/data/dsh. Alternate paths are
  rejected before any home creation, rather than silently using /root.
- A read-only lstat check inspects only /data and its two immediate home paths.
  /data must exist as a directory, but may belong to the host user. Missing home
  children are allowed and are then created by the existing runtime-UID helper.
  Existing home children must be directories owned by container UID 0.
  Symlinks, including dangling ones, and other path types fail. No contents are
  scanned and no ownership, permissions or existing config is repaired.
- The workspace bind may be a specifically selected host-owned project. It is
  not forced to root ownership and is not recursively changed at startup.

The metadata guard catches common accidental reuse of UID1000 homes. It does
not inspect mixed ownership deeper in a root-owned tree, validate the semantic
contents of a mount, or defend against a hostile host changing paths between
checks. /data is a mount boundary, not a discovery of arbitrary host paths.
Operators must still select dedicated bind sources. Do not present this check
as a migration or isolation mechanism.

umask remains 077. Root-created data can be unreadable to a later UID1000
process. In rootful Linux without userns remapping, new bind files normally
appear as host UID0; rootless, userns and Desktop mappings differ. Switching
user back to 1000 is not an ownership migration. Never chmod 777 or recursively
chown the original data as an automatic fix.

For a trial, keep the root directories separate and use synthetic data. To
roll back, stop the root instance and return to the untouched default instance:

```sh
docker compose -f compose.dev-root.yml stop
# If removal of the trial container is desired, preserve its bind source data:
docker compose -f compose.dev-root.yml down
```

Neither command deletes bind source directories. Do not add -v, delete the
directories, or recursively clean/change their ownership as part of rollback.
Real migration requires stopped instances, consistent backups and explicit
source/target review, including symlinks, ACLs and database consistency. Migrate
a dedicated copy only after approving that operation; startup never migrates.

## Tool paths and persistence

| Content | Location | Across container recreation |
| --- | --- | --- |
| DSH profiles, sessions, stores and credentials | /data/dsh | Retained in the selected bind directory |
| HOME | /data/home | Retained; never changed to /root |
| GitHub CLI config and file-backed credentials | /data/home/.config/gh | Retained; external keyring storage is not covered |
| Git user configuration | /data/home/.gitconfig and .config/git/config | Retained; credential helpers may store secrets elsewhere |
| User Cargo installs and caches | /data/home/.cargo | Retained |
| User Bun global packages/bins/cache | /data/home/.bun and .cache/bun | Retained |
| User npm global packages/bins/cache | /data/home/.local/npm and .cache/npm | Retained with the template's prefix/cache |
| Rust toolchain and rustup state | /opt/rustup | Image-owned; running-layer changes lost |
| Image cargo tools/proxies | /opt/rust-cargo, /opt/toolchain-bin | Image-owned; running-layer changes lost |
| GitHub CLI executable and license | /opt/toolchain-bin/gh, /opt/dsh-wrapper/licenses/gh/LICENSE | Image-owned; no runtime installation/login |
| Image CodeGraph global package/launcher | /opt/bun-global, /opt/bun-global-bin | Image-owned; not hidden by a new data bind |
| Source, dependencies, Python venvs, CodeGraph .codegraph index | Project under /workspace | Retained; binary dependencies may need rebuilding |
| sccache cache | /data/home/.cache/sccache | Retained, with existing 2G cache limit |
| apt/system packages and manual /usr or /opt edits | Container writable layer | Lost when the container is removed/recreated |
| /tmp | 1 GiB tmpfs in development templates | Removed when the container stops |

Image tools remain first on PATH. npm's new bin directory is appended without
interpolating the host PATH; a same-name user installation does not automatically
replace a pinned image tool. npm/Bun user installation paths are distinct from
the image-owned CodeGraph package. No existing npm, Cargo, Bun or DSH config
file is overwritten.
[npm folders](https://docs.npmjs.com/cli/v11/configuring-npm/folders/)

Keep RUSTUP_HOME=/opt/rustup for this version. Pointing it at an empty persistent
directory does not seed a default toolchain and can break rustc/cargo. A separate
explicit initialization process would be needed for persistent user-managed
toolchains; no startup copy/download is added here. Use a reviewed derived
Dockerfile for lasting toolchain/system-package changes. An apt installation in
root mode may work, but packages requiring additional privileges or a full init
system are not guaranteed. No sudo workflow is assumed.

The tmpfs specifies exec explicitly while retaining nosuid/nodev. Its size is a
ceiling, not preallocated RAM. Temporary files count toward memory use and may
reach host swap; keep credentials, sessions and work out of /tmp. Large builds
can use a project build directory or a separately reviewed limit. The templates
do not establish CPU, overall memory, PID or persistent-disk limits.
[Docker tmpfs](https://docs.docker.com/engine/storage/tmpfs/)

## GitHub CLI and credential boundaries

This candidate installs official gh 2.102.1 during the image build, from the
versioned Linux archive for TARGETARCH, verified against its committed SHA-256.
The binary is /opt/toolchain-bin/gh; the archive's MIT license is retained at
/opt/dsh-wrapper/licenses/gh/LICENSE. The upstream release also embeds dependency
license notices. The existing application/toolchain pins are not upgraded.
Both AMD64 and ARM64 download pins are supplied; only AMD64 acceptance is planned
here, and neither architecture of this candidate has been built or run.

The Dockerfile sets HOME=/data/home, XDG_CONFIG_HOME=/data/home/.config and
GH_CONFIG_DIR=/data/home/.config/gh. These GH/Git paths equal their usual Linux
defaults for the existing HOME. Entrypoint creates absent configured directories
with mode 0700 under umask 077, but does not copy, move, tighten permissions on,
or overwrite existing configuration. Explicit operator environment overrides
remain respected, not rewritten at startup. If you previously changed HOME or
used a custom XDG/GH location, review and explicitly set the corresponding
variables together; a HOME-only override no longer moves these explicit image
defaults. Overridden paths outside /data are not covered by its persistence.

This follows the useful separation in the official
[Hermes Dockerfile](https://github.com/NousResearch/hermes-agent/blob/8cf3a0b03d86a61c2ac9d50cd178acca86f6b564/Dockerfile):
installed code/tools outside the data mount and mutable state/tool HOME inside
it. Hermes separately uses HERMES_HOME/home for subprocess HOME; DSH keeps its
existing, single /data/home layout. Hermes lists gh as an optional package, so
this is not a claim that its base image always preinstalls gh, nor a dependency
on Hermes code, startup logic, credentials or privileges.

Scope is deliberately specific, not "all credentials are persisted":

- DSH's own credentials stay in /data/dsh/.credentials.yaml under the existing
  native behavior. No credential values are read, copied or configured here.
- gh config files, including file-backed credentials if gh writes them, are
  under GH_CONFIG_DIR. gh prefers a system credential store when available and
  can fall back to a plaintext file in a headless environment. GH_CONFIG_DIR
  does not relocate an external keyring or guarantee encryption at rest.
- GH_TOKEN takes precedence over GITHUB_TOKEN, and environment tokens take
  precedence over stored credentials. This image does not set either token,
  bake it into layers/Compose, or copy environment tokens into /data. Do not
  put secrets in build args, image ENV, shell history, env dumps or support logs.
- Git reads its usual .gitconfig/XDG config; a credential helper may store
  secrets elsewhere. No global helper is installed or replaced. In particular,
  startup never runs gh auth setup-git, which modifies the helper configuration.
- npm's user .npmrc normally follows HOME; project-level .npmrc belongs to its
  project, and custom userconfig/credential helpers are outside this guarantee.
  There is no automatic migration of npm, Git, Bun or other tool credentials.
- OpenSSH resolves its default user config and tilde identity paths using the
  account's passwd home, not merely HOME. The base node/root passwd homes are
  not changed, and openssh-client is not newly installed here. If SSH is later
  intentionally installed and configured, explicitly select a user-created
  configuration, for example ssh -F /data/home/.ssh/config example.com, and use
  absolute IdentityFile and UserKnownHostsFile paths under that directory.
  A -F file alone does not relocate default identity/known-host paths. Do not
  copy host keys or disable host-key verification as an automatic setup step.

Treat each data bind as sensitive: new directories should be private, backups
must be access-controlled, and neither data nor tokens belong in build context
or published artifacts. Existing permissive directories are not silently fixed.
Root development uses a separate data-root-dev bind; it does not share the
normal instance's account configuration. Login or configuring persistent account
access is a separate operator action, not part of building/starting this image.
No login, setup-git, auth-status/token inspection or credential generation occurs
in startup, self-check or acceptance instrumentation.

[GitHub CLI environment](https://cli.github.com/manual/gh_help_environment),
[credential storage](https://cli.github.com/manual/gh_auth_login),
[Git configuration lookup](https://git-scm.com/docs/git-config#FILES),
[pinned gh release](https://github.com/cli/cli/releases/tag/v2.102.1).

## Self-check semantics

The diagnostic remains offline and starts no DSH server, install, compile or
model call. Both modes check pinned versions, executable lookup, CodeGraph's
real image launcher, tool-directory layout and writable runtime locations.
gh is checked only with --version; no account configuration is required. The
diagnostics disable gh's update notifier for their child processes.
Non-root retains the immutable-tools check. Root reports root-tool-layout and
explicitly says image-tool immutability was not asserted; it does not claim
that /opt is protected from UID0. Both JavaScript and Python closed diagnostic
stage allowlists include the new stage, without accepting arbitrary log data.
Manually changing a pinned tool may intentionally make version checks fail.

## Pending runtime acceptance

No row below is claimed to have run for this candidate. Run only after approving
the test image and disposable container settings. Use new synthetic bind fixtures,
no real credentials or model calls. Do not invoke the root matrix as an implicit
side effect of normal startup or ordinary non-root tests.

| Test | Default and hardened regression | Non-root development | Root development |
| --- | --- | --- | --- |
| Expand Compose and inspect configuration | Existing UID1000/security policy retained | Same identity/caps with exec tmpfs | UID0, opt-in, default limited caps; no unsafe mounts/namespaces |
| Identity negative cases | Root rejected without opt-in | Flag alone still rejected | User alone, bad flag, unknown identity rejected |
| Data guard | Existing helper behavior unchanged | Same as default | UID1000 homes, symlink homes/data and bad paths reject before writes |
| Empty and reused dedicated bind directories | Re-run existing suite | New package paths created | Root-owned homes created, subsequent starts preserve data |
| Tools and offline Rust/Python/sccache | Re-run existing suite | Pinned tools plus user package fixture | Same; root diagnostic does not assert immutability |
| gh version, config and persistence | Pinned version; synthetic prompt setting survives recreation | Same with no account tokens | Same with root-owned private config; no real authentication |
| Direct ELF execution from /tmp | Hardened rejects; project build works | Must succeed | Must succeed |
| npm/Bun/Cargo install location and recreation | Existing behavior | Local fixture bins/cache survive | Same, with actual ownership recorded |
| Writable container layer | Non-root cannot write system paths | Same | Synthetic system-layer file survives restart, disappears on recreation |
| Native HTTP authentication | Anonymous/invalid-token rejection and authenticated HTML | Same | Same, including advertised/trusted 3081 authority |
| Real Web-session CodeGraph registration | Re-run existing suite | New test | New test; MCP-disabled negative control |
| Existing patches/config unchanged | Byte checks | Byte checks | Byte checks on synthetic fixture |
| Config discovery with explicit XDG/GH | Verify DSH/CodeGraph/Git discovery and preserved custom overrides | Same | Same with dedicated data; no automatic migration |
| Shutdown and restart/recreation persistence | Re-run existing suite | New test | New test; verify no root fixture touched default data |
| Root-to-UID1000 misuse | Normal permission diagnostics | No repair | Synthetic UID switch fails safely; no auto-chown |

Inspect actual NoNewPrivs=1, effective/bounding capabilities, seccomp and mount
flags. Check /tmp by compiling and directly running a tiny ELF; running
sh /tmp/script does not prove the mount allows exec. Use local synthetic
package fixtures to avoid live downloads. An optional apt test needs an approved
package/version and is separate from inert unit tests. Preserve data on stop/down;
any fixture cleanup must be scoped to explicitly created synthetic paths.

The existing manual image workflow is unchanged. It covers the default and
hardened modes, not this new root matrix. Its toolchain probe is extended with
gh --version and a nonsecret prompt setting in fresh synthetic GH config; the
setting is read before being recreated in cycle two. It checks file ownership,
0600 config and 0700 new directory modes without logging their contents.
It never runs gh auth status/login/setup-git or accesses an account API.
These added container assertions have not run. Do not publish or describe root mode
as supported based only on that workflow or on unit/static checks. Runtime
compatibility, registry publication and deployment remain separate review gates.

## Inert checks

The following commands exercise synthetic local fixtures and static contracts,
not Docker or DSH runtime startup:

```sh
node --test tests/prepare-homes.test.mjs tests/runtime-checks.test.mjs tests/dsh-session-smoke.test.mjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_*.py'
```

They cover identity combinations, metadata-only root-home guards, secret-free
errors, per-mode self-check policy, diagnostic schema synchronization, optional
package-manager paths, build-context exclusions, and static Compose boundaries.
GH tests mock download/extraction/install calls, verify checksums-before-extraction,
license preservation and exact official pins; no archive is downloaded or run.
They are not substitutes for Docker Compose's own config expansion or runtime
acceptance under the target Engine/kernel.
