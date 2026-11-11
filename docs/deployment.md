# Deploying Benchboard

Benchboard runs as one server process that owns a data directory. Benchmark machines (laptops, CI
runners, dedicated hosts) keep running Hyperfine and samply locally and **push** results with the
`benchboard` CLI; people use the web app. The server needs no access to your checkouts.

```
benchmark machine                                   server (container)
─────────────────                                   ───────────────────────────────
hyperfine / samply ─▶ benchboard ingest ── HTTPS ──▶ benchboard serve ─▶ /data (SQLite + files)
  (reads files, resolves commits with git)  token    (validates, stores)    ▲
                                                                             └─ benchboard backup
browser ──────────────────────────────────── HTTPS ──▶ web app + GraphQL (session cookie)
```

## Quick start (Docker Compose)

```sh
git clone … benchboard && cd benchboard
docker compose up -d --build                     # http://localhost:4319, data in the benchboard-data volume
docker compose exec benchboard benchboard token create admin --scope admin
```

The token is printed once. Open the web app and sign in with it.

CI publishes multi-arch images (linux/amd64, linux/arm64) to `ghcr.io/sebastiaan-dev/benchboard`. The
`edge` tag follows `main`, `sha-<commit>` tags pin a build, and version tags appear for `v*` releases.
To use a published image instead of building one:

```sh
BENCHBOARD_IMAGE=ghcr.io/sebastiaan-dev/benchboard:edge docker compose up -d --no-build
```

On each benchmark machine:

```sh
benchboard login http://localhost:4319           # paste a write token (input is hidden)
benchboard ingest q1.json --meta meta.json --track-branch
```

For Linux benchmark machines (EC2), see [linux-profiling.md](linux-profiling.md); it includes a setup
script for runners.

From then on, every command (`ingest`, `pr track|sync|report`, `profile attach|record|show|diff`, `runs`,
`query`, `open`, `import-legacy`) goes to the server. You can also set `BENCHBOARD_SERVER` and
`BENCHBOARD_TOKEN` instead of logging in, which suits CI. Use `--local` (or `--home <dir>`) to work
with a local data directory instead. `benchboard whoami` shows where commands go.

## Exposing it: TLS

