# ─────────────────────────────────────────────────────────────────────────────
# Clawbot Marketplace — Next.js Web Console
# Multi-stage build: deps → build → runtime
#
# Security:
#   - Non-root user (clawbot:nodejs uid/gid 1001)
#   - dumb-init for proper PID 1 signal handling
#   - NODE_ENV=production
#   - HEALTHCHECK via HTTP GET /
#
# Note: Next.js writes to .next/cache at runtime — mount an emptyDir
# volume at /app/apps/web/.next/cache in Kubernetes (see services.yaml).
# ─────────────────────────────────────────────────────────────────────────────
ARG NODE_VERSION=20

# ── Stage 1: Install all dependencies ─────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS deps

WORKDIR /app

# Install dumb-init and CA certs
RUN apk add --no-cache dumb-init ca-certificates

# Copy workspace root + per-package package files for cache efficiency
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/utils/package.json packages/utils/package.json
COPY packages/workflows/package.json packages/workflows/package.json

RUN npm ci --ignore-scripts

# ── Stage 2: Build ────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build upstream packages first (web may import types from contracts/utils)
RUN npm run -w @claw/contracts build \
 && npm run -w @claw/utils build \
 && npm run -w @claw/workflows build \
 && npm run -w @claw/web build

# ── Stage 3: Production runtime ───────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime

WORKDIR /app

ARG BUILD_DATE
ARG VCS_REF

LABEL org.opencontainers.image.title="clawbot-web-console" \
      org.opencontainers.image.description="Clawbot Marketplace Web Console (Next.js 15)" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="https://github.com/clawbot/marketplace" \
      org.opencontainers.image.vendor="Clawbot"

RUN apk add --no-cache dumb-init ca-certificates \
 && addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs --no-create-home clawbot

ENV NODE_ENV=production
ENV PORT=3001
# Disable Next.js telemetry
ENV NEXT_TELEMETRY_DISABLED=1

# Copy Next.js build output
COPY --from=build --chown=clawbot:nodejs /app/apps/web/.next ./apps/web/.next
COPY --from=build --chown=clawbot:nodejs /app/apps/web/public ./apps/web/public
COPY --from=build --chown=clawbot:nodejs /app/apps/web/package.json ./apps/web/package.json

# next.config.mjs is needed by next start
COPY --from=build --chown=clawbot:nodejs /app/apps/web/next.config.mjs ./apps/web/next.config.mjs

# Root package.json (workspace resolution)
COPY --from=deps --chown=clawbot:nodejs /app/package.json ./package.json

# Production node_modules
COPY --from=deps --chown=clawbot:nodejs /app/node_modules ./node_modules

# Create .next/cache directory writable by clawbot user
# In K8s, this will be overridden by an emptyDir volume mount.
RUN mkdir -p /app/apps/web/.next/cache \
 && chown -R clawbot:nodejs /app/apps/web/.next/cache

USER clawbot

EXPOSE 3001

# Health check — Next.js responds on / or /api/health
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "\
    require('http').get('http://localhost:3001/', (r) => {\
      process.exit(r.statusCode < 500 ? 0 : 1);\
    }).on('error', () => process.exit(1));"

ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "run", "-w", "@claw/web", "start", "--", "-p", "3001"]
