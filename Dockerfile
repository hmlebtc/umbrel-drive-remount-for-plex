# syntax=docker/dockerfile:1.7
#
# Production image for the Drive Remount for Plex daemon.
#
# Builds the TypeScript sources in a builder stage, then assembles a
# minimal runtime image carrying only the compiled `dist/` output and
# `package.json` - the app has ZERO runtime npm dependencies (just
# node:http and the global fetch built into Node 22), so there is no
# node_modules to copy into the runtime stage at all. Multi-arch
# (linux/amd64 + linux/arm64) - Pi-class ARM64 is a hard requirement for
# Umbrel. The CI workflow at `.github/workflows/docker-publish.yml`
# produces both architectures via `docker buildx` on every `v*` tag.
#
# The image listens on port 3012 by default and persists everything
# operator-relevant (settings.json, activity log, host-file backups)
# under `/data` - mount that as a volume on the host so state survives
# container recreation.

ARG NODE_VERSION=22

# Short git SHA threaded in by CI (`docker buildx build --build-arg
# GIT_SHA=...`). Surfaced in /api/status so the running build can be
# identified from the dashboard. .dockerignore excludes the .git/ dir
# from the build context, so without this arg it would always read "dev".
ARG GIT_SHA=dev

# App semver version threaded in the same way. .dockerignore also
# excludes hmlebtc-drive-remount-for-plex/ (the Umbrel app dir where the
# canonical umbrel-app.yml lives), so version.ts cannot read the manifest
# off disk during a Docker build. package.json is now at 0.2.0, but there
# is no fallback to it: without this arg, the image simply reports
# "unknown". CI always passes APP_VERSION from umbrel-app.yml (see
# .github/workflows/docker-publish.yml), so released images correctly
# report 0.2.0 - "unknown" only shows up in a manual/local build that
# omits --build-arg APP_VERSION.
ARG APP_VERSION=unknown

# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app

# Prime the dependency layer with manifests only - this layer rebuilds
# only when package.json/package-lock.json changes, not on every source
# edit.
COPY package.json package-lock.json ./
RUN npm ci

# Now copy source and compile (tsc → dist/).
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app

# Re-declare in this stage's scope so they can be promoted to ENV below.
ARG GIT_SHA
ARG APP_VERSION

# nsenter (util-linux) is how the daemon reaches the host: the container
# runs `privileged: true` + `pid: "host"` (docker-compose.yml), which
# together make PID 1 on the container's pid namespace be the HOST's
# real init process. `nsenter -t 1 -m -u -i -n -- <argv...>` re-enters
# that PID's mount/UTS/IPC/network namespaces, i.e. runs a command as if
# it were the host itself - that's how the daemon mounts the drive,
# restarts Plex, and reads the host's live hostname. Alpine's base image
# does not ship nsenter, so it must be installed explicitly.
RUN apk add --no-cache util-linux

# Only the compiled output + package.json are needed at runtime - there
# are zero runtime npm dependencies, so no node_modules is copied here.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# Persistent state directory. Operators should mount a volume here
# (Umbrel does this declaratively in docker-compose.yml; for `docker run`
# use `-v drive-remount-for-plex-data:/data`).
RUN mkdir -p /data
VOLUME /data

# Runs as root inside the container. Rationale: unlike a typical Umbrel
# app, root here is load-bearing, not just a bind-mount-permissions
# convenience - `privileged: true` + `pid: "host"` only grant the daemon
# the ability to act on the host (via nsenter and /proc/1/root) when the
# process itself has root's capabilities; a non-root user would defeat
# the whole host-access model this app exists to provide (see README's
# "Privileged access" section for the full disclosure). Network exposure
# is still mediated by the app_proxy sidecar in docker-compose.yml, which
# is the actual auth boundary; the daemon itself only serves plain HTTP
# on 3012.
EXPOSE 3012

ENV NODE_ENV=production \
    DRP_HTTP_PORT=3012 \
    DRP_DATA_DIR=/data \
    GIT_SHA=${GIT_SHA} \
    APP_VERSION=${APP_VERSION}

# Health probe - GET /healthz is the canonical liveness endpoint, also
# used by Umbrel/Docker to gate "started" status.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3012/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Runs the daemon, which serves its dashboard + JSON API on DRP_HTTP_PORT
# (3012) bound to 0.0.0.0.
CMD ["node", "dist/main.js"]
