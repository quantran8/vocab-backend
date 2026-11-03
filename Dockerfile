# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
WORKDIR /app

# --ignore-scripts: allowBuilds only lists darwin binaries, and nothing the build or runtime needs has a postinstall.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm run build && test -f dist/main.js && test -f dist/db/migrate.js

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Read by dist/db/migrate.js.
COPY drizzle ./drizzle

# Last, after every COPY: these change on every build and would invalidate the layer cache above them.
ARG APP_VERSION=dev
ARG APP_COMMIT=unknown
ARG APP_BUILT_AT
ENV APP_VERSION=$APP_VERSION
ENV APP_COMMIT=$APP_COMMIT
ENV APP_BUILT_AT=$APP_BUILT_AT
LABEL org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.revision=$APP_COMMIT \
      org.opencontainers.image.created=$APP_BUILT_AT \
      org.opencontainers.image.title=vocab-backend

USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
