/**
 * TG-SIGNIN-W1-R2 CH2 — the one-time Telegram sign-in token.
 *
 * WHAT IT IS. A buyer who pays from the bot's plan buttons (the Checkout Session's `metadata.utm_source` is
 * `tg_bot`) lands on /welcome, whose reveal arm shows the key once (`key-reveal.ts`). On that arm only — the
 * claim CLAIMED, tier starter or pro, an email — `mintSigninToken` mints ONE token, `tgl_` + 32 lowercase hex
 * (16 random bytes, 128 bits), stores its sha256, and the page puts it on the Open Telegram button
 * (`https://t.me/algovaultofficialbot?start=tgl_<token>`, §Copy W1). The bot redeems it through
 * `POST /api/bot/signin-token/redeem` and signs in the private chat that opened the link. A plan link copied
 * from someone else's chat carries no token, so it can never sign that chat in with the payer's key: the token
 * is shown to the payer alone, beside the key, and it works once.
 *
 * WHAT IT NEVER HOLDS. No api key column and no chat id. The redeem reads the customer's CURRENT key by id
 * (`getApiKeyByCustomerId` — `customers.retrieve`, read-after-write consistent, never search, which lags the
 * minute right after purchase), and the raw token lives only in the page and in the bot's `/start` message: the
 * table keys on its hash.
 *
 * THE REDEEM. Behind `checkBotInternalAuth` (validate-key's two-flag firewall, byte-identical 401/403), with
 * `Cache-Control: no-store` set before auth and nothing read before auth. A bad shape, an unknown, redeemed or
 * expired token → 200 `{ok:false}` with no Stripe call. Otherwise the key read, bounded at 5 s AS A WHOLE (over
 * it → 503 and the token stays unspent); a key → `redeemed_at` is set only where it is still NULL, so of two
 * concurrent redeems exactly one gets the key and the other `{ok:false}`; a deleted or keyless customer spends
 * the token and answers `{ok:false}`; a Stripe error → 503 and the token stays redeemable.
 *
 * SCHEMA. `migrations/057_tg_signin_tokens.sql` IS the Postgres half of `tgSigninTokensDdl`, statement for
 * statement (pinned by tests/unit/tg-signin-tokens-pglite.test.ts). The lazy ensure runs those statements once
 * per process, AWAITED on both backends, before the first read or write. The SQLite half differs in its types
 * and default only. Timestamps are written as ISO strings from one clock, so the SQL is the same on both.
 *
 * LOGS carry the row id, the tier and an error's class only — never the token, the key or the email.
 */
import { createHash, randomBytes } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { checkBotInternalAuth } from './bot-auth.js';
import { dbExec, dbQuery, isPgBackend } from './performance-db.js';
import { getApiKeyByCustomerId, type CustomerKeyRead } from './stripe.js';
import { maskEmail } from './email.js';

/** Build Rule 4: `tgl_` + 32 lowercase hex. Hex has no `-`, so the bot's `-src_` split never touches it. */
const SIGNIN_TOKEN_RE = /^tgl_[0-9a-f]{32}$/;
export const REDEEM_PATH = '/api/bot/signin-token/redeem';
/** R2.2: a token expires 24 h after it is minted. */
export const SIGNIN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** R2.4 + lead ruling 11:05: the redeem's WHOLE Stripe read is bounded at 5 s. */
export const STRIPE_READ_TIMEOUT_MS = 5_000;

/** R2.3 + lead ruling 11:05: a token is minted for these plans only. */
export type SigninTier = 'starter' | 'pro';
const isSigninTier = (tier: unknown): tier is SigninTier => tier === 'starter' || tier === 'pro';

/** The ONE shape check for a sign-in token, used by the redeem before it reads anything. */
export function isSigninToken(value: unknown): value is string {
  return typeof value === 'string' && SIGNIN_TOKEN_RE.test(value);
}

/** R2.2: the stored key — sha256 hex of the full token. */
export function hashSigninToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** One `tg_signin_tokens` row as the redeem reads it. `id` is a string when Postgres returns a BIGSERIAL. */
interface SigninTokenRow {
  id: number | string;
  customer_id: string;
  tier: string;
  email_masked: string;
  expires_at: string | Date;
  redeemed_at: string | Date | null;
}

/**
 * The table's DDL for one dialect. The Postgres statement IS migrations/057; the SQLite one differs in the id
 * type, the timestamp type and the default only. No api key column and no chat id, ever.
 */
export function tgSigninTokensDdl(pg: boolean): string[] {
  const ID = pg ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const TS = pg ? 'TIMESTAMPTZ' : 'TIMESTAMP';
  const NOW = pg ? 'now()' : "(datetime('now'))";
  return [
    `CREATE TABLE IF NOT EXISTS tg_signin_tokens (
  id           ${ID},
  token_hash   TEXT NOT NULL UNIQUE,
  customer_id  TEXT NOT NULL,
  tier         TEXT NOT NULL,
  email_masked TEXT NOT NULL,
  created_at   ${TS} NOT NULL DEFAULT ${NOW},
  expires_at   ${TS} NOT NULL,
  redeemed_at  ${TS}
)`,
  ];
}

