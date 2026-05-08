# PUBLISH.md — release publication runbook

Canonical sequence for publishing a new `crypto-quant-signal-mcp` release. Five
hops: source → npm → MCP registry → GitHub Release → Hetzner deploy. The first
four are operator-driven (this doc); the last is auto-triggered by `main` push.

> **Author note**: this file is intentionally a runbook (sequenced commands,
> exact versions to bump, verification probes per hop), not a CHANGELOG. The
> CHANGELOG itself lives at [`CHANGELOG.md`](./CHANGELOG.md) and gets a new
> entry at step 1 below.

---

## Step 0 — pre-flight check (10 sec)

```bash
# Working tree clean except for files YOU intend to release. Anything else
# (auto-snapshot dirty `manifest.json`, etc.) → discard or commit separately.
cd /path/to/crypto-quant-signal-mcp
git status --short

# Confirm npm + GitHub auth are alive
npm whoami                                       # → algovaultdev (or similar)
gh auth status | grep "Logged in"                # → Logged in to github.com

# Confirm mcp-publisher is installed (used in step 3)
command -v mcp-publisher
```

---

## Step 1 — bump versions + update docs (5 min)

Four files take the version bump; one takes the new entry. Use the **same**
SemVer string everywhere.

| File | Edit |
|---|---|
| `package.json` | `"version": "X.Y.Z"` (top-level) |
| `server.json` | `"version": "X.Y.Z"` (top-level) AND `packages[0].version` |
| `CHANGELOG.md` | Prepend new `## [X.Y.Z] - YYYY-MM-DD — <title>` block above the previous entry. Sections: `### Added` / `### Changed` / `### Notes`. |
| `README.md` | Replace the `## What's new in vA.B.C` block with `## What's new in vX.Y.Z`. Mark snapshot lines with `<!-- SNAPSHOT-LINE -->` for refetch. |

**DO NOT touch** `manifest.json` (root) — that's the algovault-skills
marketplace schema, not the npm package version. Different concern.

```bash
# Stage exactly the 4 release files (not -A, not . — defensive against
# auto-snapshot dirties + secrets accidentally staged):
git add package.json server.json CHANGELOG.md README.md

# Commit
git commit -m "release: vX.Y.Z — <one-line title>

<paragraph summary>

Server-side additions: ...
Public response shape, MCP tool list, free-tier behavior unchanged from vA.B.C."

# Push to main → auto-triggers the Hetzner deploy workflow
git push origin main
```

The `main` push starts `.github/workflows/deploy.yml` (`docker compose up -d --build`
on the Hetzner CPX22). Verify:

```bash
gh run list --repo AlgoVaultLabs/crypto-quant-signal-mcp --limit 1
# Wait for "completed success" before moving on (~2 min)
```

---

## Step 2 — git tag + push (30 sec)

```bash
# Annotated tag — keeps a release-notes one-liner in `git log --tags`
git tag -a vX.Y.Z -m "vX.Y.Z — <one-line title>"
git push origin vX.Y.Z
```

Verify:

```bash
git ls-remote --tags origin vX.Y.Z      # → <sha>\trefs/tags/vX.Y.Z
```

---

## Step 3 — npm publish (1 min) ⚠️ irreversible

```bash
npm publish
# Output ends with: + crypto-quant-signal-mcp@X.Y.Z
```

Verify:

```bash
sleep 3 && npm view crypto-quant-signal-mcp version    # → X.Y.Z
```

> **npm publishes are irreversible.** `npm unpublish` only works in the first
> 72 hours, and even then leaves a permanent gap in the version history.
> If you need to fix something, ship `X.Y.Z+1` with the fix.

---

## Step 4 — MCP registry publish (~1 min, browser hop)

```bash
./scripts/publish-to-mcp-registry.sh
```

The script wraps the canonical 3-call sequence:

1. `mcp-publisher validate` — sanity-check `server.json` shape
2. `mcp-publisher login github` — interactive device flow:
   - CLI prints `Visit https://github.com/login/device and enter code XXXX-XXXX`
   - Open the URL, paste the code, authorize the **AlgoVaultFi** GitHub identity
