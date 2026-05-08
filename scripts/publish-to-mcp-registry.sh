#!/usr/bin/env bash
#
# Publishes the current server.json to https://registry.modelcontextprotocol.io.
# Requires interactive GitHub auth (mcp-publisher device flow) — the registry's
# OIDC publishing path grants permissions to `io.github.<repo_owner>/*`, but
# our namespace `io.github.AlgoVaultFi/*` is bound to a separate GH identity
# from this repo's owner (AlgoVaultLabs), so OIDC-from-CI is structurally
# unauthorized. See PUBLISH.md § "Why no CI for the MCP registry step" for the
# full rationale.
#
# Usage (run from repo root, after `git push --tags` and `npm publish`):
#   ./scripts/publish-to-mcp-registry.sh

set -euo pipefail

# Anchor to the repo root regardless of where this script is invoked from
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -f server.json ]]; then
  echo "❌ server.json not found at $REPO_ROOT — refusing to publish" >&2
  exit 1
fi

if ! command -v mcp-publisher >/dev/null 2>&1; then
  echo "❌ mcp-publisher not found in PATH" >&2
  echo "   install: brew install mcp-publisher" >&2
  echo "   or: github.com/modelcontextprotocol/registry/releases" >&2
  exit 1
fi

NAME="$(jq -r '.name' server.json)"
VERSION="$(jq -r '.version' server.json)"
echo "→ About to publish $NAME @ $VERSION to registry.modelcontextprotocol.io"

# Validate before requesting auth — fast-fails on bad server.json shape
mcp-publisher validate

# Always re-auth: the cached JWT at ~/.mcp_publisher_token expires within
# hours, so a fresh device-flow auth on every release is the only reliable
# path. Takes ~30 sec end-to-end (browser device approval).
echo ""
echo "→ Authenticating via GitHub device flow…"
echo "   (CLI will print a code + URL — open in browser, authorize, return here)"
mcp-publisher login github

echo ""
echo "→ Publishing…"
mcp-publisher publish

echo ""
echo "✅ Published. Verify with:"
echo "   curl -fsS 'https://registry.modelcontextprotocol.io/v0/servers?search=${NAME}' \\"
echo "     | jq '.servers[] | select(.server.version == \"${VERSION}\") | {name: .server.name, version: .server.version, isLatest: ._meta.\"io.modelcontextprotocol.registry/official\".isLatest}'"
