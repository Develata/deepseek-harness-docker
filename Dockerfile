# syntax=docker/dockerfile:1
FROM node:24.22.0-bookworm-slim
# Official application only. No third-party authentication plugins or gateway.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global @deepseek-ai/dsh@0.2.1-rc.2 pnpm@10.14.0 \
 && npm cache clean --force
ENV DSH_HOME=/data/dsh HOME=/data/home
RUN mkdir -p /data/dsh /data/home /workspace \
 && chown -R node:node /data /workspace
COPY --chown=root:root scripts/entrypoint.mjs /opt/dsh-wrapper/entrypoint.mjs
COPY --chown=root:root licenses/ /opt/dsh-wrapper/licenses/
USER node
WORKDIR /workspace
VOLUME ["/data", "/workspace"]
EXPOSE 3080
ENTRYPOINT ["node", "/opt/dsh-wrapper/entrypoint.mjs"]