3. `mcp-publisher publish` — POSTs `server.json` to
   `registry.modelcontextprotocol.io/v0/publish`

Verify:

```bash
curl -fsS 'https://registry.modelcontextprotocol.io/v0/servers?search=AlgoVaultFi' \
  | jq '.servers[] | select(.server.version == "X.Y.Z") | {name: .server.name, version: .server.version, isLatest: ._meta."io.modelcontextprotocol.registry/official".isLatest}'

# Expect: {"name": "io.github.AlgoVaultFi/crypto-quant-signal-mcp", "version": "X.Y.Z", "isLatest": true}
```

### Why no CI for this step

The MCP registry's OIDC-publishing path grants `io.github.<repository_owner>/*`
permissions based on the OIDC token's `repository_owner` claim (hard-coded —
no override). Our repo lives at `github.com/AlgoVaultLabs/crypto-quant-signal-mcp`,
so OIDC from CI authorizes `io.github.AlgoVaultLabs/*` only. Our published
namespace is `io.github.AlgoVaultFi/*` (a separate GH identity). The mismatch
means CI can't publish under the existing namespace without renaming
(which would split the historical registry trail).

Trade-off: keep the existing namespace + accept ~30 sec of operator-time per
release. At ~1-2 releases/month, that's < 10 min/year of friction — cheaper
than refactor + permanent dual-listing.

If GitHub ever ships a way to override the `repository_owner` OIDC claim
(some `id_token_subject_claim_options` knob already exists for `sub`), revisit
this and wire CI.

---

## Step 5 — GitHub Release (1 min)

```bash
# Pull the v1.10.X What's New block from README.md as the release-notes body
NOTES=$(awk "/^## What.s new in vX.Y.Z/{flag=1; next} /^---\$/{if(flag){exit}} flag" README.md)

gh release create vX.Y.Z \
  --title "vX.Y.Z — <one-line title>" \
  --notes "$NOTES"
```

Verify:

```bash
gh release view vX.Y.Z --json url,tagName,name
# → URL like https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/releases/tag/vX.Y.Z
```

---

## Post-publish checklist

- [ ] `npm view crypto-quant-signal-mcp version` returns `X.Y.Z`
- [ ] `git ls-remote --tags origin vX.Y.Z` returns the tag
- [ ] MCP registry query returns the new version with `isLatest: true`
- [ ] `gh release view vX.Y.Z` returns the release
- [ ] Hetzner deploy workflow `completed success` (auto-triggered by step 1's `git push origin main`)
- [ ] Smoke-test live MCP: `curl -fsS https://api.algovault.com/api/performance-public | jq '.totalCalls'` returns a non-null integer
- [ ] (If the release adds public copy or new endpoints) update `system-map.md`
      in the vault with the change in the SAME wave that ships the code

---

## Rollback playbook

| What broke | Fix |
|---|---|
| Hetzner deploy red after `main` push | `git revert <sha> && git push origin main` — re-deploys the prior commit |
| npm publish shipped a bug | Cannot unpublish reliably (72h window). Ship `X.Y.Z+1` with the fix. Note in CHANGELOG: `### Fixed` |
| MCP registry has wrong content | `mcp-publisher status --version X.Y.Z deprecated` to mark deprecated, then publish `X.Y.Z+1` |
| GitHub Release has wrong notes | `gh release edit vX.Y.Z --notes "<corrected>"` |

---

## Cross-references

- `CHANGELOG.md` — historical record of every release
- `README.md` § "What's new in vX.Y.Z" — public-facing announcement (carried into npm + GH)
- `server.json` — MCP registry manifest (the source of truth for step 4)
- `.github/workflows/deploy.yml` — Hetzner deploy CI (auto, no manual step)
- `audits/BOT-W2-endpoint-truth.md` § P5 — registry-API jq-shape gotcha (`.servers[].server.name`, NOT `.servers[].name`)
