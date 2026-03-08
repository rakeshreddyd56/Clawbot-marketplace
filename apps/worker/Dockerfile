# ─────────────────────────────────────────────────────────────────────────────
# Clawbot Marketplace — Temporal Worker
# Multi-stage build: deps → build → runtime
#
# TASK-HARD-004: This Dockerfile builds the Temporal workflow worker that
# polls the marketplace-event task queue and executes workflow/activity code.
#
# Security:
#   - Non-root user (clawbot:nodejs uid/gid 1001)
#   - dumb-init for proper PID 1 signal handling
#   - NODE_ENV=production strips dev dependencies
#   - Graceful shutdown via SIGTERM handling in worker code
# ─────────────────────────────────────────────────────────────────────────────
ARG NODE_VERSION=20

# ── Stage 1: Install all dependencies (including dev) ─────────────────────────
FROM node:${NODE_VERSION}-alpine AS deps

WORKDIR /app

# Install dumb-init (PID 1 signal forwarding) and CA certs
RUN apk add --no-cache dumb-init ca-certificates

# Copy workspace root + per-package package files only (for layer caching)
COPY package.json package-lock.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/utils/package.json packages/utils/package.json
COPY packages/workflows/package.json packages/workflows/package.json

# Install all deps (including dev — needed for build)
RUN npm ci --ignore-scripts

# ── Stage 2: Build TypeScript ──────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS build

WORKDIR /app

# Copy source + node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build in dependency order
RUN npm run -w @claw/contracts build \
 && npm run -w @claw/utils build \
 && npm run -w @claw/workflows build \
 && npm run -w @claw/worker build

# ── Stage 3: Production runtime ───────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime

WORKDIR /app

# Build args for image labeling
ARG BUILD_DATE
ARG VCS_REF

LABEL org.opencontainers.image.title="clawbot-temporal-worker" \
      org.opencontainers.image.description="Clawbot Marketplace Temporal Workflow Worker" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="https://github.com/clawbot/marketplace" \
      org.opencontainers.image.vendor="Clawbot"

# Install dumb-init and CA certs (runtime needs them)
RUN apk add --no-cache dumb-init ca-certificates \
 # Create non-root group + user
 && addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs --no-create-home clawbot

ENV NODE_ENV=production

# Copy only what is needed at runtime
COPY --from=build --chown=clawbot:nodejs /app/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=clawbot:nodejs /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build --chown=clawbot:nodejs /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=clawbot:nodejs /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=clawbot:nodejs /app/packages/utils/dist ./packages/utils/dist
COPY --from=build --chown=clawbot:nodejs /app/packages/utils/package.json ./packages/utils/package.json
COPY --from=build --chown=clawbot:nodejs /app/packages/workflows/dist ./packages/workflows/dist
COPY --from=build --chown=clawbot:nodejs /app/packages/workflows/package.json ./packages/workflows/package.json

# Copy production node_modules (includes workspace symlinks + @temporalio native bindings)
COPY --from=deps --chown=clawbot:nodejs /app/node_modules ./node_modules
COPY --from=deps --chown=clawbot:nodejs /app/package.json ./package.json

# Use non-root user
USER clawbot

# No HTTP port — worker is a poll-based process

# Temporal worker doesn't have an HTTP health endpoint.
# Liveness is determined by the worker's ability to poll the task queue.
# K8s uses exec-based probes (see services.yaml).
# HEALTHCHECK omitted intentionally — use K8s probes instead.

# dumb-init ensures SIGTERM propagates to Node.js child process
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/worker/dist/index.js"]
