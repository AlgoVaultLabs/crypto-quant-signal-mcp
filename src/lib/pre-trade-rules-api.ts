/**
 * pre-trade-rules-api.ts — DECISION-CALL-V2-W2 CH2. Saved `pre_trade_check` rules over REST: `/api/pre-trade-rules`.
 *
 * `Prompt/pre-trade-check-contract-v2.md` § v2.1. A caller with an API key saves a `rules` object once; every
 * pre_trade_check made with that key then applies it (the reader is the handler, through `pre-trade-rule-profiles.ts`).
 * Saving is an account action, not a tool: these routes are unbilled, and pre_trade_check itself stays read-only.
 *
 *   PUT     body = the rules object   200 {ok, rules, updated_at}, replacing the profile · 400 invalid_rules naming the key
 *   GET                               200 {ok, rules, updated_at} — {} and null when none is saved
 *   DELETE                            200 {ok, deleted}
 *
 * The /api/webhooks pattern (webhook-api.ts): `resolveOwner` then `refuseOwner`, a per-key limiter on the writes,
 * `express.json({ limit: '4kb' })`, a 500 that names nothing. The owner is `profileKeyOf` — the store's one answer,
 * which the reader uses too — so a credential manages exactly the profile its checks read: a keyless caller, an x402
 * payment and an OAuth access token get the existing refuseOwner body. No route names a profile; the key is the
 * only address, so no key reaches another's.
 *
 * The body is judged by the `rules` param's own zod object (`PRE_TRADE_CHECK_SCHEMA.rules`, projected from
 * `PRE_TRADE_RULE_PROPERTIES`): what the param refuses, PUT refuses. A refusal is named in `parseRules`' words — the
 * handler's sentence for the same mistake — except a null value, which parseRules reads as "not sent" and the param
 * refuses; that one is named by the param's own issue.
 */
import express, { type Express, type Request, type RequestHandler, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { refuseOwner, resolveOwner } from './webhook-api.js';
import { deleteProfile, getProfile, profileKeyOf, profileRefOf, putProfile } from './pre-trade-rule-profiles.js';
import { parseRules, type PreTradeRulesInput } from './pre-trade-rules.js';
import { PRE_TRADE_CHECK_SCHEMA } from '../tools/pre-trade-check.js';

const PATH = '/api/pre-trade-rules';

/** The `rules` param's zod object, required: every key optional, unknown keys refused. */
const RULES_PARAM = PRE_TRADE_CHECK_SCHEMA.rules.unwrap();

const RULES_ACTION = `Send a JSON object of rule keys, each within its bounds: ${Object.keys(RULES_PARAM.shape).join(', ')}.`;

type Judged = { ok: true; rules: PreTradeRulesInput } | { ok: false; param: string; error: string };

/** A PUT body: accepted iff the rules param accepts it, else the key it fails on, named. */
function judgeRules(body: unknown): Judged {
  const verdict = RULES_PARAM.safeParse(body);
  const named = parseRules(body);
  if (verdict.success && named.ok) return { ok: true, rules: named.rules };
  if (!named.ok) return { ok: false, param: named.param, error: named.message };
  // The param refused what parseRules let pass: a null value.
  const issue = verdict.success ? undefined : verdict.error.issues[0];
  const param = ['rules', ...(issue?.path ?? [])].join('.');
  return { ok: false, param, error: `${param}: ${issue?.message ?? 'not accepted'}.` };
}

function invalidRules(res: Response, param: string, error: string, suggested_action = RULES_ACTION): Response {
  return res.status(400).json({ ok: false, code: 'invalid_rules', param, error, suggested_action });
}

function internalError(res: Response, method: string, err: unknown): Response {
  console.error(`[${PATH} ${method}] internal error:`, err instanceof Error ? err.message : err);
  return res.status(500).json({ ok: false, code: 'internal_error', error: 'internal error' });
}

/** The caller's profile ref, or null once refuseOwner has answered: only a credential whose checks read a profile owns one. */
async function ownerRef(req: Request, res: Response): Promise<string | null> {
  const { license } = await resolveOwner(req);
  const key = profileKeyOf(license);
  if (key === null) {
    refuseOwner(res, license, 'An API key is required.');
    return null;
  }
  return profileRefOf(key);
}

/** The writer a limit counts against: the Bearer value when one is sent, else the IPv6-safe IP (as webhooks' test limiter). */
function writerOf(req: Request): string {
  const auth = req.headers.authorization;
  const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return bearer || ipKeyGenerator(req.ip ?? 'unknown');
}

export function registerPreTradeRulesRoutes(app: Express): void {
  // 10 writes a minute per key; reads are not limited.
  const writeLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: writerOf,
  }) as RequestHandler;

  // The JSON parser records how many bytes it read: a missing body, an empty one or one of another type reads as {}
  // to the handler, and saving {} would quietly clear the profile — so PUT refuses a body the parser never read.
  const rulesBody = express.json({
    limit: '4kb',
    verify: (_req, res, buf) => { (res as Response).locals.rulesBodyBytes = buf.length; },
  });

  // PUT — save the rules object, replacing the profile.
  app.put(PATH, writeLimiter, rulesBody, async (req: Request, res: Response) => {
    try {
      const ref = await ownerRef(req, res);
      if (ref === null) return;
      if (!res.locals.rulesBodyBytes) {
        return invalidRules(res, 'rules', 'The body must be the rules object, sent as JSON.',
          'Send a JSON object of rule keys with Content-Type: application/json; send {} to save none, or DELETE to clear them.');
      }
      const judged = judgeRules(req.body);
      if (!judged.ok) return invalidRules(res, judged.param, judged.error);
      const saved = await putProfile(ref, judged.rules);
      return res.json({ ok: true, rules: saved.rules, updated_at: saved.updatedAt });
    } catch (err) {
      return internalError(res, 'PUT', err);
    }
  });

  // GET — the saved rules: {} and null when none.
  app.get(PATH, async (req: Request, res: Response) => {
    try {
      const ref = await ownerRef(req, res);
      if (ref === null) return;
      const saved = await getProfile(ref);
      return res.json({ ok: true, rules: saved?.rules ?? {}, updated_at: saved?.updatedAt ?? null });
    } catch (err) {
      return internalError(res, 'GET', err);
    }
  });

  // DELETE — clear the saved rules.
  app.delete(PATH, writeLimiter, async (req: Request, res: Response) => {
    try {
      const ref = await ownerRef(req, res);
      if (ref === null) return;
      return res.json({ ok: true, deleted: await deleteProfile(ref) });
    } catch (err) {
      return internalError(res, 'DELETE', err);
    }
  });
}
