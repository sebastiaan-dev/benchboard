# syntax=docker/dockerfile:1
# Benchboard server image: the CLI's `serve` with the built web app. Data lives in the /data volume.
ARG BUN_VERSION=1.4.2

FROM oven/bun:${BUN_VERSION} AS manifests
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY packages/cli/package.json packages/cli/
COPY packages/core/package.json packages/core/
COPY packages/graphql/package.json packages/graphql/

# Build the web app (needs every dev dependency).
FROM manifests AS build
RUN bun install --frozen-lockfile
COPY . .
RUN bun run --filter @benchboard/web build

# Runtime dependencies of the server only.
FROM manifests AS deps
RUN bun install --frozen-lockfile --production --filter @benchboard/cli

FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app
COPY --from=deps /app ./
COPY packages ./packages
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN printf '#!/bin/sh\nexec bun /app/packages/cli/bin/benchboard.ts "$@"\n' > /usr/local/bin/benchboard \
	&& chmod 0755 /usr/local/bin/benchboard \
	&& mkdir -p /data /backups && chown bun:bun /data /backups && chmod 0700 /data /backups
USER bun
ENV NODE_ENV=production \
	BENCHBOARD_HOME=/data \
	BENCHBOARD_HOST=0.0.0.0 \
	BENCHBOARD_PORT=4319 \
	BENCHBOARD_AUTH=token
VOLUME ["/data"]
EXPOSE 4319
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["benchboard", "healthcheck"]
STOPSIGNAL SIGTERM
CMD ["benchboard", "serve"]
