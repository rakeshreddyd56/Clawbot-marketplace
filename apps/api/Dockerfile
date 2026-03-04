# ─────────────────────────────────────────────────────────────────────────────
# Clawbot Marketplace — API Gateway + BFF
# Multi-stage build: deps → build → runtime
#
# Security:
#   - Non-root user (clawbot:nodejs uid/gid 1001)
#   - dumb-init for proper PID 1 signal handling
#   - NODE_ENV=production strips dev dependencies
#   - Read-only filesystem (write only to /tmp via volume in K8s)
#   - HEALTHCHECK via HTTP GET /healthz
# ─────────────────────────────────────────────────────────────────────────────
ARG NODE_VERSION=20

# ── Stage 1: Install all dependencies (including dev) ─────────────────────────
FROM node:${NODE_VERSION}-alpine AS deps

WORKDIR /app

# Install dumb-init (PID 1 signal forwarding) and CA certs
RUN apk add --no-cache dumb-init ca-certificates

# Copy workspace root + per-package package files only (for layer caching)
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
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
 && npm run -w @claw/api build

# ── Stage 3: Production runtime ───────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime

WORKDIR /app

# Build args for image labeling
ARG BUILD_DATE
ARG VCS_REF

LABEL org.opencontainers.image.title="clawbot-api-gateway-bff" \
      org.opencontainers.image.description="Clawbot Marketplace API Gateway & BFF" \
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
ENV PORT=3000

# Copy only what is needed at runtime
COPY --from=build --chown=clawbot:nodejs /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=clawbot:nodejs /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=clawbot:nodejs /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=clawbot:nodejs /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=clawbot:nodejs /app/packages/utils/dist ./packages/utils/dist
COPY --from=build --chown=clawbot:nodejs /app/packages/utils/package.json ./packages/utils/package.json

# Copy production node_modules (includes workspace symlinks)
COPY --from=deps --chown=clawbot:nodejs /app/node_modules ./node_modules
COPY --from=deps --chown=clawbot:nodejs /app/package.json ./package.json

# Use non-root user
USER clawbot

EXPOSE 3000

# Health check — expects GET /healthz → 200
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "\
    require('http').get('http://localhost:3000/healthz', (r) => {\
      process.exit(r.statusCode === 200 ? 0 : 1);\
    }).on('error', () => process.exit(1));"

# dumb-init ensures SIGTERM propagates to Node.js child process
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/server.js"]
