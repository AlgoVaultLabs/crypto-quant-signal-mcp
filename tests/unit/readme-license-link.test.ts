/**
 * OPS-README-LICENSE-LINK-W1 — the README licence badge links the licence this package ships.
 *
 * Deploy run 36688203040 (2026-09-30T08:17Z) went red at the post-deploy README link gate on one
 * URL: the badge href `https://opensource.org/licenses/MIT` answered 403. It answered 403 to GET
 * and HEAD, with a browser UA or without, from the GitHub runner, the operator Mac AND signal-1
 * (edge `server: cloudflare`, `server-timing: a8c-cdn`). Re-probed 09:35Z from the Mac and
 * signal-1: 301 to `/license/MIT`, then 200.
 *
 * Why the badge moved instead of the allowlist growing. `EXPECTED_STATUS` admits a STABLE status
 * that one vantage reproduces on every probe (Basescan and npmjs from datacenter egress). A 403
 * that every vantage saw and that then healed is a third party's edge event. An entry for it would
 * carry a false "measured" reason and exempt the URL forever. The old href was also a legacy path
 * that now redirects. The package's own LICENSE sits on the host the README already links ten
 * times, and all ten resolved from the runner on the five deploys before this one. It is also the
 * text that actually governs the package, copyright line included.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { extractUrls, EXPECTED_STATUS } from '../../scripts/check-readme-links.mjs';

const ROOT = path.resolve(__dirname, '../..');
const GATE = path.join(ROOT, 'scripts/check-readme-links.mjs');
const README = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const LICENSE = readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** The repository package.json declares, as the https page a reader lands on. */
function repoPage(): string {
  const raw: string = typeof PKG.repository === 'string' ? PKG.repository : PKG.repository.url;
  return raw.replace(/^git\+/, '').replace(/\.git$/, '');
}

/** Every href wrapping the shields.io licence badge. One is expected; more is itself a finding. */
function licenceBadgeHrefs(md: string): string[] {
  return [...md.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>\s*<img\s[^>]*src="https:\/\/img\.shields\.io\/badge\/License-/gi)].map(
    (m) => m[1],
  );
}

describe('README licence badge', () => {
  const expected = `${repoPage()}/blob/main/LICENSE`;

  it('links the LICENSE file of the repository package.json names', () => {
    expect(repoPage()).toBe('https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp');
    expect(licenceBadgeHrefs(README)).toEqual([expected]);
  });

  it('is an absolute URL the live gate extracts and probes', () => {
    // A relative `LICENSE` href would be invisible to the gate, which only probes http(s) URLs.
    expect(extractUrls(README)).toContain(expected);
  });

  it('links a licence that agrees with package.json and ships in the tarball', () => {
    expect(PKG.license).toBe('MIT');
    expect(LICENSE.split('\n')[0].trim()).toBe('MIT License');
    expect(PKG.files).toContain('LICENSE');
  });

  it('no longer depends on opensource.org', () => {
    expect(extractUrls(README).filter((u) => new URL(u).hostname.endsWith('opensource.org'))).toEqual([]);
  });
});

describe('check-readme-links allowlist', () => {
  it('holds no exemption for a URL the README does not contain', () => {
    // An exemption that outlives its link is dead weight the next reader has to reverse-engineer.
    const urls = new Set(extractUrls(README));
    const stale = [...EXPECTED_STATUS.keys()].filter((u) => !urls.has(u));
    expect(EXPECTED_STATUS.size).toBeGreaterThan(0);
    expect(stale).toEqual([]);
  });
});

describe('check-readme-links CLI', () => {
  it('still runs main and emits its token when executed directly', { timeout: 60000 }, () => {
    // The import guard that lets this file load the gate must never silence the deploy step,
    // which gates on this token. The self-test is hermetic: its only server is on 127.0.0.1.
    const res = spawnSync(process.execPath, [GATE, '--self-test'], { encoding: 'utf8', timeout: 55000 });
    expect(res.stdout).toMatch(/README_LINKS_VERDICT=PASS\s*$/);
    expect(res.status).toBe(0);
  });
});
