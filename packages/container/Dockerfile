# Stage 1: Build
FROM --platform=linux/arm64 node:22-slim AS builder

WORKDIR /build

# Copy workspace root files for workspace resolution
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src/ packages/shared/src/
COPY packages/container/package.json packages/container/tsconfig.json packages/container/
COPY packages/container/src/ packages/container/src/

RUN npm pkg delete scripts.prepare && \
    npm ci
RUN npm run build --workspace=packages/shared --workspace=packages/container

# Stage 2: Runtime
FROM --platform=linux/arm64 node:22-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl git && \
    rm -rf /var/lib/apt/lists/*

# Install OpenClaw CLI (version configurable via build arg)
# OpenClaw 2026.4.x loads the Telegram extension on startup and expects grammy
# to be present in the global runtime even when webhook delivery is handled by
# our own Gateway layer.
ARG OPENCLAW_VERSION=2026.2.13
RUN npm install -g openclaw@${OPENCLAW_VERSION} grammy@1.42.0 && \
    npm cache clean --force

# Pre-seed OpenClaw bundled runtime dependencies that otherwise install during
# every on-demand gateway startup. This trades a small image-size increase for a
# shorter and more deterministic Fargate/AgentCore cold start path.
RUN npm install --prefix /usr/local/lib/node_modules/openclaw \
    --omit=dev \
    --no-audit \
    --no-fund \
    @grammyjs/runner@^2.0.3 \
    @grammyjs/transformer-throttler@^1.2.1 \
    typebox@1.1.31 \
    undici@8.1.0 \
    acpx@0.5.3 \
    @homebridge/ciao@^1.3.6 \
    @modelcontextprotocol/sdk@1.29.0 \
    express@^5.2.1 \
    playwright-core@1.59.1 \
    ws@^8.20.0 && \
    npm cache clean --force

# Create non-root user
RUN groupadd -r openclaw && useradd -r -g openclaw -m openclaw

# Pre-generate openclaw config (skip onboard at runtime)
RUN mkdir -p /home/openclaw/.openclaw && \
    echo '{"gateway":{"port":18789,"mode":"local"}}' > /home/openclaw/.openclaw/openclaw.json && \
    chown -R openclaw:openclaw /home/openclaw/.openclaw

WORKDIR /app

# Copy production dependencies with --chown to avoid extra layer
COPY --from=builder --chown=openclaw:openclaw /build/packages/container/dist/ /app/dist/
COPY --from=builder --chown=openclaw:openclaw /build/node_modules/ /app/node_modules/
# Overwrite workspace symlink with real shared package
RUN rm -rf /app/node_modules/@serverless-openclaw/shared
COPY --from=builder --chown=openclaw:openclaw /build/packages/shared/dist/ /app/node_modules/@serverless-openclaw/shared/dist/
COPY --from=builder --chown=openclaw:openclaw /build/packages/shared/package.json /app/node_modules/@serverless-openclaw/shared/
COPY --chown=openclaw:openclaw packages/container/package.json /app/
COPY --chown=openclaw:openclaw packages/container/start-openclaw.sh /app/

RUN sed -i 's/\r$//' /app/start-openclaw.sh && \
    chmod +x /app/start-openclaw.sh && \
    mkdir -p /data/workspace && \
    chown openclaw:openclaw /data/workspace

USER openclaw

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

ENTRYPOINT ["/bin/bash", "/app/start-openclaw.sh"]
