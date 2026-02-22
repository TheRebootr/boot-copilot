# =============================================================================
# Stage 1: BUILD — install Bun dependencies (no build tools needed for pure JS/TS deps)
# =============================================================================
FROM node:22-bookworm-slim AS builder

# Bun binary from official image (avoids curl install script)
COPY --from=oven/bun:1.3.9 /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# =============================================================================
# Stage 2: RUNTIME — clean image without build tools
# =============================================================================
FROM node:22-bookworm-slim

# Runtime-only packages (no build-essential, no gcc, no make)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    ripgrep \
    fd-find \
    jq \
    tree \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/fdfind /usr/bin/fd

# Bun runtime binary
COPY --from=oven/bun:1.3.9 /usr/local/bin/bun /usr/local/bin/bun

# Claude Code CLI via npm (native installer has segfault/OOM on AMD64 Bookworm in Docker)
RUN npm install -g @anthropic-ai/claude-code@2.1.34

# Non-root user: node user already exists in node: images at UID 1000
# Verify UID matches host user
RUN id node

# App, workspace, and data directories
RUN mkdir -p /app /workspace /data && chown node:node /app /workspace /data

# Baked-in dependencies from builder (no write needed at runtime)
COPY --from=builder --chown=node:node /build/node_modules /app/node_modules

# App source — baked into the image
# To update: edit on host → docker compose build → docker compose up -d
COPY --chown=node:node src/ /app/src/
COPY --chown=node:node ask_user_mcp/ /app/ask_user_mcp/
COPY --chown=node:node package.json tsconfig.json mcp-config.ts /app/

USER node

WORKDIR /app

# Disable Claude Code auto-updater (managed via image rebuilds)
ENV DISABLE_AUTOUPDATER=1

# Entrypoint: TypeScript bot via Bun
CMD ["bun", "run", "src/index.ts"]
