# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS base

ARG PNPM_VERSION=10.34.9
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /repo

FROM base AS dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN --mount=type=cache,id=clinik-pnpm-store,target=/pnpm/store \
  pnpm install --store-dir=/pnpm/store --frozen-lockfile

FROM dependencies AS build

COPY . .

RUN pnpm --filter @clinik/shared build \
  && pnpm --filter @clinik/api build \
  && pnpm --filter @clinik/api --prod deploy --legacy /out/api

FROM build AS web-build

ARG API_INTERNAL_ORIGIN=http://api:3001
ENV API_INTERNAL_ORIGIN=${API_INTERNAL_ORIGIN}

RUN pnpm api:client \
  && pnpm --filter @clinik/web build \
  && pnpm --filter @clinik/web --prod deploy --legacy /out/web

FROM node:22-bookworm-slim AS api

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/api/ ./
USER node
CMD ["node", "dist/main.js"]

FROM node:22-bookworm-slim AS web

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=web-build --chown=node:node /out/web/ ./
USER node
CMD ["node", "dist-server/server.js"]
