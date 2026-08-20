# Stage 1: Build
#
# OPS-RUNTIME-NODE24-W1 (Ch2) — SEC-15. Node 20 reached EOL 2026-04-30, so this image could
# never be rebuilt patched again. Node 24 is the Active LTS line (EOL 2028-04-30). Pinned to a
# MINOR + an explicit Alpine version, never a floating `:24`, and IDENTICAL in both stages —
# a Stage-1/Stage-2 base mismatch is the classic ABI trap (it does not bite here, because
# Stage 2 runs its own `npm ci`, but keeping them in lockstep is what keeps it that way).
#
# `--ignore-scripts` is LOAD-BEARING — see the full rationale in Dockerfile.facilitator.
# Short version: better-sqlite3 v13 needs no install script but still ships a binding.gyp, and
# npm's implicit gypfile default fires under `npm ci` and dies here (this image has no
# python3/make/g++/cc). It is also the correct end-state for npm 12, which turns install
# scripts off by default.
FROM node:24.18-alpine3.24 AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src/ ./src/
RUN npm run build
# KNOWLEDGE-ARTIFACT-W1 (2026-05-18, Q-2 Path B): generator runs INSIDE Stage 1
# (NOT on the GHA runner — Hetzner re-builds the image post-`git pull`, so any
# artifacts produced on the runner are thrown away). The generator globs the
# 4 source paths below; each must be COPYed into the build context here.
COPY scripts/build-knowledge-json.mjs ./scripts/build-knowledge-json.mjs
COPY audits/ ./audits/
COPY landing/integrations/ ./landing/integrations/
COPY README.md ./README.md
RUN npm run build:knowledge

# Stage 2: Production
FROM node:24.18-alpine3.24
WORKDIR /app
COPY package*.json ./
RUN npm ci --production --ignore-scripts
COPY --from=builder /app/dist/ ./dist/
# CHANGELOG.md is read at runtime by src/scripts/agent-forum-post.ts::generateRelease()
# via src/lib/changelog-parser.ts — ship it inside the image so the script no
# longer needs the `git` CLI (which the alpine node images do not include).
COPY CHANGELOG.md ./
# OPS-RECALIBRATE-HARNESS-RETIRE-W1 removed the lone `COPY ops/closedbar-recalibrate-config.json`
# that sat here. Its consumer — the closed-bar readiness harness — was retired once its decision
# was taken (DECISION-CLOSEDBAR-ARC-DEFER-W1), so the config had no reader left inside the image.
# It was a DEDICATED single-purpose COPY sharing nothing, which is what made removing it safe;
# `ops/` is otherwise host-side and deliberately absent from the image. Deleted outright rather
# than commented out, per the OPS-X402-SMOKE-HOLD-WAIVER-RETIRE-W1 precedent.
# Absence assertion, ANCHORED so it cannot be satisfied by this very comment:
#   grep -c '^COPY ops/closedbar' Dockerfile  ->  0
# (An unanchored `grep -c closedbar-recalibrate Dockerfile` returns 2 — these two lines. A
# ban-line that matches its own literal is the recorded false-positive shape; write the
# assertion so the prose recording it cannot satisfy it.)
# INTEGRATIONS-W1 C6 — landing/integrations/*.html pre-rendered mirrors
# read at startup by the /docs/integrations/:exchange route in dist/index.js.
# WEBSITE-REFRESH-W1 C4 — landing/skills.html read at startup by the
# /skills route in dist/index.js. Both live under landing/ but Caddy serves
# the static landing pages (index/docs/verify/privacy) directly from
# /var/www/algovault. Express serves the dynamic /docs/integrations/* +
# /skills routes from the in-image copy below.
COPY landing/integrations/ ./landing/integrations/
COPY landing/skills.html ./landing/skills.html
# WEBSITE-REFRESH-CLEANUP-W1 R4 — landing/integrations.html (manifest-driven
# index of all exchange integrations) read at startup by the /integrations
# route in dist/index.js. Caddy routes /integrations to Express ahead of
# the static catch-all (see Caddyfile algovault.com block).
COPY landing/integrations.html ./landing/integrations.html
# GEO-MEASUREMENT-W1 (C1, 2026-05-19) — canonical 15-query SoT read at
# weekly-cron-fire time by dist/lib/geo-orchestrator.js::loadQueries().
# Path resolution: path.resolve(__dirname, '..', '..', 'landing', 'Prompt', ...).
COPY landing/Prompt/ ./landing/Prompt/
# BUNDLE-EXPAND-BLOG-W1 (C1, 2026-05-19) — content fetchers used by the
# weekly Sun-06:00-UTC refresh cron at scripts/refresh-knowledge-pages.mjs.
# Stage 1 doesn't need them (build-knowledge-json.mjs emits pages: []
# at build time; the cron populates pages[] at runtime). Stage 2 must
# include them because docker exec ... node scripts/refresh-knowledge-pages.mjs
# reads from /app/scripts/fetchers/* in the running container.
COPY scripts/fetchers/ ./scripts/fetchers/
# BUNDLE-EXPAND-BLOG-W1 (C3, 2026-05-19) — Sun-06:00-UTC weekly refresh entry
# point. Calls the 4 fetchers in scripts/fetchers/, dedups, writes bundle
# atomically. Required at runtime (NOT build time — pages: [] starts empty
# per Path A; cron populates).
COPY scripts/refresh-knowledge-pages.mjs ./scripts/refresh-knowledge-pages.mjs
# OPS-TRACK-TOKEN-STDIO-CLIENT-WRAPPER-W1 (R2, 2026-05-29) — read-only channel-
# attribution report. Run on demand via `docker exec ... node
# /app/scripts/funnel-by-channel.mjs` (Path α; reads funnel_events via the
# container's DATABASE_URL). Stage 2 only — never invoked at build time.
COPY scripts/funnel-by-channel.mjs ./scripts/funnel-by-channel.mjs
# OPS-DEPLOY-PROVENANCE-AND-VERDICT-CLASS-W1 CH3a — the commit this image was BUILT FROM.
#
# A BUILD ARG, not a runtime env var. The value is welded to the image, so a container restarted
# from an old image reports the OLD sha truthfully rather than inheriting the host's current idea
# of main. That truthfulness is the entire point of the route that reads it.
#
# DEFAULT IS EMPTY, and stays empty. An image built without the arg reports `sha: null` — a real,
# detectable state that the drift canary alerts on. Substituting a plausible value (the package
# version, a ref name, "unknown") would recreate the exact defect this exists to remove.
ARG GIT_SHA=
ARG BUILT_AT=
ARG GIT_REF=
ENV GIT_SHA=$GIT_SHA
ENV BUILT_AT=$BUILT_AT
ENV GIT_REF=$GIT_REF

EXPOSE 3000
ENV TRANSPORT=http
USER node
CMD ["node", "dist/index.js"]