let ensuring: Promise<void> | null = null;

/**
 * Create the table once per process and AWAIT it on both backends (the `key-reveal.ts` idiom): on Postgres
 * `dbExec` is fire-and-forget, so its caller could never see a failure; on SQLite `dbQuery` cannot run DDL
 * (better-sqlite3's `all()` refuses a statement that returns no rows). Concurrent first callers share one
 * in-flight ensure, and a failed one is dropped so the next call retries it.
 */
function ensureTgSigninTokens(): Promise<void> {
  if (!ensuring) {
    const attempt = (async () => {
      const pg = isPgBackend();
      const statements = tgSigninTokensDdl(pg);
      if (pg) {
        for (const sql of statements) await dbQuery(sql);
      } else {
        dbExec(statements.join(';\n'));
      }
    })();
    ensuring = attempt;
    attempt.catch(() => {
      if (ensuring === attempt) ensuring = null;
    });
  }
  return ensuring;
}

/** Test seam: re-arm the once-per-process ensure (module-level-cache reset idiom). */
export function _resetTgSigninTokensForTest(): void {
  ensuring = null;
}

const errClass = (err: unknown): string => (err instanceof Error ? err.name : typeof err).slice(0, 60);

// ── R2.3: mint, on the reveal arm ────────────────────────────────────────────────────────────────

/** Who may be handed a token: a Telegram checkout's revealed session, a starter or pro plan, an email. */
export interface SigninTokenGrant {
  customerId: string;
  tier: SigninTier;
  email: string;
}

/**
 * R2.3 — the ONE eligibility rule, judged on the session `revealKeyOnce` has just claimed. A token is due only
 * for a checkout from the bot (`fromTelegram`), a starter or pro plan, an email to mask and a customer to read
 * the key from. Anything else → null: the page keeps today's `auth_` Connect button.
 */
export function signinTokenGrant(session: {
  fromTelegram?: unknown;
  tier?: unknown;
  email?: unknown;
  customerId?: unknown;
}): SigninTokenGrant | null {
  if (session.fromTelegram !== true) return null;
  if (!isSigninTier(session.tier)) return null;
  if (typeof session.email !== 'string' || session.email.length === 0) return null;
  if (typeof session.customerId !== 'string' || session.customerId.length === 0) return null;
  return { customerId: session.customerId, tier: session.tier, email: session.email };
}

/**
 * Mint one token, store its hash, and return the token. NEVER THROWS: any failure is logged (no token, no
 * email) and returned as null, so the page shows today's `auth_` button and the reveal itself is unaffected.
 */
export async function mintSigninToken(grant: SigninTokenGrant, now: Date = new Date()): Promise<string | null> {
  try {
    const token = `tgl_${randomBytes(16).toString('hex')}`;
    await ensureTgSigninTokens();
    const rows = await dbQuery<{ id: number | string }>(
      `INSERT INTO tg_signin_tokens (token_hash, customer_id, tier, email_masked, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING id`,
      [
        hashSigninToken(token),
        grant.customerId,
        grant.tier,
        maskEmail(grant.email),
        now.toISOString(),
        new Date(now.getTime() + SIGNIN_TOKEN_TTL_MS).toISOString(),
      ],
    );
    if (rows.length !== 1) throw new Error(`the token insert returned ${rows.length} rows`);
    console.log(`[tg-signin-tokens] minted: token ${rows[0].id} (${grant.tier})`);
    return token;
  } catch (err) {
    console.error(`[tg-signin-tokens] mint failed (${errClass(err)}) — the page keeps the auth_ button`);
    return null;
  }
}

// ── R2.4: redeem ─────────────────────────────────────────────────────────────────────────────────

/** The redeem route's body — the ALLOW-list: nothing from the row or from Stripe leaves beyond these keys. */
export type RedeemResponse = { ok: true; api_key: string; tier: SigninTier; email_masked: string } | { ok: false };

/**
 * The ONE formatter for a redeem answer. The success shape is emitted only with a non-empty key, a starter or
 * pro tier and a non-empty masked email — exactly what the bot's client accepts as OK; anything else is
 * `{ok:false}`. `ok` is always a boolean.
 */
export function formatRedeemResponse(r: { apiKey: unknown; tier: unknown; emailMasked: unknown }): RedeemResponse {
  if (typeof r.apiKey !== 'string' || r.apiKey.length === 0) return { ok: false };
  if (!isSigninTier(r.tier)) return { ok: false };
  if (typeof r.emailMasked !== 'string' || r.emailMasked.length === 0) return { ok: false };
  return { ok: true, api_key: r.apiKey, tier: r.tier, email_masked: r.emailMasked };
}

