# syntax=docker/dockerfile:1
# Latest Current, not LTS, verified 2026-10-20. DSH runtime still requires CI validation.
ARG NODE_IMAGE=node:26.12.0-bookworm-slim
FROM ${NODE_IMAGE} AS toolchains
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 make g++ pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/*
COPY scripts/install-toolchains.py scripts/toolchains.lock.json /opt/dsh-build/
RUN python3 /opt/dsh-build/install-toolchains.py "${TARGETARCH}"

FROM ${NODE_IMAGE}
# Official DSH application with local development tools; no authentication gateway.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git python3 python3-venv make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global @deepseek-ai/dsh@0.2.1-rc.2 pnpm@10.14.0 \
 && npm cache clean --force
COPY --from=toolchains /opt/toolchain-bin/ /opt/toolchain-bin/
COPY --from=toolchains /opt/rust-cargo/ /opt/rust-cargo/
COPY --from=toolchains /opt/rustup/ /opt/rustup/
COPY --from=toolchains /opt/bun-global/ /opt/bun-global/
COPY --from=toolchains /opt/bun-global-bin/ /opt/bun-global-bin/
ENV DSH_HOME=/data/dsh HOME=/data/home \
    CARGO_HOME=/data/home/.cargo RUSTUP_HOME=/opt/rustup \
    BUN_INSTALL=/data/home/.bun BUN_INSTALL_CACHE_DIR=/data/home/.cache/bun \
    SCCACHE_DIR=/data/home/.cache/sccache SCCACHE_CACHE_SIZE=2G \
    BINSTALL_DISABLE_TELEMETRY=true CODEGRAPH_TELEMETRY=0 CODEGRAPH_NO_DOWNLOAD=1 \
    PATH=/opt/bun-global-bin:/opt/toolchain-bin:/opt/rust-cargo/bin:/data/home/.cargo/bin:/data/home/.bun/bin:${PATH}
RUN mkdir -p /data/dsh /data/home /workspace \
 && chown -R node:node /data /workspace
COPY --chown=root:root scripts/entrypoint.mjs scripts/prepare-homes.mjs scripts/runtime-checks.mjs scripts/self-check.mjs /opt/dsh-wrapper/
COPY --chown=root:root scripts/codegraph.cordis.yml /opt/dsh-wrapper/codegraph.cordis.yml
COPY --chown=root:root scripts/toolchains.lock.json /opt/dsh-wrapper/toolchains.lock.json
COPY --chown=root:root licenses/ /opt/dsh-wrapper/licenses/
USER node
WORKDIR /workspace
VOLUME ["/data", "/workspace"]
EXPOSE 3080
ENTRYPOINT ["node", "/opt/dsh-wrapper/entrypoint.mjs"]
