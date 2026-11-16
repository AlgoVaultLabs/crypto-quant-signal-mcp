// tests/unit/regime-diag-probe.test.ts — EDGE-REGIME-CONFIRM-W1 CH1: the absence probe.
// A coin-month the venue serves no archive of is "absent" only by a record the probe wrote on an HTTP 404. Every
// request here goes to a stub on 127.0.0.1: no test reaches the venue, or any other host.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARCHIVE_ORIGIN, archiveName, archiveUrl, type ArchiveStore } from '../../src/scripts/regime-diag/archive.js';
import { HARNESS_FILES, checkLaterArchives } from '../../src/scripts/regime-diag/guard.js';
import { PROBE_TOKEN, probeAbsent, type ProbeInput } from '../../src/scripts/regime-diag/probe-absent.js';

const REPO = path.resolve(__dirname, '../..');
const PROBE = 'src/scripts/regime-diag/probe-absent.ts';
const YM = '2026-11';
/** What the stub answers, by the coin in the path. A coin it does not know is never answered: the timeout case. */
const ANSWERS: Record<string, number> = { SYNA: 404, SYNB: 200, SYNC: 503, SYND: 301, SYNE: 403, SYNF: 429, SYNG: 500, SYNH: 204, SYNI: 410 };
const NOW = Date.parse('2027-06-16T00:00:05.250Z');

