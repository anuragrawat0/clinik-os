FROM node:22-bookworm-slim AS base

ARG PNPM_VERSION=10.34.9
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile

FROM base AS api
ENV SERVICE_NAME=api
RUN pnpm --filter @clinik/shared build && pnpm --filter @clinik/api build
WORKDIR /repo/apps/api
CMD ["pnpm", "start:prod"]

FROM base AS web
ENV API_INTERNAL_ORIGIN=http://api:3001
RUN pnpm --filter @clinik/shared build \
  && pnpm --filter @clinik/api build \
  && pnpm api:client \
  && pnpm --filter @clinik/web build
WORKDIR /repo/apps/web
CMD ["pnpm", "start"]
