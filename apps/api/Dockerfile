FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/utils/package.json packages/utils/package.json
COPY packages/workflows/package.json packages/workflows/package.json
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
COPY . .
COPY --from=deps /app/node_modules ./node_modules
RUN npm run -w @claw/contracts build && npm run -w @claw/utils build && npm run -w @claw/workflows build && npm run -w @claw/api build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/utils/dist ./packages/utils/dist
COPY --from=build /app/packages/utils/package.json ./packages/utils/package.json
COPY --from=deps /app/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
