/**
 * OPS-DEPLOY-PROVENANCE-AND-VERDICT-CLASS-W1 CH3b — GET /api/ops/build.
 *
 * WHY THIS EXISTS. `/capabilities` reports `version: "1.27.0"` — the PACKAGE version. Per the
 * release cadence, code waves never bump it; only the daily RELEASE wave does. Dozens of commits
 * share one version, so nothing anywhere stated which COMMIT production was running. Answering
 * "is my code live?" required SSH forensics: on 2026-08-20 it took four host commands, and NONE of
 * them returned a sha — the answer was reached by correlating a container restart timestamp with a
 * workflow run time and grepping the built artifact for a string the author happened to know was
 * in that commit. This route is that receipt.
 *
 * 🛑 EVERY FIELD IS UNKNOWN-ABLE. An image built without the build arg reports `sha: null` — never
 * a placeholder, never a ref name, and never the package version standing in for a commit. `null`
 * means "this image was built without provenance", which is a REAL and DETECTABLE state that the
 * drift canary alerts on. Substituting a plausible value would recreate the exact defect this
 * route exists to remove.
 *
 * 🛑 NOT ON /capabilities. That response is snapshot-gated (`snapshot_capabilities.mjs --check`,
 * `registry:drift:check` in prepublishOnly) and is public copy; a new field there moves the
 * snapshot and needs public-copy approval. This surface is INTERNAL and carries the same
 * `checkBotInternalAuth` as /api/bot/validate-key and /api/entitlement/*, with the 401/403 shapes
 * reused verbatim — no new auth scheme.
 */
import type { Express } from 'express';
import { checkBotInternalAuth } from './bot-auth.js';
import { PKG_VERSION } from './pkg-version.js';

/** A 40-char lowercase hex commit sha, or null. Nothing else is ever a sha. */
export function normaliseSha(raw: string | undefined): string | null {
  const s = (raw ?? '').trim();
  return /^[0-9a-f]{40}$/.test(s) ? s : null;
}

/**
 * An ISO-8601 instant, or null.
 *
 * A malformed stamp is null rather than passed through: a consumer computing "how long has this
 * been deployed" from an unparseable string would produce a confident wrong number, which is worse
 * than an absent one.
 */
export function normaliseBuiltAt(raw: string | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export interface BuildProvenance {
  readonly sha: string | null;
  readonly short_sha: string | null;
  readonly ref: string | null;
  readonly built_at: string | null;
  readonly version: string;
  readonly node: string;
}

export function buildProvenance(env: NodeJS.ProcessEnv = process.env): BuildProvenance {
  const sha = normaliseSha(env.GIT_SHA);
  return {
    sha,
    // Derived from the sha, never independently sourced — a short_sha that disagrees with its own
    // sha is a bug that only shows up when someone greps for one of them.
    short_sha: sha ? sha.slice(0, 7) : null,
    ref: (env.GIT_REF ?? '').trim() || null,
    built_at: normaliseBuiltAt(env.BUILT_AT),
    // The package version is reported ALONGSIDE the sha, never instead of it. Keeping both makes
    // the distinction visible: many commits share one version, which is the whole reason this
    // route was needed.
    version: PKG_VERSION,
    node: process.version,
  };
}

export function registerOpsBuildRoute(app: Express): void {
  app.get('/api/ops/build', (req, res) => {
    const auth = checkBotInternalAuth(req.headers as Record<string, string | undefined>);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    return res.json(buildProvenance());
  });
}
