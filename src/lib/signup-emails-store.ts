/**
 * POWER-USER-OUTREACH-W1-V2 (2026-05-28): signup_emails store.
 *
 * Wraps free-tier email opt-in capture via the /welcome paywall CTA.
 * Mirrors src/lib/stripe-events-store.ts shape (idempotency via the sibling
 * processed_signup_email_events table). Tables are created by performance-db's
 * getBackend() — this module just provides typed read/write helpers.
 *
 * Schema (CREATE TABLE IF NOT EXISTS lives in src/lib/performance-db.ts):
 *   signup_emails:
 *     id                   BIGSERIAL PK
 *     email                TEXT NOT NULL UNIQUE
 *     source               TEXT NOT NULL  ('welcome-paywall' / 'outreach-reply' / 'manual')
 *     optin_consent        BOOLEAN NOT NULL DEFAULT TRUE
 *     optin_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *     confirmation_sent_at TIMESTAMPTZ NULL
 *     unsubscribed_at      TIMESTAMPTZ NULL
 *
 *   processed_signup_email_events:
 *     event_id     TEXT PK   ('signup-email:<sha256(email)>:<epoch>')
 *     event_type   TEXT
 *     processed_at TIMESTAMPTZ DEFAULT NOW()
 */
import crypto from 'crypto';
import { dbRun, dbQuery } from './performance-db.js';

export interface SignupEmailRow {
  email: string;
  // REFERRAL-FREE-KEY-SIGNUP-W1: 'referral-page' = the /referral free-account form.
  source: 'welcome-paywall' | 'outreach-reply' | 'manual' | 'referral-page';
  optin_consent: boolean;
}

export interface SignupEmailRecord {
  id: number;
  email: string;
  source: string;
  optin_consent: boolean;
  optin_at: string;
  confirmation_sent_at: string | null;
  unsubscribed_at: string | null;
}

/**
 * Upsert a signup-email opt-in.
 *
 * - First time the email arrives: INSERT new row, return `{ inserted: true }`.
 * - Repeat opt-in for the same email: UPDATE optin_at + clear unsubscribed_at,
 *   return `{ inserted: false }`. (Idempotency belongs to the caller via
 *   `tryClaimSignupEmailEvent` below — this function is just the upsert path.)
 *
 * PG uses ON CONFLICT; SQLite uses ON CONFLICT (3.24+) — both supported.
 */
export async function upsertSignupEmail(row: SignupEmailRow): Promise<{ inserted: boolean }> {
  const existing = await dbQuery<{ id: number }>(
    'SELECT id FROM signup_emails WHERE email = ?',
    [row.email],
  );

  if (existing.length > 0) {
    // Already opted in — refresh timestamp + clear any prior unsubscribe.
    if (process.env.DATABASE_URL) {
      dbRun(
        'UPDATE signup_emails SET optin_at = NOW(), optin_consent = ?, source = ?, unsubscribed_at = NULL WHERE email = ?',
        row.optin_consent,
        row.source,
        row.email,
      );
    } else {
      dbRun(
        "UPDATE signup_emails SET optin_at = datetime('now'), optin_consent = ?, source = ?, unsubscribed_at = NULL WHERE email = ?",
        row.optin_consent ? 1 : 0,
        row.source,
        row.email,
      );
    }
    return { inserted: false };
  }

  if (process.env.DATABASE_URL) {
    dbRun(
      'INSERT INTO signup_emails (email, source, optin_consent) VALUES (?, ?, ?)',
      row.email,
      row.source,
      row.optin_consent,
    );
  } else {
    dbRun(
      'INSERT INTO signup_emails (email, source, optin_consent) VALUES (?, ?, ?)',
      row.email,
      row.source,
      row.optin_consent ? 1 : 0,
    );
  }
  return { inserted: true };
}

export async function markConfirmationSent(email: string): Promise<void> {
  if (process.env.DATABASE_URL) {
    dbRun(
      'UPDATE signup_emails SET confirmation_sent_at = NOW() WHERE email = ?',
      email,
    );
  } else {
    dbRun(
      "UPDATE signup_emails SET confirmation_sent_at = datetime('now') WHERE email = ?",
      email,
    );
  }
}

export async function getSignupEmail(email: string): Promise<SignupEmailRecord | null> {
  const rows = await dbQuery<SignupEmailRecord>(
    'SELECT id, email, source, optin_consent, optin_at, confirmation_sent_at, unsubscribed_at FROM signup_emails WHERE email = ?',
    [email],
  );
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Idempotency claim — returns true if this is a new (email, action) tuple
 * within the de-dup window; false if it's already been processed.
 *
 * event_id format: `signup-email:<sha256(email)>:<unix-epoch-seconds>` — the
 * epoch suffix means each opt-in event is unique per second, so retries WITHIN
 * the same second dedupe (caller-burst protection) but distinct opt-ins
 * (legitimate re-subscriptions hours/days apart) are NEW events.
 *
 * For the typical flow (one POST → one upsert → one confirmation email), the
 * caller computes event_id once and claims-then-sends.
 */
export async function tryClaimSignupEmailEvent(
  email: string,
  eventType: 'optin' | 'unsubscribe',
): Promise<{ claimed: boolean; eventId: string }> {
  const hash = crypto.createHash('sha256').update(email).digest('hex').slice(0, 16);
  const eventId = `signup-email:${hash}:${Math.floor(Date.now() / 1000)}`;

  const existing = await dbQuery<{ event_id: string }>(
    'SELECT event_id FROM processed_signup_email_events WHERE event_id = ?',
    [eventId],
  );
  if (existing.length > 0) return { claimed: false, eventId };

  try {
    dbRun(
      'INSERT INTO processed_signup_email_events (event_id, event_type) VALUES (?, ?)',
      eventId,
      eventType,
    );
    return { claimed: true, eventId };
  } catch {
    // Race with concurrent caller; either way, NOT new from this fiber.
    return { claimed: false, eventId };
  }
}

export async function getSignupEmailCount(): Promise<number> {
  const rows = await dbQuery<{ count: string }>(
    'SELECT COUNT(*) as count FROM signup_emails WHERE unsubscribed_at IS NULL',
    [],
  );
  return rows.length > 0 ? Number(rows[0].count) : 0;
}
