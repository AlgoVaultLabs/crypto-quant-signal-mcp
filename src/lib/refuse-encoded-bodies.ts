/**
 * OPS-NODE-SECURITY-FLOOR-W1 CH2 R2 — refuse a request body sent in a content coding this
 * server will not decode.
 *
 * Mounted as the FIRST `app.use` of each express app (src/index.ts, src/facilitator.ts), ahead
 * of every body parser and every route, so a refused body is answered before anything reads it.
 *
 *   'brotli' (the default)  refuses `br` and any coding outside identity / gzip / deflate.
 *   'all'                   refuses every coding except identity.
 *
 * Only a request that carries a body is judged, by the test body-parser itself applies
 * (`Transfer-Encoding` present, or a numeric `Content-Length`), so a bodiless GET / HEAD /
 * OPTIONS passes whatever its headers say. A `Content-Encoding` list is judged coding by
 * coding: one refused coding refuses the request.
 *
 * The mode comes from REFUSE_ENCODED_BODIES_MODE (`refuseEncodedBodiesFromEnv`). Unset means
 * 'brotli'; a value that is not a mode also means 'brotli', with a boot warning. Boot prints
 * `[ingress] refuse-encoded-bodies mode=<mode>`. A route family added after this wave mounts
 * `refuseEncodedBodies({ mode: 'all' })` on its own path.
 *
 * MUST NOT: read, buffer or decode the request body.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export type RefuseEncodedBodiesMode = 'brotli' | 'all';

const MODES: readonly RefuseEncodedBodiesMode[] = ['brotli', 'all'];

/** The codings 'brotli' mode lets through (body-parser decodes gzip and deflate itself). */
const BROTLI_MODE_PASSES = new Set(['identity', 'gzip', 'deflate']);

const REFUSAL = {
  ok: false,
  code: 'unsupported_content_encoding',
  error: 'compressed request bodies are not accepted',
  suggested_action: 'Send the body uncompressed (omit the Content-Encoding header).',
} as const;

/** The codings a Content-Encoding header lists, lower-cased; absent or blank means identity. */
function listedCodings(header: string | undefined): string[] {
  const codings = (header ?? '').split(',').map((c) => c.trim().toLowerCase()).filter((c) => c !== '');
  return codings.length > 0 ? codings : ['identity'];
}

/** body-parser's test for "this request carries a body" (type-is `hasBody`). */
function carriesBody(req: Request): boolean {
  return req.headers['transfer-encoding'] !== undefined || !Number.isNaN(Number(req.headers['content-length']));
}

/** Answer 415 to a body in a refused coding; pass everything else through untouched. */
export function refuseEncodedBodies({ mode }: { mode: RefuseEncodedBodiesMode }): RequestHandler {
  const refused = mode === 'all'
    ? (coding: string): boolean => coding !== 'identity'
    : (coding: string): boolean => !BROTLI_MODE_PASSES.has(coding);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!carriesBody(req) || !listedCodings(req.headers['content-encoding']).some(refused)) {
      next();
      return;
    }
    // Never read: node drains the unread body off the socket, undecoded, after the reply.
    res.status(415).json(REFUSAL);
  };
}

/**
 * The middleware for the mode REFUSE_ENCODED_BODIES_MODE names. Unset or blank means 'brotli';
 * any other value that is not a mode also means 'brotli', and boot says so.
 */
export function refuseEncodedBodiesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, 'log' | 'warn'> = console,
): RequestHandler {
  const raw = env.REFUSE_ENCODED_BODIES_MODE ?? '';
  let mode: RefuseEncodedBodiesMode = 'brotli';
  if ((MODES as readonly string[]).includes(raw)) {
    mode = raw as RefuseEncodedBodiesMode;
  } else if (raw !== '') {
    log.warn(`[ingress] REFUSE_ENCODED_BODIES_MODE=${JSON.stringify(raw)} is not one of ${MODES.join(' | ')}; using brotli`);
  }
  log.log(`[ingress] refuse-encoded-bodies mode=${mode}`);
  return refuseEncodedBodies({ mode });
}
