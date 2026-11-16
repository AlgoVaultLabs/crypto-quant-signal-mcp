// tests/unit/regime-diag-study.test.ts — EDGE-REGIME-CONFIRM-W1 CH1: the harness serves a study, not a constant.
// The two study records, the per-study seal file, the carried fit result, the clock leg and the read-time
// verification of the months no registration could pin. Synthetic bytes only: nothing here reads an archive of the
// venue, and no test touches the registered studies' seal home.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ARCHIVE_ORIGIN, archiveName, archiveUrl, months, sha256, type ArchiveStore } from '../../src/scripts/regime-diag/archive.js';
import * as spec from '../../src/scripts/regime-diag/diag-spec.js';
import * as guard from '../../src/scripts/regime-diag/guard.js';
import { clockRefusal } from '../../src/scripts/regime-diag/run.js';

const { STUDIES, studyOf, MIN_MS } = spec;
const T3 = studyOf('diag-2026-11-16') as spec.StudyRecord, CONFIRM = studyOf('confirm') as spec.StudyRecord;
const iso = (rec: spec.StudyRecord, minute: number): string => new Date(rec.span.t0Ms + minute * MIN_MS).toISOString();
const REPO = path.resolve(__dirname, '../..');

async function mutated<T>(lever: string, fn: (m: typeof guard) => T): Promise<T> {
  process.env.REGIME_DIAG_MUTATE = lever;
  vi.resetModules();
  try {
    return fn(await import('../../src/scripts/regime-diag/guard.js'));
  } finally {
    delete process.env.REGIME_DIAG_MUTATE;
    vi.resetModules();
  }
}

