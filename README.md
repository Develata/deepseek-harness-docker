# DeepSeek Harness Docker image packaging

Unofficial packaging of the unmodified official DeepSeek Harness Web UI. No authentication plugin, Nginx, Caddy, external login configuration, or credentials are included. Native DSH launch-token/cookie authentication remains enabled.

Status: the HOME initialization hotfix at [86ee9bdbdb2222edec33f06da01eadbe74bd6279](https://github.com/Develata/deepseek-harness-docker/commit/86ee9bdbdb2222edec33f06da01eadbe74bd6279) is published. [Its AMD64 build, four HOME regression tests, native-authentication smoke and publication succeeded](https://github.com/Develata/deepseek-harness-docker/actions/runs/39484093048) on 2026-10-20. Its fixed commit tag and latest resolve to sha256:ded6dd3af1ea6d77706f48a21175051604766b0be4b33ee4ee4cc24bdbca40bd.

This toolchain/diagnostics candidate is a separate, private increment on that published commit. It has NOT been built, run as DSH, published or deployed. The existing latest image contains the hotfix, not these toolchain additions. Only this candidate's lightweight local unit/static checks have run; the successful hotfix CI does not validate Node26, Rust/Bun/CodeGraph, session registration or the optional hardened profile. See [DEPLOYMENT-REVIEW.md](DEPLOYMENT-REVIEW.md) for exact evidence and remaining acceptance tests.

## Fixed application version

- @deepseek-ai/dsh@0.2.1-rc.2, official release tag dsh-v0.2.1-rc.2, verified source commit 687f282e8625c6b8d11ff58211a90524be2e4317.
- node:26.12.0-bookworm-slim is listed in Docker's official Node image catalog.
- pnpm@10.14.0 is included for DSH's native profile/plugin management, not for adding any community plugin.

Top-level versions are fixed; the base image tag, Debian packages and npm transitive dependencies are not digest/lockfile-frozen. This is not a byte-reproducible or security-audited release.

## Development toolchain draft

This revision adds pinned Rust stable, rustup, cargo-binstall, sccache, cargo-clean-all, Bun, and CodeGraph. Python3 was already present; python3-venv is added. Node is the latest Current release at preparation, not LTS. See [TOOLCHAIN-REVIEW.md](TOOLCHAIN-REVIEW.md) for pins, supply-chain limitations, persistence, and required runtime tests. The toolchain image built successfully and its ordinary runtime suite passed in [CI run 39556949149](https://github.com/Develata/deepseek-harness-docker/actions/runs/39556949149): empty bind startup, non-root tools, native authentication, actual Web-session CodeGraph registration, persistence after container recreation, and an MCP-disabled control. The optional hardened run failed before backend readiness, so publication was skipped and latest remains the HOME hotfix. The native-cache adjustment below still requires a new full CI run.

CodeGraph is installed globally with bun add -g into image-owned /opt paths, with its real global binary on PATH. It uses its bundled Node24 runtime, independently of DSH's system Node26. Its MCP entry is added through an image-owned startup overlay, without changing persistent user patches or credentials. Set DSH_CODEGRAPH_MCP=0 if you already configure CodeGraph or want it disabled. There is no automatic agent installer, project initialization, cleanup, or runtime tool download.

## Build

On a machine with Docker:

    docker build -t deepseek-harness:0.2.1-rc.2 .

This downloads and installs the official package and its dependencies. No build of this toolchain candidate has been performed; the published hotfix build above used the previous toolchain.

## Run locally with persistent data

    docker run -d --name deepseek-harness \
      --init --restart unless-stopped \
      --cap-drop ALL --security-opt no-new-privileges \
      -p 127.0.0.1:3080:3080 \
      --mount type=volume,source=dsh-data,target=/data \
      --mount type=volume,source=dsh-workspace,target=/workspace \
      deepseek-harness:0.2.1-rc.2

Only the Docker host's loopback port is published. EXPOSE does not publish a port by itself. Do not change this to a public 0.0.0.0 binding without your own protection. Host administrators and other explicitly attached containers are trusted; this wrapper does not isolate hostile local users.

The upstream application disallows wildcard binds. The entrypoint selects the container's sole non-loopback IPv4 address and refuses ambiguous multi-network configurations unless an explicit concrete local --host is provided. Prefer one private bridge network. The default advertised URL is http://127.0.0.1:3080/ for local use. Additional arguments are passed to the official DSH Web CLI; any external URL, trusted-host, TLS or gateway configuration is left to the operator.

Inspect startup locally:

    docker logs deepseek-harness

DSH prints its native authenticated launch URL. That URL contains a bearer credential: open it only on your own Docker host/browser or authorized local tunnel, and do not share logs publicly. A new process can issue a new launch credential. No external username/password is created by this image. Model credentials are also left to the operator.

## Data and shutdown

/data/dsh stores DSH profiles/application data; /data/home stores the process home; /workspace stores work files. The process uses the unprivileged node user (UID 1000). Named volumes normally inherit the image's directory ownership on first creation; bind mounts hide the image's precreated directories and require suitable host ownership/permissions. This candidate creates missing home/cache subdirectories as the unprivileged runtime user, probes create/write/rename/unlink, and reports which setting is unwritable. It never runs root permission repair, changes existing ownership/modes, or rewrites config.

Stop before making a consistent encrypted backup of both volumes. Do not delete volumes casually. No automatic upgrade or migration is provided. Test newer versions with backup copies before switching an existing instance.

Docker --init reaps descendants. The wrapper forwards termination and gives DSH up to 20 seconds before a forced stop; use a container stop timeout above 20 seconds, for example:

    docker stop --time 30 deepseek-harness

## Checks still required

Before relying on this toolchain candidate: build on AMD64, verify npm install/native modules, start the native Web UI, open the authenticated launch URL, verify conversation/workspace persistence across restart, verify loopback-only publication, and test graceful stop. Test the intended shell/sandbox features under the chosen container restrictions; do not assume Docker or DSH guarantees isolation. No model call or real credential is needed for initial startup checks.

For a distributable release, resolve the base digest, lock dependency integrity, inspect package provenance, scan the image and include the full dependency license inventory. Publication and image-registry push of this toolchain candidate are not authorized by its preparation; they require separate review and approval.

## Startup diagnostics and persistent locations

Images before hotfix 86ee9bd only created /data/home during image build.
An empty ./data:/data bind hides that directory and can cause
`cannot list /data/home: ENOENT`. The published hotfix now creates missing HOME and
DSH_HOME at startup as the existing runtime user. This candidate preserves that
helper and its regression tests unchanged, then adds broader writable-path checks. EACCES/read-only failures are different: prepare the dedicated host mounts
for UID 1000; do not fix them with a root entrypoint or world-writable permissions.

For an older image, if the service is named dsh and /data is already writable,
this operator-run command creates only the two missing directories:

    docker compose exec --user 1000:1000 dsh sh -c 'umask 077; mkdir -p /data/home /data/dsh'

It does not change an existing directory's owner or mode. If the container is not
running, the same mkdir can be run using a one-off Compose container with
`run --rm --no-deps --user 1000:1000 --entrypoint sh dsh -c ...`.

With ./data:/data and ./workspace:/workspace, the pinned DSH Web profile uses:

- UI settings/profile overrides: ./data/dsh/profiles/web/cordis.patch.yml.
- Cross-profile manual overrides: ./data/dsh/cordis.patch.yml, above the profile layer.
- Profile/plugin manifest: ./data/dsh/profiles/web/package.json.
- Sessions: ./data/dsh/sessions/; persistent application stores: ./data/dsh/storages/.
- UI-saved provider API keys/OAuth records and native browser-cookie signing secret:
  ./data/dsh/.credentials.yaml.
  This file is sensitive; never paste it or upload it with diagnostics.
- Process HOME, user Cargo/Bun installs and caches: ./data/home/.
- Project files, Python venvs and explicitly initialized CodeGraph indexes: ./workspace/.

These are defaults, not a claim that every file exists before first use. Custom
profiles/paths can change them. The old settings.yaml is migration input in this
DSH release, not the current primary settings file. Native browser launch-token
and cookie authentication remains upstream-owned, separate from provider keys and
from any external login you configure.

Wrapper preflight validates MCP enable/disable, a supplied listen port (0–65535),
public HTTP(S) URL, concrete local bind address, and paired TLS flags. Unknown CLI
flags still go to DSH. It checks directory writes before launching, without
printing argv, environment values, file contents or credentials. Overriding port
or public URL does not change Docker port publication automatically; update your
own mapping/proxy consistently. A port of 0 is valid upstream but unsuitable for
the fixed-port Compose examples.

An optional offline diagnostic starts no DSH server, build, install or model:

    docker compose run --rm --no-deps --entrypoint node dsh /opt/dsh-wrapper/self-check.mjs

Use an approved image of this candidate, not an older published image lacking
that file. It checks tools under the runtime UID, image tool immutability and
writable homes/workspace/tmp. It is not an MCP integration test.

## Optional read-only root filesystem

The checked-in compose.yml is a local-only, AMD64 bind-mount example. It requires
an explicit DSH_IMAGE and existing ./data and ./workspace directories; it does not
automatically create root-owned host paths. Create dedicated directories writable
by UID 1000 before starting. Do not point it at unmigrated existing data.

compose.hardened.yml is a separate, opt-in override, not a default security change:

    DSH_IMAGE=your-approved-image docker compose -f compose.yml -f compose.hardened.yml config
    DSH_IMAGE=your-approved-image docker compose -f compose.yml -f compose.hardened.yml up -d

Review config before running up. No deployment was performed when preparing this
candidate. The override keeps read_only: true and a writable 512 MiB /tmp tmpfs
with explicit noexec,nosuid,nodev,mode=1777. /data and /workspace stay writable/persistent. /tmp is
memory-backed and disposable; never store sessions, caches, credentials or work
there. Its size is a ceiling, not preallocated RAM, and heavy jobs may need a
reviewed larger limit. Docker already defaults tmpfs to noexec; omitting the word
did not guarantee execution was allowed. The override now sets
NARB_DISABLE_NATIVE_CACHE=1 so DSH's native-addon loader uses the original image
libraries rather than copying them into noexec /tmp. This disables only the addon
copy cache, not Cargo caches or sccache. Default Compose and image startup do not
set it. Temporary executables cannot run from /tmp: use a reviewed writable project
build directory when a tool requires execution. This is hardening, not isolation
from untrusted code, and hardened runtime compatibility remains unverified.

Python venvs belong in /workspace; user Bun/Cargo installs and caches in /data/home;
CodeGraph indexes in the project; image binaries and Rust toolchains stay under
/opt. Package installation into system paths and rustup updates of /opt are not
supported even in the normal non-root profile. Rebuild image-owned tools instead.
Actual compatibility of this hardened profile is UNVERIFIED until approved CI
passes both modes, including the CodeGraph/DSH session test. Do not copy a generic
curl -f / healthcheck: native DSH intentionally returns 401 before authentication.
The proposed acceptance test checks that 401, exchanges the native token privately,
then requires authenticated HTML and a real session-tool assertion.

## Attribution and sources

DeepSeek Harness is MIT licensed, Copyright (c) 2026 DeepSeek. Its notice is included in licenses/deepseek-harness-MIT.txt. Node, Debian, pnpm and dependency licenses remain their own. No DeepSeek endorsement is implied.

- https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2
- https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/bundle/web-app/src/startup.ts
- https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/user/guide/public-deployments.md
- https://github.com/docker-library/official-images/blob/master/library/node

## Manual CI: published baseline and untested extension

.github/workflows/image.yml remains manual-only, with no push/PR/scheduled trigger. Its published hotfix version ran successfully in [run 39484093048](https://github.com/Develata/deepseek-harness-docker/actions/runs/39484093048): AMD64 build, HOME tests, native anonymous/invalid-token rejection, token-to-cookie exchange and authenticated HTML. The successful run published the tested hotfix image and updated latest.

The workflow includes non-root tool checks, genuinely empty bind startup, actual DSH session registration, persistence and an MCP-disabled control, repeated with read-only-rootfs plus tmpfs. The ordinary suite passed in run 39556949149; the hardened run failed and the separate final auth gate was skipped. The hardened native-cache adjustment has not been runtime-tested. All gates must pass on the resulting commit before any toolchain release. No model calls are requested; native credentials/container logs are not printed or uploaded. Only the tested image tar, without runtime data, is retained as an Actions artifact for one day.

The publish input defaults to false. Only an explicit true on the default branch enables the separate packages:write job, using the built-in GITHUB_TOKEN rather than a new credential. It pushes exactly the tested image to ghcr.io/<owner>/<repository>:0.2.1-rc.2-<full-commit-sha>. For Develata/deepseek-harness-docker, the image path is ghcr.io/develata/deepseek-harness-docker. After all smoke tests pass, publish=true also updates latest from that exact tested image and verifies that the fixed tag and latest have identical registry digests. There is no ARM64 claim, automatic deployment or gateway configuration. GitHub Actions/storage quotas and package visibility must be reviewed before running/publishing.

### Historical latest-alias workflow

.github/workflows/alias-latest.yml is a frozen historical, manually triggered
alias operation. It still points to the old digest
sha256:38bce61913392e3eff0cb088b316c41c96733918b3c24f064c0bbb687f5e47e3.
Do not run it to release this toolchain revision: doing so would roll latest
back to that historical image. Use image.yml with publish=true only after
reviewing and authorizing its build/test/publication run.

## Docker Compose templates

The documentation examples below default to ghcr.io/develata/deepseek-harness-docker:latest, which currently contains only the published hotfix, not this toolchain candidate. The separate checked-in compose.yml instead requires an explicit DSH_IMAGE. The latest tag is mutable; set DSH_IMAGE in a local .env to an existing fixed version tag or image digest if you want to pin a version. These templates do not install or configure a gateway, TLS or external login.

### Existing reverse proxy runs on the Docker host

```yaml
services:
  dsh:
    image: ${DSH_IMAGE:-ghcr.io/develata/deepseek-harness-docker:latest}
    init: true
    restart: unless-stopped
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    stop_grace_period: 30s
    ports:
      - "127.0.0.1:3080:3080"
    volumes:
      - ./data:/data
      - ./workspace:/workspace
    command:
      - --public-url
      - https://dsh.example.com/
      - --trusted-host
      - dsh.example.com
```

Your host proxy can reach http://127.0.0.1:3080. Change the advertised URL and trusted host together if you use another domain. The bare trusted host follows upstream documentation and accepts that hostname on any port; do not append :443 blindly because a normal HTTPS browser Host header can omit the port on the plain HTTP backend hop. For local-only use without a proxy, omit command; the default advertised URL is http://127.0.0.1:3080/.

### Existing reverse proxy runs in another container

```yaml
services:
  dsh:
    image: ${DSH_IMAGE:-ghcr.io/develata/deepseek-harness-docker:latest}
    init: true
    restart: unless-stopped
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    stop_grace_period: 30s
    volumes:
      - ./data:/data
      - ./workspace:/workspace
    networks:
      - proxy-network
    command:
      - --public-url
      - https://dsh.example.com/
      - --trusted-host
      - dsh.example.com
networks:
  proxy-network:
    external: true
    name: ${DSH_PROXY_NETWORK:?Set your existing private proxy network}
```

There is deliberately no ports section. Your existing proxy must already join the named private Docker bridge network and use http://dsh:3080 as its upstream. A proxy container's 127.0.0.1 is that proxy container, not DSH or the host. Use a network shared only with trusted containers and avoid a conflicting service name/alias dsh. Keep DSH on one IPv4 bridge network: this image selects its current concrete container IPv4 at every startup, so it does not depend on a fixed address. Model access still needs outbound network connectivity.

### Native DSH behavior and persistent data

Official DSH rejects wildcard bind addresses such as 0.0.0.0. The image binds the current concrete container address; the ports mapping separately controls host publication. Do not set the application to container loopback when another container or Docker port forwarding must reach it.

--public-url advertises the browser-facing address; it does not grant trust or provide authentication. --trusted-host admits the public Host authority. Your proxy must preserve the browser-facing Host and Origin, forward WebSocket upgrades, support streaming, and add Secure to native cookies when terminating HTTPS. Native launch-token/cookie authentication remains enabled; external login does not replace it. Native process-token URLs and logs are sensitive. Model-provider account login or its localhost OAuth callback is a separate concern and is not configured by these templates.

/data persists DSH state/home in ./data; /workspace persists work files in ./workspace. These host directories are relative to the Compose file's directory; create them before startup and make them writable by UID 1000. Data in existing named volumes is not migrated automatically: if you already have data, stop the old container and migrate it before starting with these directories, rather than starting with empty replacements. Back up both directories before upgrades. Start with docker compose up -d only after you have selected the actual published image and configured your own external protection. These examples are documentation, not a deployment performed on your server.
