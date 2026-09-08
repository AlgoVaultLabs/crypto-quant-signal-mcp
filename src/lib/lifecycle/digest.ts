/**
 * IDENTITY-LIFECYCLE-W3 CH4 R1 — the product-updates digest.
 *
 * The opt-in checkbox has said "Also email me product updates (~1/mo, optional)" since it
 * shipped, and MEASURED 2026-09-08 it has never sent one. Six people consented and got nothing.
 * This is the smallest thing that makes that promise true.
 *
 * THE BODY IS THE README, CONVERTED VERBATIM. No new prose, because there is no second author:
 * `## What's new in vX.Y.0` is already the canonical release copy that goes through public-copy
 * LAW at release time, and rewriting it for email would create a second version of the same
 * claims — the drift class this estate keeps paying for. The only sentence this module adds is
 * the consent line, restating what the checkbox took.
 *
 * PERIOD KEY IS THE VERSION, NOT THE MONTH. `lifecycle_sends(product_updates, period=v1.29.0)`
 * means a block is sent once, ever, per recipient — so a month with two releases sends both in
 * ONE email (they batch) and a month with none sends nothing, rather than a monthly cron
 * manufacturing an empty "what's new".
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dbQuery } from '../performance-db.js';
import { ensureLifecycleSchema } from './schema.js';

export interface WhatsNewBlock {
  /** `v1.29.0` — the period key. */
  version: string;
  /** Markdown body, excluding the heading. */
  markdown: string;
}

/**
 * Parse the `## What's new in vX.Y.0` blocks out of the README.
 *
 * Recap sub-sections (`### vX.Y.x highlights (recap)`) are DELIBERATELY excluded: they are a
 * rolling window the release process trims to the three most recent minors, so mailing them
 * would re-send content a reader already had, every month, for three months.
 */
export function parseWhatsNew(readme: string): WhatsNewBlock[] {
  const out: WhatsNewBlock[] = [];
  const re = /^## What's new in (v\d+\.\d+\.\d+)\s*$/gm;
  const heads: { version: string; start: number; headEnd: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(readme)) !== null) {
    heads.push({ version: m[1], start: m.index, headEnd: m.index + m[0].length });
  }
  for (let i = 0; i < heads.length; i += 1) {
    const body = readme.slice(heads[i].headEnd, heads[i + 1]?.start ?? readme.length);
    // Stop at the first `###` recap or the next `##` of any kind.
    const cut = body.search(/^#{2,3} /m);
    out.push({ version: heads[i].version, markdown: (cut === -1 ? body : body.slice(0, cut)).trim() });
  }
  return out;
}

export function readReadmeBlocks(repoRoot: string = process.cwd()): WhatsNewBlock[] {
  try {
    return parseWhatsNew(readFileSync(join(repoRoot, 'README.md'), 'utf8'));
  } catch {
    // An unreadable README means we cannot tell what is new. Sending nothing is the only honest
    // outcome; inventing a digest from an empty parse would mail a blank "what's new".
    return [];
  }
}

/** Minimal, deliberate markdown→HTML. Not a library: the input is one authored block. */
export function markdownToEmailHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) => esc(s)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" style="color:#0969da;text-decoration:none">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code style="background:#f6f8fa;padding:1px 4px;border-radius:3px">$1</code>');

  const out: string[] = [];
  let inList = false;
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { out.push('<ul style="margin:0 0 14px;padding-left:20px">'); inList = true; }
      out.push(`<li style="font-size:15px;line-height:1.55;color:#1f2328;margin:0 0 6px">${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    if (!line.trim()) continue;
    out.push(`<p style="font-size:15px;line-height:1.55;color:#1f2328;margin:0 0 14px">${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

export function markdownToEmailText(md: string): string {
  // Strip the emphasis MARKERS. A plain-text email that renders `**Something shipped**` shows the
  // asterisks to the reader — the markdown source leaking into the message. Links become
  // `label (url)` so the destination survives in a client that shows no HTML.
  return md.split('\n')
    .map((l) => l.replace(/^\s*[-*]\s+/, '• '))
    .map((l) => l
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1'))
    .join('\n').trim();
}

/** Which versions have ALREADY been mailed to this recipient. */
export async function sentVersionsFor(recipientId: string): Promise<Set<string>> {
  ensureLifecycleSchema();
  const rows = await dbQuery<{ period_key: string }>(
    `SELECT period_key FROM lifecycle_sends
      WHERE step = 'product_updates' AND recipient_id = ?
        AND status IN ('sent','would_send')`, [recipientId],
  );
  return new Set(rows.map((r) => r.period_key));
}

/** The active opt-in list: consented, not unsubscribed. */
export async function optInRecipients(): Promise<{ recipientId: string; email: string }[]> {
  try {
    const rows = await dbQuery<{ id: number | string; email: string }>(
      `SELECT id, email FROM signup_emails
        WHERE unsubscribed_at IS NULL AND optin_consent = ${process.env.DATABASE_URL ? 'TRUE' : '1'}`,
    );
    // The recipient id is the OPT-IN ROW, not the address and not a key: this list is a separate
    // consent from the usage steps, and keying it on the row keeps the two ledgers from
    // colliding for the six people (measured) who are on both.
    return rows.map((r) => ({ recipientId: `optin:${r.id}`, email: r.email }));
  } catch {
    return [];
  }
}

/** `September 2026` — the digest's subject suffix. */
export function digestPeriodLabel(now: Date = new Date()): string {
  return now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
