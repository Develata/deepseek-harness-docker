# Deployment diagnostics and session-integration candidate

Historical preparation record. The pre-release status statements below describe
the earlier draft, not the current release. Commit
`6c7c7001adc88c9b38cd73263729e805a49e6bda` passed ordinary and hardened AMD64
toolchain/session tests, native authentication and publication in [run 39561266153](https://github.com/Develata/deepseek-harness-docker/actions/runs/39561266153)
on 2026-10-21. No new development-mode runtime test or deployment is claimed;
see [DEVELOPMENT-MODES.md](DEVELOPMENT-MODES.md) for the new candidate.

Rebased 2026-10-20 onto published commit `86ee9bdbdb2222edec33f06da01eadbe74bd6279`.
The private increment remains uncommitted, unpublished and untested in a container.
AMD64 only; no ARM work was added. The original toolchain draft is preserved.

## Published baseline versus this private increment

The HOME hotfix was built and published successfully in [run 39484093048](https://github.com/Develata/deepseek-harness-docker/actions/runs/39484093048),
including four HOME regression tests and native HTTP authentication smoke. Both
its fixed commit tag and latest resolve to `sha256:ded6dd3af1ea6d77706f48a21175051604766b0be4b33ee4ee4cc24bdbca40bd`.
That success applies ONLY to the hotfix image, not this candidate's Node26,
Rust/Bun/CodeGraph toolchain, actual-session acceptance test or hardened mode.
The separate approved hotfix/publication record is preserved unchanged.

## What changes

1. Preserve the published HOME/DSH_HOME initialization helper and its four tests
   byte-for-byte. The fix is already in the base and is not reintroduced by this
   incremental patch. Existing owner/mode/config contents remain untouched.
2. Validate the wrapper's obvious startup inputs without printing their values:
   MCP 0/1, integer port, public HTTP(S) URL, concrete local host, paired TLS flags.
   Unknown flags still pass to upstream. Default interface selection still fails
   closed on ambiguity; an explicit valid local --host can disambiguate.
3. Probe actual create/write/rename/unlink on home, data, Cargo/Bun/cache, cwd and
   tmp directories. Report the affected setting instead of a late ENOENT/EACCES.
   No root initialization, chmod/chown, credential reads or configuration repair.
4. Supply an opt-in offline self-check of installed tool versions/resolution and
   image-tool immutability under the runtime UID. It starts no DSH/model/build.
5. Supply separate Compose files: unchanged-security baseline and an explicit
   read-only-rootfs + /tmp tmpfs override. Bind sources must already exist;
   Compose will not silently create root-owned host directories. Require a chosen
   image of this revision, not the old mutable latest.
6. Strengthen acceptance tests from standalone MCP discovery to real DSH Web
   session registration, persistence, native HTTP auth and a disabled control.
7. Tighten .dockerignore to include only runtime/build scripts, excluding test
   instrumentation and synthetic fixtures. The old !scripts/ already included
   children under Docker's parent-negation semantics: this is NOT a COPY-blocker
   fix. An early contrary diagnosis was corrected before this review.

Relative to the earlier private toolchain draft, no versions, artifact URLs,
hashes, integrity checks, Rust installation strategy or production CodeGraph
overlay were changed. Relative to the published hotfix, the toolchain additions
are new and still require runtime validation. Node Current, Rust, Bun-global
CodeGraph and Python-venv remain the earlier draft. DSH's native authentication,
CLI TLS/trusted-host policy and agent permissions remain upstream-owned. No Caddy,
external login, root ownership repair, broad environment forwarding, telemetry
change, registry credential, auto-upgrade or automated project initialization was
added. Default cap_drop ALL/no-new-privileges/UID1000 remain unchanged. The wrapper
now explicitly rejects root execution; no extra capabilities are requested.

## Actual-session acceptance, not a standalone handshake claim

The test-only Cordis observer is mounted read-only into a disposable container;
it is excluded from the production build context and image. It does not replace
the image's CodeGraph MCP overlay. It waits for ctx.loader.await() outside its own
apply promise (avoiding a loader self-deadlock), then:

- Calls the real Web SessionController.create with a fixed synthetic session ID.
  This uses the ordinary default-preset composition rather than a fabricated tool
  registry or a direct CodeGraph subprocess as the integration assertion.
- Resolves the actual registered agent and session and requires idle state/cwd.
- Requires exactly one mcp__codegraph__codegraph_explore in ctx.tools.schemas(agent),
  with no raw unqualified tool name. This is the particular session's visible
  registry, not just the global catalog or a healthy MCP server.
- Renames the first synthetic session through the controller, flushes through the
  real session durability hook, gracefully stops the container, and restores the
  same session ID in a new container. Cycle two must read the persisted title;
  it cannot recreate that title and still pass.
- Runs a separate DSH_CODEGRAPH_MCP=0 case whose actual session must have no
  mcp__codegraph__ namespace. Missing/duplicate/disabled mismatches fail closed.

An independent native HTTP probe requires anonymous/invalid-token/API rejection,
private token-to-cookie exchange, and authenticated HTML before accepting backend
readiness. Merely seeing the logged URL is no longer enough. Native token and
cookie bytes stay in captured memory/stdin, never argv or printed diagnostics.

Runtime tests use a uniquely named Docker internal bridge: DSH gets its required
concrete IPv4, but no internet egress or published port. Tool checks use network
none. No model/provider credentials are forwarded and no prompt, tool execution,
LLM generation, automatic indexing or external authentication is requested. The
separate original native-auth smoke remains unchanged and checks loopback host
publication. The integration observer checks the Web service in-process; it does
NOT claim to test the browser's WebSocket session-creation transport or a model
actually invoking CodeGraph. Those are distinct later acceptance goals.

## Persistence and writable-state tests

Before any fixture seeding, boot the actual entrypoint with an entirely empty
/data bind and require HOME/DSH_HOME to appear. Repeat in the hardened mode.
Then exercise two recreated containers over the same synthetic /data + /workspace.
Check retained user Cargo executable, Python venv config, workspace marker and
Cargo/Bun/sccache cache-directory markers BEFORE any second-cycle code recreates
them. This closes the previous false-positive where a missing marker was silently
regenerated. Markers demonstrate directory persistence, not real cache hit rates;
the Rust compile and sccache invocation remain separate functional checks.

Hash the synthetic global patch, actual Web profile patch/package manifest, and
Cargo config before/after runs. Read these hashes through UID1000 containers, not
the CI runner's potentially different UID: mode-0700 homes are not made public
just so CI can inspect them. Only synthetic fixture root directories are 0777;
that is explicitly not the operator configuration. Fixtures are retained and only
uniquely named test containers/networks are removed. Real user paths are not
accepted by the smoke harness. No runtime data is uploaded.

## Optional hardened Compose assessment

The override adds only read_only: true and
/tmp:rw,nosuid,nodev,size=512m,mode=1777. HOME, Cargo/Bun caches, user tool installs,
DSH state, projects, venvs and CodeGraph indexes remain on writable persistent
mounts; image-owned /opt toolchains remain immutable. No noexec is proposed,
because compiler/build tools may execute temporary artifacts. /tmp is transient,
limited memory, not persistent storage or a replacement for /data.

This looks compatible with the intended write paths from source review, but is
NOT runtime-validated. CI now proposes running the entire toolchain/session suite
both normally and with --read-only/--tmpfs. Heavy jobs, existing CodeGraph indexes,
shared daemons, multi-project sessions, shell/sandbox features, CPU requirements,
network filesystems and upgrades remain unverified. Do not enable this profile
in production solely on the strength of unit tests.

Unlike the 1Panel example, native DSH auth is never bypassed, no root chown stage
is copied, and Caddy/external credentials are not introduced. A generic curl -f /
healthcheck is wrong for native DSH because unauthenticated access should be 401.

## Exact local checks and limitations

Run from the candidate directory unless otherwise specified:

- node --test tests/prepare-homes.test.mjs tests/runtime-checks.test.mjs
  tests/dsh-session-smoke.test.mjs: 21/21 passed on host Node v24.19.0.
  The 5 session-observer cases use fake services to test the oracle; they are NOT
  DSH integration results. Other cases cover arguments, missing homes, UID/modes,
  preservation, bad paths and executable lookup.
- python3 -B -m unittest discover -s tests -p 'test_*.py': 6/6 static-contract tests
  passed on Python 3.12. These check local COPY inclusion, test/data exclusion,
  profile separation, lock formatting, Python AST, manual CI and test wiring.
- node --check for every scripts/*.mjs and tests/*.mjs: passed.
- Python AST parse for all own .py files: passed; installer main never executed.
- PyYAML parsed both Compose files, workflow and test observer patch. The production
  CodeGraph !!js overlay is unchanged; ordinary safe YAML parsers cannot execute
  its Cordis expressions and no claim is made that they validate those expressions.
- bash -n on the extracted publication shell step: passed. No shell publication
  commands were executed.
- The original public files were verified by Git blob SHA. The published hotfix
  base reconstructs Git tree 2d5250974a80934169925ee0d8d372fd5c3d02be, exactly the
  tree published in commit 86ee9bd. There is no repository AGENTS.md.
- The final incremental patch passes git apply --check on that published base;
  patched files compare byte-for-byte with this rebased candidate. The published
  helper, its tests, native-auth smoke, alias-latest workflow and publish job are
  unchanged. The original approved hotfix record remains untouched.
- Installer, lockfile and production CodeGraph overlay compare byte-for-byte with
  the original private toolchain draft.
- Docker ignore semantics were read in Moby's official patternmatcher source.
  An optional matcher execution could not run: this host's /usr/bin/go does not
  provide the Go compiler/test tool (reported "Go: Unknown option: test"). No Go
  toolchain was installed. The repository's Python test covers these fixed simple
  patterns, not the full Docker ignore language.

Docker/Podman are not installed here, and no image build or runtime test was
requested for this private preparation. For this candidate, no Compose config command, npm/Bun/Rust installation,
DSH launch, native module load, real MCP handshake, real DSH session, registry
push or deployment was run. The separately approved hotfix CI/publication above
does not cover these added features. Node26 compatibility, Dockerfile execution,
read-only-rootfs compatibility and upstream lifecycle assumptions remain for
explicitly authorized CI. Fake/unit/static success must not be reported as a
working or published image.

## Proposed commit text (increment on the published hotfix)

feat: add pinned DSH toolchains and session-aware runtime checks

Add the pinned Node Current, Rust, Bun-global CodeGraph and Python venv toolchain.
Validate wrapper inputs and persistent write paths without modifying existing
configuration or permissions. Add opt-in non-root tool diagnostics and a separate
read-only-rootfs Compose override while retaining native authentication.

Exercise real Web-session CodeGraph registration, a disabled negative control,
empty bind startup and same-session persistence in disposable AMD64 CI fixtures.
Keep runtime validation manual and publication gated on the tested image.

## Pinned primary references

- Wrapper base: https://github.com/Develata/deepseek-harness-docker/tree/86ee9bdbdb2222edec33f06da01eadbe74bd6279
- 1Panel Compose: https://github.com/1Panel-dev/appstore/blob/16e3972e248fe6b3a15ebefadbb140ed5999f795/apps/deepseek-harness/0.2.1-rc.2/docker-compose.yml
- 1Panel runtime reference: https://github.com/1Panel-dev/runtime/tree/193541c3f7c0109aafe361c217ef7c978927546e/deepseek-harness
- DSH startup lifecycle: https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/web-app/src/index.ts
- Web session creation: https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/commands.ts
- Agent composition: https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/agent.ts
- Session-scoped tools: https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts
- Session durability: https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/index.ts
- MCP namespace/lifecycle: https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/mcp/mcp-client/src/index.ts
- Native auth: https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/connection/src/browser-auth.ts