describe('regime-diag: the absence probe records a coin-month only on HTTP 404', () => {
  let dir = '', origin = '', closed = '';
  let server: http.Server;
  const hits: string[] = [];
  const fresh = (): string => fs.mkdtempSync(path.join(dir, 'store-'));
  const probe = (coin: string, more: Partial<ProbeInput> = {}): ReturnType<typeof probeAbsent> => probeAbsent({ coin, ym: YM, dir: fresh(), origin, now: () => NOW, timeoutMs: 5_000, ...more });

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-diag-probe-'));
    server = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      const code = ANSWERS[/\/klines\/([A-Z0-9]+)USDT\//.exec(req.url ?? '')?.[1] ?? ''];
      if (code === undefined) return;
      // the redirect points at a URL that answers 404: a probe that followed it would record an absence nobody measured
      res.writeHead(code, code === 301 ? { location: archiveUrl('SYNA', YM, origin) } : {});
      res.end();
    });
    await new Promise<void>((ok) => { server.listen(0, '127.0.0.1', ok); });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // a port nothing listens on: bound once, then released
    const spare = http.createServer();
    await new Promise<void>((ok) => { spare.listen(0, '127.0.0.1', ok); });
    closed = `http://127.0.0.1:${(spare.address() as AddressInfo).port}`;
    await new Promise<void>((ok) => { spare.close(() => ok()); });
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((ok) => { server.close(() => ok()); });
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('HTTP 404: one record {url, status, probed_at}, of the URL it probed, by a HEAD request', async () => {
    const store = fresh(), before = hits.length;
    const r = await probe('SYNA', { dir: store });
    const name = archiveName('SYNA', '1m', YM), url = archiveUrl('SYNA', YM, origin);
    expect(r).toEqual({ verdict: 'ABSENT', reason: `HTTP 404: recorded ${name}.ABSENT`, url, file: path.join(store, `${name}.ABSENT`) });
    expect(hits.slice(before)).toEqual([`HEAD ${new URL(url).pathname}`]);
    // the record and nothing else: no temporary file is left beside it
    expect(fs.readdirSync(store)).toEqual([`${name}.ABSENT`]);
    const text = fs.readFileSync(r.file as string, 'utf8');
    expect(text).toBe(`${JSON.stringify({ url, status: 404, probed_at: '2027-06-16T00:00:05.250Z' })}\n`);
    expect(Object.keys(JSON.parse(text) as object)).toEqual(['url', 'status', 'probed_at']);
  });

  it('any other status records nothing and says which: a served month, a redirect, a venue error', async () => {
    for (const [coin, code] of Object.entries(ANSWERS).filter(([, c]) => c !== 404)) {
      const store = fresh(), name = archiveName(coin, '1m', YM);
      // a record already there is left as it was: the probe writes on a 404 and touches nothing otherwise
      fs.writeFileSync(path.join(store, `${name}.ABSENT`), 'kept\n');
      const r = await probe(coin, { dir: store });
      expect(r, coin).toEqual(code === 200
        ? { verdict: 'SERVED', reason: `HTTP 200: the venue serves ${name}; nothing recorded`, url: archiveUrl(coin, YM, origin), file: null }
        : { verdict: 'INDETERMINATE', reason: `HTTP ${code}: nothing recorded`, url: archiveUrl(coin, YM, origin), file: null });
      expect([fs.readdirSync(store), fs.readFileSync(path.join(store, `${name}.ABSENT`), 'utf8')], coin).toEqual([[`${name}.ABSENT`], 'kept\n']);
      expect(fs.readdirSync(fresh()), coin).toEqual([]);
    }
    // the redirect was not followed: the URL it points at answers 404, and nothing asked for it
    const before = hits.length, store = fresh();
    expect((await probe('SYND', { dir: store })).reason).toBe('HTTP 301: nothing recorded');
    expect([hits.slice(before).length, fs.readdirSync(store)]).toEqual([1, []]);
  });

  it('a transport error and a timeout record nothing, each by name', async () => {
    const a = fresh(), b = fresh();
    const refused = await probe('SYNA', { dir: a, origin: closed });
    expect([refused.verdict, refused.file, fs.readdirSync(a)]).toEqual(['INDETERMINATE', null, []]);
    expect(refused.reason).toMatch(/^transport error \([A-Z_]+\): nothing recorded$/);
    const before = hits.length;
    const hung = await probe('SYNZ', { dir: b, timeoutMs: 250 });
    expect([hung.verdict, hung.reason, hung.file, fs.readdirSync(b)]).toEqual(['INDETERMINATE', 'timeout after 250 ms: nothing recorded', null, []]);
    expect(hits.slice(before)).toHaveLength(1); // the request was made, and never answered
  });

  it('it probes one coin-month of a store that exists: anything else is INDETERMINATE before a request is made', async () => {
    const before = hits.length;
    const bad: Array<Partial<ProbeInput> & { coin?: string }> = [
      { coin: '' }, { coin: 'syna' }, { coin: 'SYNA/../X' }, { ym: '2026-13' }, { ym: '2026-1' }, { ym: '202611' },
      { dir: path.join(dir, 'no-such-store') }, { dir: '' }, { origin: 'ftp://127.0.0.1' }, { origin: `${origin}/` }, { origin: 'not a url' }, { timeoutMs: 0 }, { timeoutMs: Number.NaN },
      // the probe asks the venue, or a stub on 127.0.0.1: no other origin, loopback names included
      { origin: closed.replace('127.0.0.1', 'localhost') }, { origin: closed.replace('http:', 'https:') }, { origin: closed.replace('127.0.0.1', '[::1]') }, { origin: 'http://127.0.0.1' }, { origin: closed.replace('127.0.0.1', '127.0.0.2') },
    ];
    for (const more of bad) {
      const r = await probe(more.coin ?? 'SYNA', more);
      expect([r.verdict, r.url, r.file], JSON.stringify(more)).toEqual(['INDETERMINATE', null, null]);
      expect(r.reason, JSON.stringify(more)).toMatch(/^usage: /);
    }
    expect(hits.length).toBe(before);
  });

  it('the harness accepts the probe\'s record of the venue\'s URL, and no record made at another origin', async () => {
    const mk = (): ArchiveStore => { const a = { cache: fresh(), overlay: fresh() }; return a; };
    const later = (a: ArchiveStore, notBefore: string): ReturnType<typeof checkLaterArchives> => checkLaterArchives(a, ['SYNA'], [YM], notBefore);
    // against the stub: a true 404, of another URL than the venue's
    const stub = mk();
    expect((await probe('SYNA', { dir: stub.overlay })).verdict).toBe('ABSENT');
    expect(later(stub, '2027-06-16T00:00:00Z')).toMatchObject({ ok: false, reason: expect.stringMatching(/\.ABSENT records another URL than the venue's for this coin-month$/) });
    // at the venue's origin (the default), answered by a stand-in for the transport alone: the request is a HEAD of
    // the URL the harness derives, and the record is accepted as written
    const venue = mk(), asked: Array<[string, string, string]> = [];
    const r = await probeAbsent({ coin: 'SYNA', ym: YM, dir: venue.overlay, now: () => NOW, fetch: async (url, init) => { asked.push([url, init.method, init.redirect]); return { status: 404 }; } });
    expect([r.verdict, r.url]).toEqual(['ABSENT', archiveUrl('SYNA', YM)]);
    expect(asked).toEqual([[archiveUrl('SYNA', YM), 'HEAD', 'manual']]);
    expect(archiveUrl('SYNA', YM).startsWith(`${ARCHIVE_ORIGIN}/`)).toBe(true);
    expect(later(venue, '2027-06-16T00:00:00Z')).toMatchObject({ ok: true, later: { files: [], absent: [archiveName('SYNA', '1m', YM)] } });
    expect(later(venue, '2027-06-16T00:00:05.250Z').ok).toBe(true);
    // the same record under a later read date: probed too early
    expect(later(venue, '2027-06-16T00:00:05.251Z')).toMatchObject({ ok: false, reason: expect.stringMatching(/\.ABSENT was probed before the registered read date/) });
    // and the stand-in records on a 404 alone, as the transport does
    const none = fresh();
    const served = await probeAbsent({ coin: 'SYNA', ym: YM, dir: none, now: () => NOW, fetch: async () => ({ status: 503 }) });
    expect([served.verdict, served.reason, fs.readdirSync(none)]).toEqual(['INDETERMINATE', 'HTTP 503: nothing recorded', []]);
  });

  it('the run path never imports the probe: it is its own CLI, pinned with the harness', () => {
    expect(HARNESS_FILES).toContain(PROBE);
    const home = path.join(REPO, 'src/scripts/regime-diag');
    const others = fs.readdirSync(home).filter((f) => f.endsWith('.ts') && f !== 'probe-absent.ts');
    expect(others.length).toBeGreaterThan(10);
    for (const f of others) expect(fs.readFileSync(path.join(home, f), 'utf8'), f).not.toMatch(/(from|import|require)\s*\(?\s*['"][^'"]*probe-absent/);
    // and it reads nothing of a study: the archive names, and node
    const imports = [...fs.readFileSync(path.join(REPO, PROBE), 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual(['node:fs', 'node:path', './archive.js']);
  });

  const cli = (...args: string[]): Promise<{ code: number; stdout: string }> =>
    promisify(execFile)(path.join(REPO, 'node_modules/.bin/tsx'), [path.join(REPO, PROBE), ...args], { cwd: REPO, timeout: 80_000 })
      .then((x) => ({ code: 0, stdout: x.stdout }), (e: { code: number; stdout: string }) => ({ code: e.code, stdout: e.stdout }));

  it('the CLI: ABSENT exits 0 with the record written; SERVED exits 1 and INDETERMINATE exits 3, with nothing written', { timeout: 90_000 }, async () => {
    const [a, b, c, d, e] = [fresh(), fresh(), fresh(), fresh(), fresh()];
    const run = (coin: string, store: string, at: string = origin): Promise<{ code: number; stdout: string }> => cli('--coin', coin, '--month', YM, '--dir', store, '--origin', at, '--timeout-ms', '20000');
    const [absent, served, error, refused, usage, nodir] = await Promise.all([
      run('SYNA', a), run('SYNB', b), run('SYNC', c), run('SYNA', d, closed), cli('--coin', 'SYNA', '--dir', e), cli('--coin', 'SYNA', '--month', YM, '--dir', '--origin', origin),
    ]);
    const name = archiveName('SYNA', '1m', YM);
    expect([absent.code, absent.stdout]).toEqual([0, `${PROBE_TOKEN}=ABSENT — HTTP 404: recorded ${name}.ABSENT\n`]);
    expect([served.code, served.stdout]).toEqual([1, `${PROBE_TOKEN}=SERVED — HTTP 200: the venue serves ${archiveName('SYNB', '1m', YM)}; nothing recorded\n`]);
    expect([error.code, error.stdout]).toEqual([3, `${PROBE_TOKEN}=INDETERMINATE — HTTP 503: nothing recorded\n`]);
    expect([refused.code, refused.stdout]).toEqual([3, expect.stringMatching(new RegExp(`^${PROBE_TOKEN}=INDETERMINATE — transport error \\([A-Z_]+\\): nothing recorded\\n$`))]);
    for (const u of [usage, nodir]) expect([u.code, u.stdout]).toEqual([3, expect.stringMatching(new RegExp(`^${PROBE_TOKEN}=INDETERMINATE — usage: `))]);
    expect([a, b, c, d, e].map((s) => fs.readdirSync(s))).toEqual([[`${name}.ABSENT`], [], [], [], []]);
    // the CLI's record: the URL it probed, 404, and its own clock in ISO UTC
    const rec = JSON.parse(fs.readFileSync(path.join(a, `${name}.ABSENT`), 'utf8')) as { url: string; status: number; probed_at: string };
    expect([rec.url, rec.status, Object.keys(rec)]).toEqual([archiveUrl('SYNA', YM, origin), 404, ['url', 'status', 'probed_at']]);
    expect(rec.probed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Math.abs(Date.parse(rec.probed_at) - Date.now())).toBeLessThan(120_000);
  });
});
