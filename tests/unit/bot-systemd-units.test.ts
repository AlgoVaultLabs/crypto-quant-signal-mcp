/**
 * OPS-BOT-DISPATCH-LATENCY-W1 CH4 — the committed algovault-bot units.
 *
 * These three units ran in production for months with NO committed ancestor in any repo, which
 * is the exact precondition of OPS-CLOSEDBAR-DISPATCH-OFFSET-INCIDENT-W1 (a live module existing
 * on no branch, then deleted by a full-tree rsync). Committing them closes that gap; this file
 * stops the two facts that make the timer correct from decaying back into prose.
 *
 * The timer's phase is LOAD-BEARING, not cosmetic. The engine dispatches at
 * `bar_open + offset + grace + jitter` rounded UP to the next tick, so on a `*:*:00` grid the
 * only reachable instants after a bar closes are +0s and +60s — a whole minute is the smallest
 * expressible non-zero offset. And +0s is not safe: measured on Binance fapi from the host, a
 * just-closed bar's final (close, volume) settles between +2.13s and +6.27s. The phase is what
 * buys a sub-minute offset that still clears the settle tail.
 *
 * A README paragraph saying "keep this at :10" is exactly the kind of control this repo has
 * already watched fail, so the numbers are asserted instead.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DIR = path.resolve(__dirname, '../../ops/systemd');
const read = (f: string): string => fs.readFileSync(path.join(DIR, f), 'utf8');

/** Value of a systemd `Key=Value` line, ignoring comments. */
function directive(unit: string, key: string): string | null {
  for (const raw of unit.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq > 0 && line.slice(0, eq).trim() === key) return line.slice(eq + 1).trim();
  }
  return null;
}

/** Seconds component of an `OnCalendar=*:*:SS` expression. */
function phaseSeconds(onCalendar: string): number {
  const m = /^\*:\*:(\d{1,2})$/.exec(onCalendar);
  if (!m) throw new Error(`unsupported OnCalendar form: ${onCalendar}`);
  return Number(m[1]);
}

/** `AccuracySec=1s` / `500ms` / `5` → seconds. */
function accuracySeconds(v: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(v);
  if (!m) throw new Error(`unsupported AccuracySec form: ${v}`);
  const n = Number(m[1]);
  return m[2] === 'ms' ? n / 1000 : m[2] === 'm' ? n * 60 : n;
}

// Measured on Binance fapi from the production host: the just-closed bar's final (close, volume)
// settles between +2.13s and +6.27s, with non-monotonic edge reads out to +6.45s.
const MEASURED_SETTLE_MAX_S = 6.27;

describe('algovault-bot-cron.timer — the dispatch phase', () => {
  const timer = read('algovault-bot-cron.timer');

  it('is phased OFF the :00 boundary', () => {
    // :00 makes a whole minute the smallest expressible post-close offset, which is the defect.
    expect(phaseSeconds(directive(timer, 'OnCalendar')!)).toBeGreaterThan(0);
  });

  it('fires late enough for the bar to have SETTLED, even at the accuracy ceiling', () => {
    // The real dispatch instant is [phase, phase + AccuracySec]. The EARLY edge is what must
    // clear the settle tail — asserting the nominal phase alone would miss a widened
    // AccuracySec, which is how a 10s target silently becomes 10-15s.
    const phase = phaseSeconds(directive(timer, 'OnCalendar')!);
    expect(phase).toBeGreaterThan(MEASURED_SETTLE_MAX_S);
  });

  it('does not spend the settle margin on a loose accuracy window', () => {
    const phase = phaseSeconds(directive(timer, 'OnCalendar')!);
    const accuracy = accuracySeconds(directive(timer, 'AccuracySec')!);
    // The LATE edge must still land inside the bar with room to spare. 30s is the liveness
    // canary's own execution allowance, so anything beyond it would page that guard.
    expect(phase + accuracy).toBeLessThanOrEqual(30);
    // …and the window must be tight enough that the phase means something. Measured over 1620
    // consecutive ticks this host fires within +0.010s..+0.335s, so 1s is a ceiling it meets.
    expect(accuracy).toBeLessThanOrEqual(2);
  });

  it('stays a per-minute timer — the cadence is unchanged, only its phase', () => {
    expect(directive(timer, 'OnCalendar')).toMatch(/^\*:\*:\d{1,2}$/);
    expect(directive(timer, 'Unit')).toBe('algovault-bot-cron.service');
    // Persistent=true would fire a catch-up burst after any downtime, and every missed tick is
    // a bar that has already passed — the alerts would be stale by construction.
    expect(directive(timer, 'Persistent')).toBe('false');
  });
});

describe('the units keep the properties the host depends on', () => {
  it('both services run as the bot user against the shared env file', () => {
    for (const f of ['algovault-bot.service', 'algovault-bot-cron.service']) {
      const u = read(f);
      expect(directive(u, 'User')).toBe('algovault-bot');
      expect(directive(u, 'EnvironmentFile')).toBe('/etc/algovault-bot/env');
      // The venv interpreter, not a system python: /opt/algovault-bot is swapped per manifest
      // entry precisely so this path survives a deploy.
      expect(directive(u, 'ExecStart')).toContain('/opt/algovault-bot/.venv/bin/python');
    }
  });

  it('keeps the write-path confinement that lets ProtectSystem=strict hold', () => {
    for (const f of ['algovault-bot.service', 'algovault-bot-cron.service']) {
      const u = read(f);
      expect(directive(u, 'ProtectSystem')).toBe('strict');
      expect(directive(u, 'NoNewPrivileges')).toBe('true');
      // state.db and the logs are the ONLY writable paths; dropping either breaks the bot,
      // and widening this list is how strict confinement quietly stops being strict.
      expect(directive(u, 'ReadWritePaths')).toBe('/var/log/algovault-bot /var/lib/algovault-bot');
    }
  });

  it('the cron tick is a oneshot — systemd will not overlap two ticks', () => {
    // There is no flock anywhere in this unit set; `Type=oneshot` is the only thing preventing
    // a slow tick from being joined by the next one.
    expect(directive(read('algovault-bot-cron.service'), 'Type')).toBe('oneshot');
  });
});