The compose file publishes the server on `127.0.0.1` only. To serve it on a domain with automatic
HTTPS (Let's Encrypt) through the bundled Caddy:

```sh
export BENCHBOARD_DOMAIN=bench.example.com BENCHBOARD_PUBLIC_URL=https://bench.example.com
docker compose --profile tls up -d
```

If you use another reverse proxy, keep these properties:

* It forwards the original `Host` header.
* Uploads are not limited below the size of your profiles (raw samply profiles can be hundreds of MiB).
* Benchboard is served at the **root** of its host, not under a path prefix.
* `BENCHBOARD_PUBLIC_URL` is set to the external origin.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `BENCHBOARD_PUBLIC_URL` | — | External origin, e.g. `https://bench.example.com`. Used for links (including signed Firefox Profiler links), the allowed `Host`/`Origin`, and `Secure` cookies. Set it whenever a proxy is in front. |
| `BENCHBOARD_AUTH` | `token` in the image (`none` on loopback otherwise) | `token`: API tokens (bearer header for the CLI, session cookie for browsers). `none`: no authentication. Only use `none` behind a proxy that authenticates users, such as oauth2-proxy or a VPN. |
| `BENCHBOARD_PUBLIC_READ` | `0` | `1`: anyone can read without signing in. Writes still need a token. |
| `GITHUB_TOKEN` | — | Used to track or sync GitHub PRs from the web app (private repositories, higher rate limits). CLI users track PRs with their own credentials (`GITHUB_TOKEN`, `GH_TOKEN` or `gh auth login`). `GITHUB_API_URL` selects GitHub Enterprise. |
| `BENCHBOARD_HOME` | `/data` | Data directory. |
| `BENCHBOARD_HOST`, `BENCHBOARD_PORT` | `0.0.0.0`, `4319` | Listen address. |
| `BENCHBOARD_MAX_UPLOAD_MB` | `1024` | Largest request body accepted. |
| `BENCHBOARD_ACCESS_LOG` | on unless loopback | One line per request on stderr. Successful health checks are not logged. |
| `BENCHBOARD_ALLOWED_ORIGINS` | — | Extra browser origins allowed to call the API, comma-separated (e.g. a Vite dev server). |

## Access

Tokens have one of three scopes, and each includes the ones before it:

* **read**: view everything, including the web app, GraphQL queries, reports and profiles.
* **write**: ingest runs, attach profiles, track and sync pull requests.
* **admin**: delete runs and profiles.

Manage tokens on the server host. They act directly on the data directory:

```sh
docker compose exec benchboard benchboard token create ci-runner-m5 --scope write
docker compose exec benchboard benchboard token list
docker compose exec benchboard benchboard token revoke ci-runner-m5     # by name or id; immediate
```

Only a SHA-256 digest of each token is stored. Browsers keep the token in an `HttpOnly`,
`SameSite=Lax` cookie (`Secure` over HTTPS) for 30 days. Cross-origin requests to the API are refused,
and browser writes also need a CSRF token that only same-origin pages can read.

The Firefox Profiler loads profiles from the server without credentials. On servers with
authentication, the "Firefox Profiler" button therefore uses a signed link that expires after 24 hours.

## Data and persistence

Everything lives in the data directory, which the compose file keeps in the `benchboard-data` volume:

| Path | Contents |
| --- | --- |
| `benchboard.db` (+ `-wal`, `-shm`) | SQLite database in WAL mode: runs, measurements, PRs, profile call trees, tokens |
| `exports/<sha256>.json` | Every Hyperfine export, as uploaded |
| `profiles/<sha256>.json.gz`, `.syms.json` | Raw samply profiles and their symbol sidecars |
| `secret.key` | Signs profile links and CSRF tokens; keep it with the data |
| `benchboard.db.v<N>.bak` | A snapshot taken automatically before a schema upgrade from version N |

Files are content-addressed and never modified. They are written before the rows that reference
them, so the database always describes files that exist.

Requirements:

* Put the volume on a **local filesystem**. Do not use NFS or SMB: SQLite's locking is not reliable there.
* Run **one** server per data directory. Short-lived CLI commands against the same directory
  (`token`, `backup`, `verify`) are safe alongside it.

### Upgrades

Pull or rebuild, then `docker compose up -d`. Schema migrations run at startup. Before migrating,
the server writes `benchboard.db.v<old>.bak`. A newer database refuses to open with an older
Benchboard, so you cannot downgrade by accident. To roll back, stop the server, restore the `.bak`
over `benchboard.db` and start the older image.

### Backups

`benchboard backup <dir>` writes a consistent copy while the server keeps running:

* a SQLite snapshot (`VACUUM INTO`);
* any files the destination does not have yet, which makes repeat backups incremental;
* `secret.key`.

`benchboard verify --home <dir>` checks a copy:

* `integrity_check`;
* foreign keys;
* that every referenced export and profile file exists.

The `backup` compose profile does this every six hours (`BENCHBOARD_BACKUP_INTERVAL`, in seconds)
into the `benchboard-backups` volume:

```sh
docker compose --profile backup up -d
```

Set `BENCHBOARD_BACKUP_DIR` to a host path (owned by uid 1000) to put backups on the host instead.
Ship that directory off-site with your usual tool (restic, borg, rsync). Without compose:

```sh
docker compose exec benchboard benchboard backup /backups/$(date +%F)   # any directory in the container
```

To **restore**:

1. Stop the server.
2. Copy a backup directory's contents into an empty data directory (or volume).
3. Start the server.

For example:

```sh
docker compose down
docker volume create benchboard-restore
docker run --rm -v benchboard_benchboard-backups:/backups:ro -v benchboard-restore:/data benchboard:latest \
  sh -c 'cp -a /backups/latest/. /data/ && benchboard verify --home /data'
# then point the benchboard service's volume at benchboard-restore (or copy into benchboard-data)
```

Tokens are part of the database, so a restored server accepts the same tokens.

## Health and operations

* `GET /healthz` returns `{"ok":true,"version":…,"schemaVersion":…}` once the database answers. It needs no
  credentials. The image's `HEALTHCHECK` runs `benchboard healthcheck`.
* `SIGTERM` stops accepting connections, finishes in-flight requests and closes the database cleanly.
  The compose file allows 30 s for this.
* Logs go to stderr: startup configuration, one access-log line per request, and errors with stack traces.
* `benchboard verify` checks the live data directory. Run it from `docker compose exec`.

## Without Docker

The server is `bun packages/cli/bin/benchboard.ts serve`. You need Bun, plus the web app built once
with `bun install && bun run build`.

```sh
BENCHBOARD_HOME=/var/lib/benchboard BENCHBOARD_PUBLIC_URL=https://bench.example.com \
  bun packages/cli/bin/benchboard.ts serve --host 0.0.0.0 --auth token
```

A systemd unit only needs `Restart=on-failure`, a dedicated user that owns the data directory, and
`KillSignal=SIGTERM`.
