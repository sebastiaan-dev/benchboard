# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv
# (BENCHBOARD_AUTH selects the authentication mode; it is not a secret.)
# Benchboard server image: one standalone executable (CLI + server + web app, from
# `bun build --compile`) on distroless. No shell, package manager or runtime besides glibc.
# Data lives in the /data volume.
ARG BUN_VERSION=1.4.2

# Builds on the build machine's own platform and cross-compiles for the target, so multi-arch
# images need no emulation.
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY packages/cli/package.json packages/cli/
COPY packages/core/package.json packages/core/
COPY packages/graphql/package.json packages/graphql/
RUN bun install --frozen-lockfile
COPY . .
ARG TARGETARCH
ARG BENCHBOARD_VERSION=
RUN bun run --filter @benchboard/web build \
	&& case "$TARGETARCH" in \
		amd64) target=bun-linux-x64-baseline ;; \
		arm64) target=bun-linux-arm64 ;; \
		*) echo "unsupported architecture $TARGETARCH" >&2; exit 1 ;; \
	esac \
	&& BENCHBOARD_VERSION="$BENCHBOARD_VERSION" bun scripts/build-binaries.ts --target "$target" --out /out \
	&& mv "/out/benchboard-${target#bun-}" /out/benchboard \
	&& mkdir -p /rootfs/data /rootfs/backups && chmod 0700 /rootfs/data /rootfs/backups

# The binary needs only glibc (Bun links libc, libm, libdl and libpthread, and carries its own TLS and
# CA roots): base-nossl has glibc, CA certificates and tzdata, and nothing else. For a shell while
# debugging, use the :debug-nonroot tag of the same image.
FROM gcr.io/distroless/base-nossl-debian12:nonroot AS runtime
COPY --from=build /out/benchboard /usr/local/bin/benchboard
# uid 1000 owns the data, as in earlier images, so existing volumes keep working.
COPY --from=build --chown=1000:1000 /rootfs/ /
USER 1000:1000
ENV BENCHBOARD_HOME=/data \
	BENCHBOARD_HOST=0.0.0.0 \
	BENCHBOARD_PORT=4319 \
	BENCHBOARD_AUTH=token \
	HOME=/data
VOLUME ["/data"]
EXPOSE 4319
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["/usr/local/bin/benchboard", "healthcheck"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/benchboard"]
CMD ["serve"]
