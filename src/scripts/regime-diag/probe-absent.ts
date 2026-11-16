// regime-diag/probe-absent.ts — EDGE-REGIME-CONFIRM-W1: the record that the venue serves no archive of a coin-month.
//
// A study that reads months no registration could pin accounts for every coin-month of them (guard.ts, leg iii):
// an archive verified against the venue's checksum, or this record. The probe asks the venue for the archive's URL
// with one HEAD request and writes `<archive>.ABSENT` — JSON `{url, status, probed_at}` — ONLY when the answer is
// HTTP 404. A served month, any other status, a redirect, a transport error and a timeout write nothing and exit
// non-zero, each by name: none of them is "the venue serves none".
//
// It is its own CLI. The run path never imports it, and it decides nothing about a read: the guard checks every
// record (the URL it derives for the coin-month, the status, and that the probe ran on or after the registered
// read date). The record holds the URL that was probed, so a record made at any other origin is refused there.
// It asks one of two origins and no other: the venue's, or a stub on 127.0.0.1 (`--origin`, for its tests).
//
//   tsx src/scripts/regime-diag/probe-absent.ts --coin <COIN> --month <YYYY-MM> --dir <store directory>
//       [--origin http://127.0.0.1:<port>] [--timeout-ms <n>]
//
// Prints one line, `REGIME_DIAG_PROBE_VERDICT=<ABSENT|SERVED|INDETERMINATE> — <reason>`, and exits 0 on ABSENT (the
// record is written), 1 on SERVED (the venue has the archive: fetch it), 3 on INDETERMINATE (could not tell).
// Callers gate on the token.
import fs from 'node:fs';
import path from 'node:path';
import { ARCHIVE_ORIGIN, archiveName, archiveUrl } from './archive.js';

export const PROBE_TOKEN = 'REGIME_DIAG_PROBE_VERDICT';
export type ProbeVerdict = 'ABSENT' | 'SERVED' | 'INDETERMINATE';
const EXIT: Record<ProbeVerdict, number> = { ABSENT: 0, SERVED: 1, INDETERMINATE: 3 };
const USAGE = 'usage: --coin <COIN> --month <YYYY-MM> --dir <store directory> [--origin http://127.0.0.1:<port>] [--timeout-ms <n>]';
const TIMEOUT_MS = 30_000;

/** The one request the probe makes. A stand-in replaces the transport alone (the tests' default-origin case). */
type Head = (url: string, init: { method: 'HEAD'; redirect: 'manual'; signal: AbortSignal }) => Promise<{ status: number }>;

export interface ProbeInput {
  coin: string;
  /** The month, `YYYY-MM`. */
  ym: string;
  /** The archive store directory the record is written to (the overlay or the cache). It must exist. */
  dir: string;
  /** Where the archives are served from: the venue's origin when absent, else a stub on 127.0.0.1. */
  origin?: string;
  timeoutMs?: number;
  now?: () => number;
  fetch?: Head;
}
export interface ProbeResult { verdict: ProbeVerdict; reason: string; url: string | null; file: string | null }

/** The venue's origin, or a port of 127.0.0.1: the probe makes no request anywhere else. */
const isOrigin = (s: string): boolean => s === ARCHIVE_ORIGIN || /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(s);

export async function probeAbsent(input: ProbeInput): Promise<ProbeResult> {
  const origin = input.origin ?? ARCHIVE_ORIGIN, timeoutMs = input.timeoutMs ?? TIMEOUT_MS;
  const usable = /^[A-Z0-9]+$/.test(input.coin) && /^\d{4}-(0[1-9]|1[0-2])$/.test(input.ym) && isOrigin(origin) && Number.isInteger(timeoutMs) && timeoutMs > 0
    && input.dir !== '' && fs.existsSync(input.dir) && fs.statSync(input.dir).isDirectory();
  if (!usable) return { verdict: 'INDETERMINATE', reason: USAGE, url: null, file: null };
  const name = archiveName(input.coin, '1m', input.ym), url = archiveUrl(input.coin, input.ym, origin);
  const none = (verdict: ProbeVerdict, reason: string): ProbeResult => ({ verdict, reason, url, file: null });

  let status: number;
  try {
    status = (await (input.fetch ?? (fetch as Head))(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })).status;
  } catch (e) {
    const err = e as { name?: string; code?: string; cause?: { code?: string } };
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return none('INDETERMINATE', `timeout after ${timeoutMs} ms: nothing recorded`);
    return none('INDETERMINATE', `transport error (${err.cause?.code ?? err.code ?? 'UNKNOWN'}): nothing recorded`);
  }
  if (status === 200) return none('SERVED', `HTTP 200: the venue serves ${name}; nothing recorded`);
  if (status !== 404) return none('INDETERMINATE', `HTTP ${status}: nothing recorded`);

  const file = path.join(input.dir, `${name}.ABSENT`), tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ url, status, probed_at: new Date((input.now ?? Date.now)()).toISOString() })}\n`);
  fs.renameSync(tmp, file);
  return { verdict: 'ABSENT', reason: `HTTP 404: recorded ${name}.ABSENT`, url, file };
}

async function main(): Promise<ProbeVerdict> {
  const argv = process.argv.slice(2);
  const raw = (name: string): string | null => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
  const given = (name: string): boolean => argv.includes(name);
  const coin = raw('--coin'), ym = raw('--month'), dir = raw('--dir'), origin = raw('--origin'), timeout = raw('--timeout-ms');
  const r: ProbeResult = !coin || !ym || !dir || (given('--origin') && !origin) || (given('--timeout-ms') && !timeout)
    ? { verdict: 'INDETERMINATE', reason: USAGE, url: null, file: null }
    : await probeAbsent({ coin, ym, dir, ...(origin ? { origin } : {}), ...(timeout ? { timeoutMs: Number(timeout) } : {}) });
  process.stdout.write(`${PROBE_TOKEN}=${r.verdict} — ${r.reason}\n`);
  return r.verdict;
}

if (require.main === module) {
  main().then((v) => { process.exitCode = EXIT[v]; }, () => {
    process.stdout.write(`${PROBE_TOKEN}=INDETERMINATE — the probe threw\n`);
    process.exitCode = EXIT.INDETERMINATE;
  });
}
