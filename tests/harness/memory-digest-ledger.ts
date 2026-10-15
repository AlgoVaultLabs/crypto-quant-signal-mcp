/**
 * OPS-DIGEST-DELIVERY-DURABLE-W1 CH2 — an in-memory digest ledger for suites that call a
 * LABELLED `sendDigest` (inject with `_setDigestLedgerForTest`).
 *
 * Built from the ledger's own PURE derivations (`planDigestRun`, `renderDeadPage`,
 * `causeLine`), so a double cannot disagree with production about which outcome queues, which
 * dies and what the page says — and a suite never writes the developer's local database (the
 * default seam lazily opens the real ledger, which on a laptop is `~/.crypto-quant-signal`).
 */
import {
  planDigestRun,
  renderDeadPage,
  causeLine,
  type DigestLedgerPort,
  type PlannedPart,
} from '../../src/lib/telegram-digest-ledger.js';

export interface MemoryRun {
  label: string;
  status: 'delivered' | 'queued' | 'dead';
  parts: PlannedPart[];
  /** `last_cause` exactly as the real ledger would persist it, per undelivered part. */
  causes: string[];
}

export function memoryDigestLedger(): DigestLedgerPort & { runs: MemoryRun[] } {
  const runs: MemoryRun[] = [];
  return {
    runs,
    async recordDigestRun({ label, parts }) {
      const plan = planDigestRun(parts);
      const undelivered = plan.parts.filter((p) => p.status !== 'delivered');
      runs.push({ label, status: plan.runStatus, parts: plan.parts, causes: undelivered.map((p) => causeLine(p.failure, p.attempts)) });
      const runId = runs.length;
      const dead = plan.parts.find((p) => p.status === 'dead');
      return {
        runId,
        runStatus: plan.runStatus,
        periodKey: 'memory',
        deadPage: dead
          ? renderDeadPage({
              label,
              periodKey: 'memory',
              runId,
              disposition: dead.failure?.disposition ?? 'unknown',
              code: dead.failure?.code ?? 'unknown',
              desc: dead.failure?.desc ?? '',
              attempts: dead.attempts,
              firstFailedAtMs: null,
              partsDelivered: plan.parts.length - undelivered.length,
              partsTotal: plan.parts.length,
              hostLog: 'memory',
            })
          : null,
      };
    },
    async pageDeadRun({ page, send }) {
      return (await send(page)) ? 'paged' : 'undelivered';
    },
  };
}

/** A ledger that is DOWN — every write throws, as an unreachable database would. */
export function unavailableDigestLedger(why = 'connect ECONNREFUSED 172.19.0.10:5432'): DigestLedgerPort {
  return {
    async recordDigestRun() {
      throw new Error(why);
    },
    async pageDeadRun() {
      return 'not-claimed';
    },
  };
}
