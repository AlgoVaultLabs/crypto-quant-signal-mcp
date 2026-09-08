/**
 * IDENTITY-LIFECYCLE-W3 CH4 R1 — the monthly product-updates digest.
 *
 * Sends the README `## What's new in vX.Y.0` blocks a recipient has not already had, converted
 * verbatim. Same engine, same suppression, same caps, same shadow/live discipline as the four
 * usage steps — it is a fifth step, not a second mailer.
 *
 * WHY IT IS NOT REGISTERED IN THE 15-MINUTE DISPATCHER. Its cadence is its own: monthly, on the
 * first Tuesday. Registering it there would make the digest a function of the dispatcher's
 * schedule rather than of the release cadence, and would put a "what's new" evaluation in front
 * of the ledger 96 times a day for a message that can be sent at most once a month.
 *
 * Exit contract: LIFECYCLE_DIGEST_VERDICT=PASS|FAIL|INDETERMINATE -> 0 / 1 / 3.
 */
import { runScript } from '../lib/script-lifecycle.js';
import { awaitDbWrites } from '../lib/performance-db.js';
import { ensureLifecycleSchema } from '../lib/lifecycle/schema.js';
import { sendLifecycle, resolveMode } from '../lib/lifecycle/engine.js';
import { getStepState, stampHeartbeat } from '../lib/lifecycle/ledger.js';
import {
  readReadmeBlocks, optInRecipients, sentVersionsFor,
  markdownToEmailHtml, markdownToEmailText, digestPeriodLabel,
} from '../lib/lifecycle/digest.js';
import { mcpConfigSnippet } from '../lib/lifecycle-copy.js';

const TAG = '[product-updates-digest]';

async function emit(verdict: 'PASS' | 'FAIL' | 'INDETERMINATE', note: string, eligible = 0): Promise<number> {
  try {
    await stampHeartbeat('product-updates-digest', verdict, eligible, new Date(), note.slice(0, 200));
    await awaitDbWrites();
  } catch { console.log(`${TAG} heartbeat stamp failed — verdict still reported below`); }
  console.log(`${TAG} ${new Date().toISOString()} LIFECYCLE_DIGEST_VERDICT=${verdict} ${note}`);
  return verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 3;
}

async function main(): Promise<number> {
  const now = new Date();
  try { ensureLifecycleSchema(); } catch (err) {
    return await emit('INDETERMINATE', `schema unavailable: ${err instanceof Error ? err.message : err}`);
  }
  const mode = resolveMode();
  if (mode === 'off') return await emit('PASS', 'mode=off nothing_evaluated=1');

  const blocks = readReadmeBlocks();
  const recipients = await optInRecipients();

  // BOTH zeros are FACTS, not vacuity: the world builds these corpora. No opt-ins means nobody
  // consented; no blocks means no release carried a "what's new". Reported explicitly so the
  // pass is never a silent one.
  if (blocks.length === 0 || recipients.length === 0) {
    return await emit('PASS', `mode=${mode} blocks=${blocks.length} opt_ins=${recipients.length} nothing_to_send=1`);
  }

  const state = await getStepState('product_updates');
  let wouldSend = 0, sent = 0, suppressed = 0, capped = 0, skipped = 0;

  for (const r of recipients) {
    const already = await sentVersionsFor(r.recipientId);
    const unsent = blocks.filter((b) => !already.has(b.version));
    if (unsent.length === 0) { skipped += 1; continue; }

    // BATCHED INTO ONE MESSAGE. Two releases in a month is one email, not two — the checkbox
    // promised "about one a month" and honouring that is the point of the whole step.
    const html = unsent.map((b) => `<h2 style="font-size:16px;margin:18px 0 8px;color:#1f2328">What's new in ${b.version}</h2>${markdownToEmailHtml(b.markdown)}`).join('\n');
    const text = unsent.map((b) => `What's new in ${b.version}\n\n${markdownToEmailText(b.markdown)}`).join('\n\n');

    // The period key is the NEWEST version in the batch: it is what makes "send each block once"
    // true while still allowing a batch, and it is why a month with no release sends nothing
    // rather than an empty digest.
    const periodKey = unsent[unsent.length - 1].version;

    const res = await sendLifecycle('product_updates',
      { recipientId: r.recipientId, email: r.email, identityBound: true },
      {
        keyMasked: '', used: 0, total: 0, resetDate: '',
        mcpConfigSnippet: mcpConfigSnippet(''),
        digestHtml: html, digestText: text, digestPeriodLabel: digestPeriodLabel(now),
        periodKey,
      },
      { now });

    switch (res.status) {
      case 'would_send': wouldSend += 1; break;
      case 'sent': sent += 1; break;
      case 'suppressed': suppressed += 1; break;
      case 'capped': capped += 1; break;
      default: skipped += 1; break;
    }
  }

  return await emit('PASS',
    `mode=${mode} live=${state.live_since ? 1 : 0} blocks=${blocks.length} opt_ins=${recipients.length} ` +
    `would_send=${wouldSend} sent=${sent} suppressed=${suppressed} capped=${capped} skipped=${skipped}`,
    wouldSend + sent);
}

if (require.main === module) {
  void runScript('product-updates-digest', async () => {
    try { return await main(); } catch (err) {
      return await emit('INDETERMINATE', `unhandled: ${err instanceof Error ? err.message : err}`);
    }
  });
}