describe('regime-diag: the study records', () => {
  it('there are two studies, and a run that names none, or another, gets none: nothing defaults to T3', () => {
    expect(STUDIES.map((s) => s.id)).toEqual(['diag-2026-11-16', 'confirm']);
    for (const id of [undefined, null, '', 'registered', 'T3', 'diag', 'CONFIRM', 0]) expect(studyOf(id), String(id)).toBeNull();
    expect([studyOf('diag-2026-11-16'), studyOf('confirm')]).toEqual([STUDIES[0], STUDIES[1]]);
  });

  it('T3 keeps its values, and is closed', () => {
    expect(T3).toEqual({
      id: 'diag-2026-11-16', wave: 'EDGE-REGIME-DIAG-W1', registration: 'audits/regime-diagnostic-preregistration-2026-11-16.md', seed: '20261116',
      span: spec.SPAN, windows: [spec.FIT, spec.HOLDOUT], months: { first: '2024-01', pinned: '2026-10', last: '2026-10' }, seal: 'holdout.seal',
      reads: { fit: { line: 'REGIME_DIAG_FIT', file: 'regime-diag-fit.json' }, holdout: { line: 'REGIME_DIAG_VERDICT', file: 'regime-diag-holdout.json' } },
      skeleton: 'registered', carry: null, notBefore: null, closed: true,
    });
    expect([spec.WAVE, spec.REGISTRATION, spec.SEED, spec.FIRST_MONTH, spec.LAST_MONTH]).toEqual([T3.wave, T3.registration, T3.seed, T3.months.first, T3.months.last]);
    expect([iso(T3, 0), iso(T3, T3.span.n - 1), iso(T3, spec.HOLDOUT.lo)]).toEqual(['2024-01-01T00:00:00.000Z', '2026-10-31T23:59:00.000Z', '2026-01-01T00:00:00.000Z']);
  });

  it('the successor: entries after T_END alone, one hold-out read, T3\'s grid origin, its own seed label, seal file and result', () => {
    const [win] = CONFIRM.windows;
    expect(CONFIRM.windows).toHaveLength(1);
    // the corpus: 2026-11-01T00:00Z <= t, on a grid whose last minute is T_END2; T3's last minute is one before the first
    expect([win.name, iso(CONFIRM, win.lo), iso(CONFIRM, win.lo - 1), iso(CONFIRM, win.hi - 1), win.hi]).toEqual(['holdout', '2026-11-01T00:00:00.000Z', '2026-10-31T23:59:00.000Z', '2027-05-31T23:59:00.000Z', CONFIRM.span.n]);
    expect([CONFIRM.span.t0Ms, win.lo]).toEqual([T3.span.t0Ms, T3.span.n]);
    // history reaches back into T3's months, which T3's manifest pins; the months after it are the outcome months
    expect(CONFIRM.months).toEqual({ first: T3.months.first, pinned: T3.months.last, last: '2027-05' });
    expect(months(CONFIRM.months.pinned, CONFIRM.months.last).slice(1)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05']);
    // nothing is re-fit: there is no fit read, and no fit window
    expect(Object.keys(CONFIRM.reads)).toEqual(['holdout']);
    expect(CONFIRM.reads.holdout).toEqual({ line: 'REGIME_CONFIRM_VERDICT', file: 'regime-confirm.json' });
    expect([CONFIRM.wave, CONFIRM.registration, CONFIRM.skeleton, CONFIRM.closed]).toEqual(['EDGE-REGIME-CONFIRM-W1', 'audits/regime-confirmation-preregistration-2026-11-17.md', 'recorded', false]);
    // nothing of T3's is reused by name: another seed label, another seal file, another result file and line
    expect(CONFIRM.seed).toMatch(/^\d{8}$/);
    for (const k of ['id', 'wave', 'registration', 'seed', 'seal'] as const) expect(CONFIRM[k], k).not.toBe(T3[k]);
    expect([T3.reads.fit?.file, T3.reads.holdout.file, T3.reads.fit?.line, T3.reads.holdout.line]).not.toContain(CONFIRM.reads.holdout.file);
    expect([T3.reads.fit?.line, T3.reads.holdout.line]).not.toContain(CONFIRM.reads.holdout.line);
    // the read date is after the last outcome month is whole
    expect(Date.parse(CONFIRM.notBefore as string)).toBeGreaterThan(CONFIRM.span.t0Ms + CONFIRM.span.n * MIN_MS);
  });

  it('a record is frozen, all the way down', () => {
    expect(Object.isFrozen(STUDIES)).toBe(true);
    for (const s of STUDIES) {
      for (const part of [s, s.span, s.windows, ...s.windows, s.months, s.reads, s.reads.holdout, ...(s.reads.fit ? [s.reads.fit] : []), ...(s.carry ? [s.carry] : [])]) expect(Object.isFrozen(part), s.id).toBe(true);
    }
    expect(() => { (CONFIRM as { seal: string }).seal = 'holdout.seal'; }).toThrow(TypeError);
    expect(() => { (CONFIRM.carry as { sha256: string }).sha256 = 'f'.repeat(64); }).toThrow(TypeError);
    expect(() => { (T3 as { closed: boolean }).closed = false; }).toThrow(TypeError);
  });
});

describe('regime-diag: one seal file per study, in one home', () => {
  let dir = '';
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-diag-study-')); });
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  /** Each study claims once in the one home; neither claim refuses, or is refused by, the other study's. */
  const eachOnce = (m: typeof guard): void => {
    const h = path.join(fs.mkdtempSync(path.join(dir, 'seal-')), 'home'), s = fs.mkdtempSync(path.join(dir, 'store-'));
    const claims = [m.claimSeal(h, s, T3, { n: 1 }), m.claimSeal(h, s, CONFIRM, { n: 2 }), m.claimSeal(h, s, T3, { n: 3 }), m.claimSeal(h, s, CONFIRM, { n: 4 })];
    expect(claims.map((c) => c.ok)).toEqual([true, true, false, false]);
    expect(fs.readdirSync(h).sort()).toEqual(['confirm.seal', 'holdout.seal']);
    const kept = (rec: spec.StudyRecord): unknown => JSON.parse(fs.readFileSync(m.sealFile(h, rec), 'utf8'));
    expect([kept(T3), kept(CONFIRM)]).toEqual([{ wave: 'EDGE-REGIME-DIAG-W1', n: 1 }, { wave: 'EDGE-REGIME-CONFIRM-W1', n: 2 }]);
    const log = fs.readFileSync(m.guardLog(s), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { ok: boolean; leg: string; wave: string });
    expect(log.map((l) => [l.ok, l.leg, l.wave])).toEqual([[true, 'seal', T3.wave], [true, 'seal', CONFIRM.wave], [false, 'seal', T3.wave], [false, 'seal', CONFIRM.wave]]);
  };

  it('T3\'s seal file is where it was; the successor\'s is another file beside it', () => {
    const h = path.join(dir, 'h');
    expect([guard.sealFile(h, T3), guard.sealFile(h, CONFIRM)]).toEqual([path.join(h, 'holdout.seal'), path.join(h, 'confirm.seal')]);
  });

  it('AC1.1 each study claims its own seal once, and a second claim refuses (AC1.3: red when the per-study seal is dropped, green restored)', async () => {
    await expect(mutated('studyseal', (m) => eachOnce(m))).rejects.toThrow(/to deeply equal/);
    eachOnce(guard);
  });

  it('a spent T3 seal does not refuse the successor, and the successor\'s does not re-open T3', () => {
    const h = path.join(fs.mkdtempSync(path.join(dir, 'seal-')), 'home'), s = fs.mkdtempSync(path.join(dir, 'store-'));
    expect(guard.claimSeal(h, s, T3, { n: 1 }).ok).toBe(true);
    const t3 = fs.readFileSync(guard.sealFile(h, T3), 'utf8');
    expect(fs.existsSync(guard.sealFile(h, CONFIRM))).toBe(false);
    expect(guard.claimSeal(h, s, CONFIRM, { n: 2 }).ok).toBe(true);
    expect(guard.claimSeal(h, s, T3, { n: 3 })).toEqual({ ok: false, reason: 'the hold-out seal exists: the hold-out has been read' });
    expect(fs.readFileSync(guard.sealFile(h, T3), 'utf8')).toBe(t3);
  });
});

describe('regime-diag: the carry-over, the clock and the months after the pinned manifest', () => {
  let dir = '';
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-diag-carry-')); });
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it('the successor carries one fit result: T3\'s, by sha256, read under T3\'s registration commit', () => {
    expect(CONFIRM.carry).toEqual({ sha256: '46454f07a58c53154a081fa50bcc2709fb5ec11043d5e4db612e19a39cb0b312', registrationCommit: '22f01dc912beade374ab4bd7c0f6706e07df332e' });
    expect(T3.carry).toBeNull();
  });

  /** The carried bytes are accepted; the same bytes with one changed, lengthened or emptied are not. */
  const onlyThat = (m: typeof guard): void => {
    const bytes = Buffer.from('{"kind":"fit","n":1}\n'), carry = { sha256: sha256(bytes), registrationCommit: 'c'.repeat(40) };
    const flipped = Buffer.from(bytes); flipped[9] ^= 1;
    expect(m.carryRefusal(bytes, carry)).toBeNull();
    expect([flipped, Buffer.concat([bytes, Buffer.from(' ')]), Buffer.alloc(0)].map((b) => m.carryRefusal(b, carry))).toEqual([
      expect.stringMatching(/not the one this study carries/), expect.stringMatching(/not the one this study carries/), expect.stringMatching(/not the one this study carries/)]);
    // and the registered carry refuses any bytes that are not T3's fit result
    expect(m.carryRefusal(bytes, CONFIRM.carry as spec.Carry)).toMatch(/not the one this study carries \(sha256 [0-9a-f]{12}… read, 46454f07a58c… carried\)/);
  };
  it('AC1.1 a carry-over is accepted only by that sha256 (AC1.3: red when any fit result is accepted, green restored)', async () => {
    await expect(mutated('carry', (m) => onlyThat(m))).rejects.toThrow(/to deeply equal/);
    onlyThat(guard);
  });

  it('the clock leg: the successor computes nothing before its registered date; T3 has none', () => {
    const at = Date.parse('2027-06-16T00:00:00Z');
    expect(CONFIRM.notBefore).toBe('2027-06-16T00:00:00Z');
    expect(clockRefusal(CONFIRM, at - 1)).toBe('the confirm study is read once, not before 2027-06-16T00:00:00Z');
    expect(clockRefusal(CONFIRM, Date.parse('2026-11-17T00:00:00Z'))).toMatch(/not before/);
    expect([clockRefusal(CONFIRM, at), clockRefusal(CONFIRM, at + 1), clockRefusal(T3, 0)]).toEqual([null, null, null]);
  });

  it('the months after the pinned manifest: an archive is the venue\'s by its checksum, and a missing one is absent only on record', () => {
    const mk = (name: string): ArchiveStore => { const a = { cache: path.join(dir, name, 'cache'), overlay: path.join(dir, name, 'overlay') }; for (const d of Object.values(a)) fs.mkdirSync(d, { recursive: true }); return a; };
    const yms = ['2026-11', '2026-12'], panel = ['SYNA', 'SYNB'];
    const file = (coin: string, ym: string): string => archiveName(coin, '1m', ym);
    const put = (d: string, coin: string, ym: string, body: string, sum?: string): void => {
      fs.writeFileSync(path.join(d, file(coin, ym)), body);
      if (sum !== undefined) fs.writeFileSync(path.join(d, `${file(coin, ym)}.CHECKSUM`), sum);
    };
    const line = (body: string, name: string): string => `${sha256(Buffer.from(body))}  ${name}\n`;
    const NB = '2027-06-16T00:00:00Z';
    const check = (a: ArchiveStore, notBefore: string | null = NB): ReturnType<typeof guard.checkLaterArchives> => guard.checkLaterArchives(a, panel, yms, notBefore);
    /** The probe's record of a coin-month the venue serves no archive of. */
    const record = (coin: string, ym: string, more: Record<string, unknown> = {}): string => `${JSON.stringify({ url: archiveUrl(coin, ym), status: 404, probed_at: NB, ...more })}\n`;

    // nothing fetched, nothing recorded: an incomplete download is never read as the named drop
    const a = mk('a');
    expect(check(a)).toMatchObject({ ok: false, reason: expect.stringMatching(/SYNAUSDT-1m-2026-11\.zip is neither in the store nor recorded as absent/) });
    // every coin-month accounted for: verified archives, and the venue's absences on record
    put(a.cache, 'SYNA', '2026-11', 'a-11', line('a-11', file('SYNA', '2026-11')));
    put(a.cache, 'SYNA', '2026-12', 'stale', line('stale', file('SYNA', '2026-12')));
    put(a.overlay, 'SYNA', '2026-12', 'a-12', line('a-12', file('SYNA', '2026-12')).toUpperCase().replace('.ZIP', '.zip'));
    put(a.cache, 'SYNB', '2026-11', 'b-11', line('b-11', file('SYNB', '2026-11')));
    fs.writeFileSync(path.join(a.overlay, `${file('SYNB', '2026-12')}.ABSENT`), record('SYNB', '2026-12'));
    const good = check(a);
    expect([good.ok, good.reason]).toEqual([true, 'ok']);
    expect(good.later).toEqual({
      files: [
        { name: file('SYNA', '2026-11'), source: 'cache', bytes: 4, sha256: sha256(Buffer.from('a-11')) },
        { name: file('SYNA', '2026-12'), source: 'overlay', bytes: 4, sha256: sha256(Buffer.from('a-12')) },
        { name: file('SYNB', '2026-11'), source: 'cache', bytes: 4, sha256: sha256(Buffer.from('b-11')) },
      ],
      absent: [file('SYNB', '2026-12')],
    });
    // each way it is not the venue's file refuses, and names the file
    const broken = (change: (b: ArchiveStore) => void): string => {
      const b = mk(`b${fs.readdirSync(dir).length}`);
      for (const k of ['cache', 'overlay'] as const) fs.cpSync(a[k], b[k], { recursive: true });
      change(b);
      const r = check(b);
      expect(r.ok).toBe(false);
      return r.reason;
    };
    expect(broken((b) => fs.writeFileSync(path.join(b.cache, file('SYNA', '2026-11')), 'a-1X'))).toMatch(/SYNAUSDT-1m-2026-11\.zip is not the venue's file/);
    expect(broken((b) => fs.rmSync(path.join(b.cache, `${file('SYNB', '2026-11')}.CHECKSUM`)))).toMatch(/SYNBUSDT-1m-2026-11\.zip has no venue checksum beside it/);
    expect(broken((b) => fs.writeFileSync(path.join(b.cache, `${file('SYNB', '2026-11')}.CHECKSUM`), 'not a checksum\n'))).toMatch(/SYNBUSDT-1m-2026-11\.zip\.CHECKSUM holds no sha256/);
    expect(broken((b) => fs.writeFileSync(path.join(b.cache, `${file('SYNB', '2026-11')}.ABSENT`), record('SYNB', '2026-11')))).toMatch(/SYNBUSDT-1m-2026-11\.zip is in the store and recorded as absent/);
    expect(broken((b) => fs.rmSync(path.join(b.overlay, `${file('SYNB', '2026-12')}.ABSENT`)))).toMatch(/SYNBUSDT-1m-2026-12\.zip is neither in the store nor recorded as absent/);
    // the overlay's file is the one read, so the overlay's checksum is the one that counts
    expect(broken((b) => fs.rmSync(path.join(b.overlay, `${file('SYNA', '2026-12')}.CHECKSUM`)))).toMatch(/SYNAUSDT-1m-2026-12\.zip has no venue checksum beside it/);

    // "absent" is a checked record {url, status, probed_at}, never a file that merely exists
    const gone = `${file('SYNB', '2026-12')}.ABSENT`;
    const withRecord = (text: string, where: 'overlay' | 'cache' = 'overlay'): string => broken((b) => fs.writeFileSync(path.join(b[where], gone), text));
    const NOT_A_RECORD = /SYNBUSDT-1m-2026-12\.zip\.ABSENT is not a probe record \(JSON \{url, status, probed_at\}\)/;
    for (const text of ['', '\n', 'HTTP 404\n', 'null', '[]', '"404"', '{', JSON.stringify({ url: archiveUrl('SYNB', '2026-12'), status: 404 }), record('SYNB', '2026-12', { note: 'by hand' })]) expect(withRecord(text), JSON.stringify(text)).toMatch(NOT_A_RECORD);
    // the URL is the one the harness derives for that coin-month: another month, another coin, another origin refuse
    const OTHER_URL = /SYNBUSDT-1m-2026-12\.zip\.ABSENT records another URL than the venue's for this coin-month/;
    for (const url of [archiveUrl('SYNB', '2026-11'), archiveUrl('SYNA', '2026-12'), archiveUrl('SYNB', '2026-12', 'http://127.0.0.1:8080'), `${archiveUrl('SYNB', '2026-12')}.CHECKSUM`, 404]) expect(withRecord(record('SYNB', '2026-12', { url })), String(url)).toMatch(OTHER_URL);
    // the status is the number 404: a served month, a venue error and a string are not "the venue serves none"
    for (const status of [200, 301, 403, 500, 503, '404', null]) expect(withRecord(record('SYNB', '2026-12', { status })), String(status)).toMatch(new RegExp(`\\.ABSENT records HTTP ${JSON.stringify(status)}, not 404`));
    // the probe time is ISO UTC, on or after the registered read date: an earlier 404 may be a month not yet published
    const NO_TIME = /SYNBUSDT-1m-2026-12\.zip\.ABSENT holds no ISO UTC probe time/;
    for (const probed_at of ['2027-06-16T08:00:00+08:00', '2027-06-16', '2027-06-16 00:00:00Z', '2027-13-45T00:00:00Z', 'Wed, 16 Jun 2027 00:00:00 GMT', Date.parse(NB), null]) expect(withRecord(record('SYNB', '2026-12', { probed_at })), String(probed_at)).toMatch(NO_TIME);
    const EARLY = /SYNBUSDT-1m-2026-12\.zip\.ABSENT was probed before the registered read date \(2027-06-16T00:00:00Z\)/;
    for (const probed_at of ['2027-06-15T23:59:59.999Z', '2027-06-15T23:59:59Z', '2026-11-17T04:00:00Z']) expect(withRecord(record('SYNB', '2026-12', { probed_at })), probed_at).toMatch(EARLY);
    // every record found is checked: a good one in the cache does not cover an unchecked one in the overlay
    expect(broken((b) => { fs.writeFileSync(path.join(b.cache, gone), record('SYNB', '2026-12')); fs.writeFileSync(path.join(b.overlay, gone), ''); })).toMatch(NOT_A_RECORD);
    // accepted: probed at the read date itself, or later, with or without milliseconds, from either store
    const accepted = (change: (b: ArchiveStore) => void): void => {
      const b = mk(`ok${fs.readdirSync(dir).length}`);
      for (const k of ['cache', 'overlay'] as const) fs.cpSync(a[k], b[k], { recursive: true });
      change(b);
      expect(check(b)).toMatchObject({ ok: true, reason: 'ok', later: { absent: [file('SYNB', '2026-12')] } });
    };
    for (const probed_at of [NB, '2027-06-16T00:00:00.000Z', '2027-06-29T12:34:56.789Z']) accepted((b) => fs.writeFileSync(path.join(b.overlay, gone), record('SYNB', '2026-12', { probed_at })));
    accepted((b) => { fs.rmSync(path.join(b.overlay, gone)); fs.writeFileSync(path.join(b.cache, gone), record('SYNB', '2026-12')); });
    // and a study that verifies months at read time registers its read date: without one nothing is "on or after" it
    for (const nb of [null, '', 'soon']) expect(check(a, nb), String(nb)).toMatchObject({ ok: false, reason: 'the study registers no read date to check a probe record against' });
  });

  it('the URL the harness derives for a coin-month is the reader\'s (T3 §3): the template of scripts/odds-calibration-study.py, with <COIN>USDT', () => {
    const m = /^ARCHIVE_URL = "([^"]+)"$/m.exec(fs.readFileSync(path.join(REPO, 'scripts/odds-calibration-study.py'), 'utf8'));
    expect(m).not.toBeNull();
    const template = (m as RegExpExecArray)[1];
    expect(template.match(/\{[a-z]+\}/g)).toEqual(['{sym}', '{sym}', '{ym}']);
    for (const [coin, ym] of [['SYNA', '2026-11'], ['SYNB', '2027-05'], ['1000SYN', '2027-01']]) {
      expect(archiveUrl(coin, ym), `${coin} ${ym}`).toBe(template.replaceAll('{sym}', `${coin}USDT`).replaceAll('{ym}', ym));
      // the file it names is the archive's own name, at the venue's origin
      expect(archiveUrl(coin, ym)).toBe(`${ARCHIVE_ORIGIN}${new URL(archiveUrl(coin, ym)).pathname}`);
      expect(path.posix.basename(new URL(archiveUrl(coin, ym)).pathname)).toBe(archiveName(coin, '1m', ym));
      // another origin moves the origin alone (the probe's tests answer on 127.0.0.1)
      expect(archiveUrl(coin, ym, 'http://127.0.0.1:8080')).toBe(`http://127.0.0.1:8080${new URL(archiveUrl(coin, ym)).pathname}`);
    }
    expect(new URL(ARCHIVE_ORIGIN).origin).toBe(ARCHIVE_ORIGIN);
  });
});