export type RedeemOutcome =
  | { status: 200; body: RedeemResponse }
  | { status: 503; body: { ok: false; error: 'stripe_unavailable' } };

const NOT_REDEEMABLE: RedeemOutcome = { status: 200, body: { ok: false } };

class StripeReadTimeout extends Error {
  constructor(ms: number) {
    super(`the key read took over ${ms} ms`);
    this.name = 'StripeReadTimeout';
  }
}

/** Settle `work` within `ms` or reject. A late answer is dropped: nothing is spent on it. */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new StripeReadTimeout(ms)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Spend a token: `redeemed_at` is set only where it is still NULL. True for the one caller that set it. */
async function spend(id: number | string, at: Date): Promise<boolean> {
  const rows = await dbQuery<{ id: number | string }>(
    'UPDATE tg_signin_tokens SET redeemed_at = ? WHERE id = ? AND redeemed_at IS NULL RETURNING id',
    [at.toISOString(), id],
  );
  return rows.length > 0;
}

/**
 * R2.4 — redeem one token. Database errors propagate (the route answers 500 and nothing is spent); a Stripe
 * failure or a read over 5 s is a 503 with the token unspent.
 */
export async function redeemSigninToken(token: unknown, now: () => number = Date.now): Promise<RedeemOutcome> {
  if (!isSigninToken(token)) return NOT_REDEEMABLE;
  await ensureTgSigninTokens();
  const [row] = await dbQuery<SigninTokenRow>(
    'SELECT id, customer_id, tier, email_masked, expires_at, redeemed_at FROM tg_signin_tokens WHERE token_hash = ?',
    [hashSigninToken(token)],
  );
  if (!row || row.redeemed_at !== null) return NOT_REDEEMABLE;
  // NaN (an unreadable stamp) compares false, so it reads as expired: fail closed.
  if (!(new Date(row.expires_at).getTime() > now())) return NOT_REDEEMABLE;
  // Minted rows always carry a starter/pro tier and a masked email; a row without them can never be answered OK.
  if (!isSigninTier(row.tier) || typeof row.email_masked !== 'string' || row.email_masked.length === 0) return NOT_REDEEMABLE;

  let read: CustomerKeyRead;
  try {
    read = await within(getApiKeyByCustomerId(row.customer_id), STRIPE_READ_TIMEOUT_MS);
  } catch (err) {
    console.warn(`[tg-signin-tokens] token ${row.id} left unspent — its key read failed (${errClass(err)})`);
    return { status: 503, body: { ok: false, error: 'stripe_unavailable' } };
  }

  if (!(await spend(row.id, new Date(now())))) return NOT_REDEEMABLE; // a concurrent redeem won it
  if (read.kind !== 'key') {
    // A deleted customer, or one with no key, can never be signed in: the token is spent, the answer {ok:false}.
    console.warn(`[tg-signin-tokens] token ${row.id} spent without a key — its customer ${read.kind === 'deleted' ? 'is deleted' : 'carries no key'}`);
    return NOT_REDEEMABLE;
  }
  console.log(`[tg-signin-tokens] redeemed: token ${row.id} (${row.tier})`);
  return { status: 200, body: formatRedeemResponse({ apiKey: read.apiKey, tier: row.tier, emailMasked: row.email_masked }) };
}

/** Every response is `no-store` (a success carries a key); nothing is parsed, read or asked before auth. */
function refuseUnauthenticated(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  const auth = checkBotInternalAuth(req.headers as Record<string, string | undefined>);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }
  next();
}

const parseRedeemBody = express.json({ limit: '1kb' });

/**
 * R2.4 — `POST /api/bot/signin-token/redeem`, body `{token}`. A registrar rather than inline in index.ts
 * because index.ts boots the server at import, which would leave the handler untestable (the
 * `entitlement-api.ts` precedent).
 */
export function registerSigninTokenRoutes(app: Express): void {
  app.post(
    REDEEM_PATH,
    refuseUnauthenticated,
    parseRedeemBody,
    async (req: Request, res: Response) => {
      try {
        const body = req.body as { token?: unknown } | null | undefined;
        const outcome = await redeemSigninToken(body && typeof body === 'object' ? body.token : undefined);
        return res.status(outcome.status).json(outcome.body);
      } catch (err) {
        console.error(`[${REDEEM_PATH}] error (${errClass(err)}) — nothing spent`);
        return res.status(500).json({ ok: false, error: 'internal_error' });
      }
    },
    // A body that is not JSON, or over 1 kB, carries no readable token: the same answer as a bad shape.
    (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const status = (err as { status?: unknown } | null)?.status;
      if (typeof status === 'number' && status >= 400 && status < 500) return res.status(200).json({ ok: false });
      console.error(`[${REDEEM_PATH}] error (${errClass(err)}) — nothing spent`);
      return res.status(500).json({ ok: false, error: 'internal_error' });
    },
  );
}
