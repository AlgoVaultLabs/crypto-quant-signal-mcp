/**
 * retired-slugs.ts: integration slugs we no longer serve, and the one handler that answers for them.
 *
 * A retired slug is one row here. The route answers it with a 301 instead of a 404, so an indexed
 * or copied link still lands somewhere useful. scripts/check-integrations-registry-lockstep.mjs
 * reads this same literal and fails CI if a retired slug reappears in a registry, a route or render
 * list, a rendered page, the sitemap or a generated block. Keep each row on one line: the lockstep
 * parser and the forbidden-phrase gate both read this file line by line.
 */
import type { RequestHandler } from 'express';

export interface RetiredIntegrationSlug {
  /** Where the 301 sends the reader. */
  to: string;
  /** ISO date the page was retired. */
  retired: string;
  /** Why, for the next reader of this table. Never rendered. */
  why: string;
}

export const RETIRED_INTEGRATION_SLUGS: Readonly<Record<string, RetiredIntegrationSlug>> = Object.freeze({
  smithery: { to: '/integrations', retired: '2026-11-08', why: 'Smithery closed its API, CLI and hosted URLs on 2026-10-31' },
});

/**
 * GET /integrations/:slug. `html` is the allow-listed page map built once at startup, so an unknown
 * slug never reaches the filesystem. `Object.hasOwn`, not a bare lookup: `/integrations/constructor`
 * must be a 404, and a lookup on a plain object would find the inherited member.
 */
export function integrationPageHandler(html: ReadonlyMap<string, string>): RequestHandler {
  return (req, res) => {
    const slug = String(req.params.slug ?? '').toLowerCase().replace(/\.html$/, '');
    if (Object.hasOwn(RETIRED_INTEGRATION_SLUGS, slug)) {
      res.redirect(301, RETIRED_INTEGRATION_SLUGS[slug].to);
      return;
    }
    const page = html.get(slug);
    if (!page) {
      res.status(404).type('text/plain').send('Integration not found');
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
    res.type('text/html').send(page);
  };
}
