#!/bin/sh
# Prepares a Linux host (EC2 or any VM) to run benchmarks and record CPU profiles for Benchboard:
# hyperfine, samply, Bun and the benchboard CLI, perf access for samply, and libc debug symbols.
#
#   curl -fsSL https://raw.githubusercontent.com/sebastiaan-dev/benchboard/main/deploy/linux-runner-setup.sh | sudo sh
#
# Supports apt (Debian, Ubuntu) and dnf (Amazon Linux 2023, Fedora, RHEL) on x86_64 and aarch64.
# Environment:
#   SAMPLY_VERSION, HYPERFINE_VERSION, BUN_VERSION   pinned tool versions
#   BENCHBOARD_REPO, BENCHBOARD_REF                  where the CLI comes from (default: GitHub, main)
#   BENCHBOARD_SOURCE                                use a local checkout instead of cloning
#   PERF_PARANOID                                    kernel.perf_event_paranoid to set (default 1; "keep" to leave it)
#   KERNEL_SYMBOLS=1                                 also set kernel.kptr_restrict=0 (names kernel frames)
set -eu

SAMPLY_VERSION=${SAMPLY_VERSION:-0.13.1}
HYPERFINE_VERSION=${HYPERFINE_VERSION:-2.0.0}
BUN_VERSION=${BUN_VERSION:-1.4.2}
BENCHBOARD_REPO=${BENCHBOARD_REPO:-https://github.com/sebastiaan-dev/benchboard.git}
BENCHBOARD_REF=${BENCHBOARD_REF:-main}
PERF_PARANOID=${PERF_PARANOID:-1}
PREFIX=/usr/local

log() { printf '\033[1m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }

case "$(uname -m)" in
	x86_64|amd64) arch=x86_64 ;;
	aarch64|arm64) arch=aarch64 ;;
	*) echo "Unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

if command -v apt-get >/dev/null 2>&1; then
	log "Installing packages (apt)"
	export DEBIAN_FRONTEND=noninteractive
	apt-get update -qq
	apt-get install -y -qq curl ca-certificates git xz-utils unzip tar gzip >/dev/null
	# Symbols for libc frames (otherwise samply shows them as fun_<address>).
	apt-get install -y -qq libc6-dbg >/dev/null 2>&1 || log "libc6-dbg unavailable; libc frames stay unnamed"
elif command -v dnf >/dev/null 2>&1; then
	log "Installing packages (dnf)"
	# curl-minimal (Amazon Linux) already provides curl; installing curl would conflict.
	command -v curl >/dev/null 2>&1 || dnf install -y -q curl
	dnf install -y -q ca-certificates git xz unzip tar gzip
	dnf install -y -q dnf-plugins-core >/dev/null 2>&1 || true
	dnf debuginfo-install -y -q glibc >/dev/null 2>&1 || log "glibc debuginfo unavailable; libc frames stay unnamed"
else
	echo "Neither apt-get nor dnf found; install curl, git, xz, unzip and tar yourself, then rerun." >&2
	exit 1
fi

download() { curl -fsSL --retry 3 "$1"; }

log "samply $SAMPLY_VERSION"
download "https://github.com/mstange/samply/releases/download/samply-v$SAMPLY_VERSION/samply-$arch-unknown-linux-gnu.tar.xz" \
	| tar -xJ -C "$PREFIX/bin" --strip-components=1
samply --version

log "hyperfine $HYPERFINE_VERSION"
download "https://github.com/sharkdp/hyperfine/releases/download/v$HYPERFINE_VERSION/hyperfine-v$HYPERFINE_VERSION-$arch-unknown-linux-gnu.tar.gz" \
	| tar -xz -C /tmp
install -m 0755 "/tmp/hyperfine-v$HYPERFINE_VERSION-$arch-unknown-linux-gnu/hyperfine" "$PREFIX/bin/hyperfine"
rm -rf "/tmp/hyperfine-v$HYPERFINE_VERSION-$arch-unknown-linux-gnu"
hyperfine --version

log "Bun $BUN_VERSION"
if ! command -v bun >/dev/null 2>&1 || [ "$(bun --version)" != "$BUN_VERSION" ]; then
	download https://bun.sh/install | BUN_INSTALL="$PREFIX" bash -s "bun-v$BUN_VERSION" >/dev/null
fi
bun --version

log "benchboard CLI"
if [ -n "${BENCHBOARD_SOURCE:-}" ]; then
	install_dir=$BENCHBOARD_SOURCE
else
	install_dir=/opt/benchboard
	if [ -d "$install_dir/.git" ]; then
		git -C "$install_dir" fetch -q origin "$BENCHBOARD_REF" && git -C "$install_dir" checkout -q FETCH_HEAD
	else
		git clone -q --depth 1 --branch "$BENCHBOARD_REF" "$BENCHBOARD_REPO" "$install_dir"
	fi
	(cd "$install_dir" && bun install --frozen-lockfile --production --filter @benchboard/cli >/dev/null)
fi
printf '#!/bin/sh\nexec bun %s/packages/cli/bin/benchboard.ts "$@"\n' "$install_dir" > "$PREFIX/bin/benchboard"
chmod 0755 "$PREFIX/bin/benchboard"

# samply uses perf events; regular users need perf_event_paranoid <= 1. This is host-wide.
if [ "$PERF_PARANOID" != keep ]; then
	log "kernel.perf_event_paranoid = $PERF_PARANOID"
	mkdir -p /etc/sysctl.d
	{
		echo "# Benchboard: let samply record with perf events as a regular user."
		echo "kernel.perf_event_paranoid = $PERF_PARANOID"
		if [ "${KERNEL_SYMBOLS:-0}" = 1 ]; then echo "kernel.kptr_restrict = 0"; fi
	} > /etc/sysctl.d/90-benchboard-perf.conf
	if command -v sysctl >/dev/null 2>&1 && sysctl -q -p /etc/sysctl.d/90-benchboard-perf.conf 2>/dev/null; then
		:
	elif echo "$PERF_PARANOID" > /proc/sys/kernel/perf_event_paranoid 2>/dev/null; then
		if [ "${KERNEL_SYMBOLS:-0}" = 1 ]; then echo 0 > /proc/sys/kernel/kptr_restrict 2>/dev/null || true; fi
	else
		log "Could not apply it now (in a container? set it on the host); it applies at next boot"
	fi
fi

log "Ready. Check profiling as the benchmark user:"
echo "  benchboard profile check"
echo "Point it at your server:"
echo "  benchboard login https://bench.example.com     # or BENCHBOARD_SERVER + BENCHBOARD_TOKEN"
