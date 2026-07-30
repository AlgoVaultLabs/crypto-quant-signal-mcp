# Runbook — rotating the IP-pseudonym key

Owner: `OPS-SEC-IPHASH-SALT-W1` (2026-07-29). Applies to `ALGOVAULT_IP_HASH_KEY` and the
`IP_HASH_VERSION` tag in `src/lib/analytics.ts`.

<!-- TODO: revisit by 2027-01-29 — 6-month rotation cadence review. Rotation is NOT required on a
     schedule (the key is not exposed to clients and never leaves the host), so this is a review of
     whether a cadence is warranted at all, not an overdue action. See "When to rotate". -->

---

## What the key does

`hashIp(ip)` returns `v2:<HMAC-SHA256(key, ip)[0:16]>`. Before this wave it was
`sha256(ip)[0:16]` — **unkeyed**, and therefore reversible: the input space is ~2^32 for a full
IPv4 and only ~2^24 for the /24-masked value we actually hash, so a stored `ip_hash` could be
brute-forced back to the address in seconds. With a key, recovering anything requires the key.

The key lives **only** in `/opt/crypto-quant-signal-mcp/.env` (mode 600, root:root). It is in no
tracked file, no image layer, and no log. It is never printed — compare by `sha256` if you need to
confirm two copies match.

## The three rules

1. **Historical rows are never re-hashed.** They cannot be — the input IP was never stored, which
   is the entire point. A `v1` value stays `v1` forever.
2. **The version tag rides in the value**, not a sibling column: `v2:<hash>`. The highest-value
   consumers are *keys* (`quota_usage.tracker_key` = `free:<hash>`, `chat_usage_monthly.api_key` =
   `ip:<hash>`, `agent_sessions.session_id`) which have nowhere to put a sibling column.
3. **Rotating the key re-namespaces every future bucket.** That is the intended behaviour, not a
   bug. Bump `IP_HASH_VERSION` in the same change so the boundary is legible.

## When to rotate

Rotate if the key is believed disclosed (host compromise, an `.env` leak, a backup landing
somewhere it should not). There is **no** routine expiry: the key is server-side only and never
transits to a client, so scheduled rotation buys little and costs a quota reset each time.

## Rotation procedure

**Sequencing matters: env before code.** The HTTP transport crash-fasts at boot without a valid
key, so a code deploy that lands first takes the API down.

```bash
# 1. Generate on the host. Never on a laptop, never through a clipboard.
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24
NEW=$(openssl rand -hex 32)

# 2. Back up, then replace the line in place. Mode 600 preserved.
cp -a /opt/crypto-quant-signal-mcp/.env "/root/.rotate-bak/.env.$(date +%s)"
sed -i "s|^ALGOVAULT_IP_HASH_KEY=.*|ALGOVAULT_IP_HASH_KEY=$NEW|" /opt/crypto-quant-signal-mcp/.env
grep -c '^ALGOVAULT_IP_HASH_KEY=' /opt/crypto-quant-signal-mcp/.env   # expect exactly 1

# 3. Recreate — `restart` does NOT reload env_file.
#    Postgres is recreated ONLY if a var IT uses changed. Measured 2026-07-29: adding just
#    ALGOVAULT_IP_HASH_KEY recreated mcp-server alone (postgres stayed up 7min). Changing
#    POSTGRES_PASSWORD in the same edit DOES drag postgres along (~32s), so a combined rotation
#    is a brief DB restart while a key-only rotation is not.
cd /opt/crypto-quant-signal-mcp && docker compose up -d mcp-server

# 4. Prove the container sees it (presence, NEVER the value).
docker exec crypto-quant-signal-mcp-mcp-server-1 \
  sh -c 'cat /proc/1/environ | tr "\0" "\n" | grep -c ALGOVAULT_IP_HASH_KEY'   # expect 1
```

Then bump the version in a normal commit and deploy:

```
src/lib/analytics.ts:  export const IP_HASH_VERSION = 'v3';
```

Verify (measure, do not infer — hash-inference is what cost two earlier waves their verification):

```bash
ADMIN=<from host .env>
curl -sS -H "Authorization: Bearer $ADMIN" https://api.algovault.com/debug/client-ip
#   → derived.ipHash starts with the NEW version, derived.ipHashVersion matches
curl -sS https://api.algovault.com/health     # → status ok
node scripts/check-iphash-keyed.mjs           # → clean
```

## Rollback

```bash
# Restore the previous .env (the key is the only thing that changed) and recreate.
cp -a /root/.rotate-bak/.env.<timestamp> /opt/crypto-quant-signal-mcp/.env
cd /opt/crypto-quant-signal-mcp && docker compose up -d mcp-server
# If IP_HASH_VERSION was already bumped and deployed, revert that commit too:
git revert <sha> && git push      # never reset --hard on main
```

Buckets written under the rolled-forward key keep their tag; they simply stop being written to.
Nothing is corrupted — that is what the version tag buys.

## What discontinuity to expect

| Surface | Effect | Why |
|---|---|---|
| Free-tier quota (`free:<hash>`) | **one-time reset** — in-flight free users get a fresh allowance | new key ⇒ new bucket |
| Chat quota (`ip:<hash>`) | one-time reset | same |
| `agent_sessions` ipHash-fallback sessions | one-time discontinuity; a client appears as a new session once | the id IS the hash |
| **Track-token sessions** | **unaffected** | `resolveSessionIdentity` returns the token before ever consulting `ipHash` (`src/lib/track-token.ts`) — this is the primary attribution path |
| `funnel-snapshot` `unique_ips` | inflated once across the cutover | it is `COUNT(DISTINCT ip_hash_first)`, so one client counts on both sides of the boundary |
| PQL cohort joins | intact | `SUBSTR('free:v2:<hash>', 6)` = `v2:<hash>`, matching `request_log.ip_hash` exactly — the join compares tagged to tagged |
| Paid customers | unaffected | keyed on the license key, never the IP |

Record any reset in `status.md` with before/after distinct-bucket counts, dated. Precedent:
`OPS-AUDIT-REMEDIATION-HIGH-W1` and this wave both did.

## Latent hazard worth knowing

`webhook_subscriptions.owner_key` and `referral_codes.owner_key` are `free:<ipHash>` for free-tier
owners. A key rotation would therefore break **durable resource ownership**, not merely a counter —
a free user would lose access to their own webhook subscription. At the time of writing there are
**zero** free-owned rows in either table (measured), so this is latent rather than live. **Check
both counts before any future rotation**, and if either is non-zero treat re-owning those rows as
part of the rotation, not an afterthought:

```sql
SELECT COUNT(*) FROM webhook_subscriptions WHERE owner_key LIKE 'free:%';
SELECT COUNT(*) FROM referral_codes        WHERE owner_key LIKE 'free:%';
```

## Reusing this for another keyed identifier

The pattern generalises to any pseudonym (email hashes, device ids, referral fingerprints):
one exported resolver that throws rather than defaulting, HMAC not `sha256(salt + x)`, the version
tag inline in the value, historical values never recomputed, and a fail-closed canary asserting no
unkeyed lane exists. `src/lib/analytics.ts` + `scripts/check-iphash-keyed.mjs` are the reference
implementation.
