# DeepSeek Harness Docker image packaging

Unofficial packaging of the unmodified official DeepSeek Harness Web UI. No authentication plugin, Nginx, Caddy, external login configuration, or credentials are included. Native DSH launch-token/cookie authentication remains enabled.

Status: files prepared; image NOT built or run. This environment has no Docker/Podman executable or Docker socket. Only JavaScript syntax and own-file static checks have passed. No registry image, public repository or deployment exists from this work.

## Fixed application version

- @deepseek-ai/dsh@0.2.1-rc.2, official release tag dsh-v0.2.1-rc.2, verified source commit 687f282e8625c6b8d11ff58211a90524be2e4317.
- node:24.22.0-bookworm-slim is listed in Docker's official Node image catalog.
- pnpm@10.14.0 is included for DSH's native profile/plugin management, not for adding any community plugin.

Top-level versions are fixed; the base image tag, Debian packages and npm transitive dependencies are not digest/lockfile-frozen. This is not a byte-reproducible or security-audited release.

## Build

On a machine with Docker:

    docker build -t deepseek-harness:0.2.1-rc.2 .

This downloads and installs the official package and its dependencies. No build was performed when preparing these files.

## Run locally with persistent data

    docker run -d --name deepseek-harness \
      --init --restart unless-stopped \
      --cap-drop ALL --security-opt no-new-privileges \
      -p 127.0.0.1:3080:3080 \
      --mount type=volume,source=dsh-data,target=/data \
      --mount type=volume,source=dsh-workspace,target=/workspace \
      deepseek-harness:0.2.1-rc.2

Only the Docker host's loopback port is published. EXPOSE does not publish a port by itself. Do not change this to a public 0.0.0.0 binding without your own protection. Host administrators and other explicitly attached containers are trusted; this wrapper does not isolate hostile local users.

The upstream application disallows wildcard binds. The entrypoint selects the container's sole non-loopback IPv4 address and refuses ambiguous multi-network configurations. The default advertised URL is http://127.0.0.1:3080/ for local use. Additional arguments are passed to the official DSH Web CLI; any external URL, trusted-host, TLS or gateway configuration is left to the operator.

Inspect startup locally:

    docker logs deepseek-harness

DSH prints its native authenticated launch URL. That URL contains a bearer credential: open it only on your own Docker host/browser or authorized local tunnel, and do not share logs publicly. A new process can issue a new launch credential. No external username/password is created by this image. Model credentials are also left to the operator.

## Data and shutdown

/data/dsh stores DSH profiles/application data; /data/home stores the process home; /workspace stores work files. The process uses the unprivileged node user (UID 1000). Named volumes inherit the image's directory ownership on first creation; existing bind mounts require suitable ownership and permissions.

Stop before making a consistent encrypted backup of both volumes. Do not delete volumes casually. No automatic upgrade or migration is provided. Test newer versions with backup copies before switching an existing instance.

Docker --init reaps descendants. The wrapper forwards termination and gives DSH up to 20 seconds before a forced stop; use a container stop timeout above 20 seconds, for example:

    docker stop --time 30 deepseek-harness

## Checks still required

Before relying on the image: build on the target architecture, verify npm install/native modules, start the native Web UI, open the authenticated launch URL, verify conversation/workspace persistence across restart, verify loopback-only publication, and test graceful stop. Test the intended shell/sandbox features under the chosen container restrictions; do not assume Docker or DSH guarantees isolation. No model call or real credential is needed for initial startup checks.

For a distributable release, resolve the base digest, lock dependency integrity, inspect package provenance, scan the image and include the full dependency license inventory. Publication and image-registry push are not part of this draft.

## Attribution and sources

DeepSeek Harness is MIT licensed, Copyright (c) 2026 DeepSeek. Its notice is included in licenses/deepseek-harness-MIT.txt. Node, Debian, pnpm and dependency licenses remain their own. No DeepSeek endorsement is implied.

- https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2
- https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/bundle/web-app/src/startup.ts
- https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/user/guide/public-deployments.md
- https://github.com/docker-library/official-images/blob/master/library/node

## Proposed manual CI (not executed)

.github/workflows/image.yml is a proposal requiring repository-publication and workflow-run approval. It has no push/PR/scheduled trigger. A manual run builds linux/amd64, starts a disposable native Web UI, checks anonymous and invalid-token rejection plus native token-to-cookie exchange and authenticated HTML, then removes its runtime volumes. It makes no model calls and never prints or uploads native credentials/container logs. The image tar is retained as an Actions artifact for one day, without runtime data. This workflow and smoke script have not run.

The publish input defaults to false. Only an explicit true on the default branch enables the separate packages:write job, using the built-in GITHUB_TOKEN rather than a new credential. It pushes exactly the tested image to ghcr.io/<owner>/<repository>:0.2.1-rc.2-<full-commit-sha>. If the proposed repository is Develata/deepseek-harness-docker, the image path becomes ghcr.io/develata/deepseek-harness-docker. There is no latest tag, ARM64 claim, automatic deployment or gateway configuration. GitHub Actions/storage quotas and package visibility must be reviewed before running/publishing.
