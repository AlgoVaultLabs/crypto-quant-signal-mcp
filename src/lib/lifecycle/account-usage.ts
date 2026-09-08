/**
 * IDENTITY-LIFECYCLE-W3 CH3 R3 — the `/account` usage page and its email preference.
 *
 * The numbers come from `readMeters`, the CH2 read-only snapshot — the SAME derivation the
 * envelope and the step predicates use. Deliberately NOT `checkQuotaByKey`: that materialises a
 * tracker and RESTARTS an expired window, so a usage page built on it would reset the very quota
 * it is rendering. One derivation, and the one that does not mutate.
 *
 * ENUMERATION-SAFE. An unknown key renders the same shaped page as a known key with no usage, so
 * the response cannot be used to test whether a key exists — the discipline the recovery panel
 * already follows ("same response whether or not the email is on file").
 */
import { dbQuery } from '../performance-db.js';
import { readMeters, primeMeter } from './meter.js';
import { hashEmail, maskKey, preferenceToken, verifyPreferenceToken } from './identity.js';
import { addSuppression, clearPreferenceSuppression, listSuppressions } from './suppression.js';
import { FREE_DAILY_CALLS } from '../plans.js';
import {
  ACCOUNT_USAGE_HEADING, ACCOUNT_PREFERENCE_LABEL, accountMonthlyRow, accountDailyRow,
  FOOTER_BRAND,
} from '../lifecycle-copy.js';

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

interface KeyRow { api_key: string; email: string | null; bucket_key: string | null }

/**
 * FAIL-SOFT, and safe to be: an unreadable table renders the same neutral page as an unknown key.
 *
 * That keeps the enumeration-safety property true under FAILURE as well as under success — a
 * page that 500s for unknown keys and renders for known ones is an oracle, whatever it says.
 * Degrading here is safe only because the SEND path is independently fail-closed: `isSuppressed`
 * returns TRUE when it cannot read the suppression list, so a database problem can make this page
 * show an optimistic toggle but can never cause an email.
 */
async function lookupKey(apiKey: string): Promise<KeyRow | null> {
  try {
    const rows = await dbQuery<KeyRow>(
      'SELECT api_key, email, bucket_key FROM free_keys WHERE api_key = ?', [apiKey],
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/** Today's UTC usage for a bucket, read-only. Null when the key has no daily row. */
async function dailyUsedFor(trackerKey: string): Promise<number | null> {
  let rows: { daily_count: number | string; daily_day: string | null }[];
  try {
    rows = await dbQuery<{ daily_count: number | string; daily_day: string | null }>(
      'SELECT daily_count, daily_day FROM quota_usage WHERE tracker_key = ?', [trackerKey],
    );
  } catch { return null; }
  const r = rows[0];
  if (!r || !r.daily_day) return null;
  // A stale `daily_day` means the counter belongs to a previous UTC day and today's is zero.
  // Reporting the stale number would tell somebody they had used calls they had not.
  const today = new Date().toISOString().slice(0, 10);
  return String(r.daily_day).slice(0, 10) === today ? Number(r.daily_count) || 0 : 0;
}

/** Is the usage-step preference currently ON for this key's address? */
export async function usagePreferenceEnabled(email: string | null): Promise<boolean> {
  if (!email) return true; // default ON for account holders (C3)
  const rows = await listSuppressions(hashEmail(email));
  // Only the `preference` row governs the toggle. A bounce/complaint/unsubscribe also stops the
  // mail, but it is NOT the toggle's state and must not render as "you turned this off".
  return !rows.some((r) => r.reason === 'preference' && r.step_scope === 'usage');
}

/** Apply the toggle. ON deletes ONLY the preference row; OFF writes one. */
/** Resolve a preference handle back to its key, or null. Exported for the route handler. */
export function keyFromPreferenceToken(token: string): string | null {
  return verifyPreferenceToken(token);
}

export async function setUsagePreference(apiKey: string, enabled: boolean): Promise<void> {
  const row = await lookupKey(apiKey);
  if (!row?.email) return; // nothing to suppress for a key with no address on file
  const h = hashEmail(row.email);
  if (enabled) await clearPreferenceSuppression(h);
  else await addSuppression({ emailHash: h, reason: 'preference', scope: 'usage', source: 'account-toggle' });
}

export async function renderUsagePage(apiKey: string, notice?: string): Promise<string> {
  await primeMeter();
  const row = await lookupKey(apiKey);
  const trackerKey = row ? (row.bucket_key || row.api_key) : apiKey;
  const meters = await readMeters([trackerKey]);
  const m = meters.get(trackerKey);
  const dailyUsed = await dailyUsedFor(trackerKey);
  const prefOn = await usagePreferenceEnabled(row?.email ?? null);

  const used = m?.used ?? 0;
  const total = m?.total ?? 0;
  const resetDate = m?.resetDate ?? null;

  // No live period is a real state, not an error: the window expired or the key has never been
  // used. Saying so beats rendering `0 / 200 · resets —`, which reads like a bug.
  const monthly = resetDate
    ? accountMonthlyRow(used, total, resetDate)
    : `This month: 0 / ${total} · no calls yet, so no window has started`;
  const daily = dailyUsed === null
    ? `Today: 0 / ${FREE_DAILY_CALLS} · resets 00:00 UTC`
    : accountDailyRow(dailyUsed, FREE_DAILY_CALLS);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${esc(ACCOUNT_USAGE_HEADING)}</title></head>` +
    `<body style="margin:0;padding:48px 24px;background:#0d1117;color:#e6edf3;` +
    `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">` +
    `<div style="max-width:520px;margin:0 auto">` +
    `<h1 style="font-size:20px;margin:0 0 4px">${esc(ACCOUNT_USAGE_HEADING)}</h1>` +
    `<p style="font-size:13px;color:#8b949e;margin:0 0 20px">${esc(maskKey(apiKey))}</p>` +
    (notice ? `<p style="font-size:13px;color:#3fb950;margin:0 0 16px">${esc(notice)}</p>` : '') +
    `<p style="font-size:15px;margin:0 0 6px">${esc(monthly)}</p>` +
    `<p style="font-size:15px;margin:0 0 24px">${esc(daily)}</p>` +
    `<form method="post" action="/account/usage/preference">` +
    // An opaque signed handle, NEVER the key: the secret must not appear in rendered HTML.
    `<input type="hidden" name="t" value="${esc(preferenceToken(apiKey))}">` +
    `<label style="font-size:14px;display:flex;gap:8px;align-items:center">` +
    `<input type="checkbox" name="enabled"${prefOn ? ' checked' : ''}> ` +
    `<span>${esc(ACCOUNT_PREFERENCE_LABEL)}</span></label>` +
    `<button type="submit" style="margin-top:14px;background:#238636;color:#fff;border:0;` +
    `border-radius:6px;padding:9px 16px;font-size:14px;cursor:pointer">Save</button></form>` +
    `<p style="font-size:12px;color:#8b949e;margin-top:28px">${esc(FOOTER_BRAND)} · ` +
    `<a href="/account" style="color:#8b949e">Back to account</a></p>` +
    `</div></body></html>`;
}
