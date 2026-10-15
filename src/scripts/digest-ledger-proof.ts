#!/usr/bin/env node
/**
 * OPS-DIGEST-DELIVERY-DURABLE-W1 CH2 — prove the digest ledger's redelivery path WHERE IT
 * LIVES: the production container, real Postgres, the real transport — and a STUB Telegram
 * origin on 127.0.0.1, passed through a function parameter. No env var the production path
 * reads is touched, and nothing reaches the operator's chat.
 *
 * Steps (each asserted; any miss is FAIL):
 *   1. snapshot the production rows (count + max(id) over the registered labels);
 *   2. write ONE `__proof__` part (unique period key) as a transient failure would;
 *   3. drain with the stub answering 502 ⇒ `queued`, attempts=1, cause carries `http_5xx`;
 *   4. drain with the stub answering 200 ⇒ `delivered`, `text` NULL, run row `delivered`;
 *   5. delete ONLY its own rows, by id;
 *   6. production rows identical before/after, and ZERO requests reached api.telegram.org.
 *
 * `__proof__` is not a registered label, so production's drain can never lease it (the label
 * filter sits inside the selecting query) — the proof passes its own label set.
 *
 *   docker exec <ctr> node dist/scripts/digest-ledger-proof.js
 *
 * Verdict: exactly one `DIGEST_LEDGER_PROOF_VERDICT=PASS|FAIL|INDETERMINATE`; exit 0 / 1 / 3
 * (3 = the token-law default for a new gate: the ledger or the stub could not be reached).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runScript } from '../lib/script-lifecycle.js';
import { dbQuery } from '../lib/performance-db.js';
import { deliverText, classifyTelegramFailure, type DeliveryResult } from '../lib/telegram.js';
import { DIGEST_LABELS } from '../lib/digest-registry.js';
import { ensureDigestLedgerSchema, writeDigestRun, drainDigestLedger } from '../lib/telegram-digest-ledger.js';

const PROOF_LABEL = '__proof__';
const STUB_MESSAGE_ID = 4242;

type Verdict = 'PASS' | 'FAIL' | 'INDETERMINATE';

function finish(v: Verdict, why: string): number {
  console.log(`[proof] ${why}`);
  console.log(`DIGEST_LEDGER_PROOF_VERDICT=${v}`);
  return v === 'PASS' ? 0 : v === 'FAIL' ? 1 : 3;
}

async function productionFingerprint(): Promise<string> {
  const ph = DIGEST_LABELS.map(() => '?').join(', ');
  const r = await dbQuery<{ n: unknown; m: unknown }>(
    `SELECT COUNT(*) AS n, MAX(id) AS m FROM telegram_digest_ledger WHERE label IN (${ph})`,
    [...DIGEST_LABELS],
  );
  return `count=${Number(r[0]?.n ?? 0)} max_id=${r[0]?.m == null ? 'none' : Number(r[0].m)}`;
}

async function proofRows(periodKey: string) {
  return dbQuery<{ id: unknown; part: unknown; status: string; attempts: unknown; last_cause: string | null; text: string | null; tg_message_id: unknown }>(
    `SELECT id, part, status, attempts, last_cause, text, tg_message_id FROM telegram_digest_ledger
     WHERE label = ? AND period_key = ? ORDER BY part`,
    [PROOF_LABEL, periodKey],
  );
}

export async function main(): Promise<number> {
  // Count every request that would reach the real Telegram — the proof must make ZERO.
  let realTelegram = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('api.telegram.org')) realTelegram++;
    return realFetch(input, init);
  }) as typeof fetch;

  let answer = 502;
  let stubHits = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      stubHits++;
      res.writeHead(answer, { 'content-type': 'application/json' });
      res.end(
        answer === 200
          ? JSON.stringify({ ok: true, result: { message_id: STUB_MESSAGE_ID } })
          : JSON.stringify({ ok: false, error_code: 502, description: 'Bad Gateway' }),
      );
    });
  });
  let periodKey = '';
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
  } catch (err) {
    globalThis.fetch = realFetch;
    return finish('INDETERMINATE', `stub origin could not listen: ${(err as Error).message}`);
  }
  const port = (server.address() as AddressInfo).port;
  const transport = { apiBase: `http://127.0.0.1:${port}/botPROOF`, chatId: 'proof' };
  const send = (text: string): Promise<DeliveryResult> => deliverText(text, { policy: 'ledger', transport });
  const page = async (): Promise<boolean> => false; // the proof pages nobody

  try {
    try {
      await ensureDigestLedgerSchema();
    } catch (err) {
      return finish('INDETERMINATE', `ledger unavailable: ${(err as Error).message}`);
    }
    const before = await productionFingerprint();
    const t0 = Date.now();
    periodKey = `proof-${t0}`;
    const transient: DeliveryResult = {
      ok: false,
      degraded: false,
      failure: classifyTelegramFailure({ httpStatus: 502, body: '{"ok":false,"error_code":502,"description":"Bad Gateway"}' }),
      attempts: 0,
      posts: 0,
      elapsedMs: 0,
      retryAfterS: null,
      messageId: null,
    };
    const rec = await writeDigestRun({
      label: PROOF_LABEL, periodKey, nowMs: t0, ttlS: 3_600, hostLog: 'n/a',
      parts: [{ part: 1, text: 'digest-ledger-proof part 1 of 1', result: transient }],
    });
    const fails: string[] = [];
    if (rec.runStatus !== 'queued') fails.push(`write: run status ${rec.runStatus}, expected queued`);

    // Drain 1 — the stub answers 502. The write path requeued at +120 s; drain just after.
    answer = 502;
    const d1 = await drainDigestLedger({ nowMs: t0 + 121_000, deps: { send, page }, labels: [PROOF_LABEL] });
    let rows = await proofRows(periodKey);
    const p1 = rows.find((r) => Number(r.part) === 1);
    if (d1.queued !== 1) fails.push(`drain(502): queued=${d1.queued}, expected 1`);
    if (p1?.status !== 'queued') fails.push(`drain(502): part status ${p1?.status}, expected queued`);
    if (Number(p1?.attempts) !== 1) fails.push(`drain(502): attempts ${String(p1?.attempts)}, expected 1`);
    if (!String(p1?.last_cause ?? '').includes('class=http_5xx')) fails.push('drain(502): cause lacks http_5xx');

    // Drain 2 — the stub answers 200, after the 2-minute backoff.
    answer = 200;
    const d2 = await drainDigestLedger({ nowMs: t0 + 121_000 + 121_000, deps: { send, page }, labels: [PROOF_LABEL] });
    rows = await proofRows(periodKey);
    const p2 = rows.find((r) => Number(r.part) === 1);
    const run = rows.find((r) => Number(r.part) === 0);
    if (d2.delivered !== 1) fails.push(`drain(200): delivered=${d2.delivered}, expected 1`);
    if (p2?.status !== 'delivered') fails.push(`drain(200): part status ${p2?.status}, expected delivered`);
    if (p2?.text !== null) fails.push('drain(200): text not NULL after delivery');
    if (Number(p2?.tg_message_id) !== STUB_MESSAGE_ID) fails.push(`drain(200): tg_message_id ${String(p2?.tg_message_id)}`);
    if (run?.status !== 'delivered') fails.push(`drain(200): run status ${run?.status}, expected delivered`);

    // Delete ONLY the proof's own rows, by id.
    const ids = rows.map((r) => Number(r.id));
    const deleted = ids.length
      ? await dbQuery<{ id: unknown }>(
          `DELETE FROM telegram_digest_ledger WHERE label = ? AND id IN (${ids.map(() => '?').join(', ')}) RETURNING id`,
          [PROOF_LABEL, ...ids],
        )
      : [];
    if (deleted.length !== ids.length) fails.push(`cleanup deleted ${deleted.length}/${ids.length}`);
    periodKey = '';

    const after = await productionFingerprint();
    if (after !== before) fails.push(`production rows moved: ${before} → ${after}`);
    if (realTelegram !== 0) fails.push(`${realTelegram} request(s) reached api.telegram.org`);
    if (stubHits !== 2) fails.push(`stub saw ${stubHits} request(s), expected 2`);

    console.log(`[proof] ${d1.line}`);
    console.log(`[proof] ${d2.line}`);
    console.log(`[proof] production ${before} (unchanged=${after === before}) · api.telegram.org requests=${realTelegram} · stub requests=${stubHits}`);
    return fails.length ? finish('FAIL', fails.join(' · ')) : finish('PASS', 'queued on 502, delivered on 200, own rows removed, production untouched');
  } catch (err) {
    return finish('INDETERMINATE', `proof could not complete: ${(err as Error).message}`);
  } finally {
    if (periodKey) {
      // Never leave a proof row behind, whatever failed above.
      await dbQuery(`DELETE FROM telegram_digest_ledger WHERE label = ? AND period_key = ? RETURNING id`, [PROOF_LABEL, periodKey]).catch(() => []);
    }
    globalThis.fetch = realFetch;
    await new Promise<void>((r) => server.close(() => r()));
  }
}

if (require.main === module) {
  void runScript('digest-ledger-proof', main);
}
