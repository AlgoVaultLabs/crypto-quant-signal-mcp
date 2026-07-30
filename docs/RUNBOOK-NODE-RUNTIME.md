# Node runtime — supported versions, and why the floor moved

_Owner wave: `OPS-RUNTIME-NODE24-W1` (closes SECURITY-AUDIT-FULL-W1 SEC-15 + SEC-28)._

Enforced automatically by `scripts/check-runtime-node-eol.mjs`, which fails the build when any
declared Node major is past end-of-life or inside the warning window. This document explains the
floor; the canary is what keeps it true.

## What runs where

| Surface | Node | Notes |
|---|---|---|
| `Dockerfile` (main image, both stages) | `node:24.18-alpine3.24` | minor-pinned + explicit Alpine; never a floating `:24` |
| `Dockerfile.facilitator` (both stages) | `node:24.18-alpine3.24` | runs as `USER node` (uid 1000) — it custodies the x402 gas-wallet key |
| CI (`deploy`, `publish-npm`, `release-knowledge`) | `24` | CLAUDE.md: CI tracks the runtime |
| `package.json` `engines.node` | `>=22` | the real floor — see below |

Node 20 reached **end-of-life 2026-04-30** and receives no further security patches, so an image
pinned to it could never be rebuilt patched again. Node 24 is the **Active LTS** line
(EOL 2028-04-30).

## Why `engines.node` is `>=22` and not `>=18`

It tracks `better-sqlite3`, which declares `engines: {"node": ">=22"}` from v13. Claiming `>=18`
after that bump would be a false promise: an `>=18` self-hoster would get a package that cannot
install a prebuilt binary and would silently fall back to compiling from source.

## Two traps worth knowing before you touch this

**1. `--ignore-scripts` on the `npm ci` lines is load-bearing, not hygiene.**
`better-sqlite3` v13 declares **no install script** — its prebuilt binaries ship inside the npm
tarball (`prebuilds/linuxmusl-x64.node`). But it still ships a `binding.gyp`, and npm's documented
default is to run `node-gyp rebuild` for any package that has one and no explicit install script.
Under `npm ci` that default fires and the image build dies with *"Could not find any Python
installation to use"* — the alpine images carry no `python3`/`make`/`g++`/`cc`.

Note the asymmetry, which is why a local check proves nothing about the image: plain `npm install`
does **not** trigger it; `npm ci` **does**, even from a lockfile generated inside that same image.

**2. npm 12 turns install scripts off by default — and that is why v13, not v12.**
npm 11.16 already prints `npm warn allow-scripts`. `better-sqlite3` v12 gets its binary *via* an
install script (`prebuild-install || node-gyp rebuild`), so under npm 12 that script stops running
and the module arrives with no binary. v13 needs no script at all, so it is unaffected. Do **not**
`npm i -g npm@latest` in any image or workflow: Node 24 bundles npm **11.16.0**, which satisfies
the OIDC floor (`>= 11.5.1`) and is still `< 12`.

## Self-hosting

Run on Node **22 or newer**; 24 is what production uses and what CI tests. `npm ci` is expected to
resolve a prebuilt `better-sqlite3` binary with no compiler present — if you see `node-gyp` in your
install log, something has gone wrong rather than merely slow.

## Bumping Node again later

1. Change the pinned tag in **both** Dockerfiles (keep both stages identical).
2. Change `node-version` in all three workflows.
3. Re-check `engines.node` against the current `better-sqlite3` `engines`.
4. Refresh `scripts/data/node-eol.json` (it carries its own revisit date).
5. `better-sqlite3` should need no attention — that is the point of the N-API line. If a future
   version reintroduces per-ABI prebuilds, treat that as a blocker, not a detail.
