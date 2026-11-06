/**
 * OPS-HOST-EXPOSURE-POSTURE-W1 — the repo-side guard on the declared network posture.
 *
 * `ops/monitoring/network-posture.json` is the SoT that the reconciler's POSTURE_DRIFT check
 * asserts live reachability against. This file guards the DECLARATION itself: that it stays
 * address-free in a PUBLIC repo, that every source alias resolves, that an `any` is always a
 * recorded decision rather than an oversight, and that the empirical ufw negative cannot be
 * quietly dropped by a later edit.
 *
 * Runtime cross-host reachability is POSTURE_DRIFT's job, not this file's. Run by the pre-push
 * test-gate (node --test).
 *
 * Fixture addresses below are RFC-5737 documentation ranges on purpose: the self-check must
 * exercise the address regex without adding a fresh occurrence of a real host address to a
 * public repo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const POSTURE = path.join(REPO, 'ops/monitoring/network-posture.json');
const raw = readFileSync(POSTURE, 'utf8');
const doc = JSON.parse(raw);

const IPV4 = /\b\d{1,3}(\.\d{1,3}){3}\b/g;

/**
 * Addresses that are safe to write down: loopback, the RFC-1918 docker bridge gateways, and the
 * "no restriction" wildcard. Anything else in this file is a published host address.
 */
const isNonRoutable = (ip) =>
  ip === '0.0.0.0' ||
  ip.startsWith('127.') ||
  ip.startsWith('10.') ||
  ip.startsWith('192.168.') ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

test('the declaration carries no literal public address (this repo is PUBLIC)', () => {
  const offenders = [...new Set(raw.match(IPV4) ?? [])].filter((ip) => !isNonRoutable(ip));
  assert.deepEqual(
    offenders,
    [],
    `network-posture.json contains literal public address(es): ${offenders.join(', ')}. ` +
      'Use an opaque host label (signal-1 / aoe-1) or a named source alias; label→address ' +
      'resolution belongs in ssh config or host env, never in this committed JSON. Unlike ' +
      'monitoring-inventory.json this file has NO legacy rows, so the rule is absolute here.',
  );
});

test('every allowed_sources entry resolves to a declared source alias', () => {
  const aliases = new Set(Object.keys(doc.source_aliases));
  for (const [host, cfg] of Object.entries(doc.hosts)) {
    for (const rule of cfg.inbound) {
      for (const src of rule.allowed_sources) {
        assert.ok(
          aliases.has(src),
          `${host}:${rule.port}/${rule.proto} references undeclared source alias "${src}". ` +
            'A typo here does not fail loudly — it silently narrows the declared set, and ' +
            'POSTURE_DRIFT would then read a legitimately-open port as unexpected.',
        );
      }
    }
  }
});

test('an `any` is always a recorded decision, never a bare default', () => {
  for (const [host, cfg] of Object.entries(doc.hosts)) {
    for (const rule of cfg.inbound) {
      if (!rule.allowed_sources.includes('any')) continue;
      assert.ok(
        rule.justification && rule.justification.length > 40,
        `${host}:${rule.port}/${rule.proto} is open to the world with no justification. ` +
          'An unexplained `any` reads as an oversight to the next reader; a justified one ' +
          'reads as a decision.',
      );
      assert.equal(
        rule.classification,
        'asserted-any',
        `${host}:${rule.port}/${rule.proto} allows "any" but is not classified asserted-any`,
      );
      assert.ok(
        rule.narrowed_by_wave,
        `${host}:${rule.port}/${rule.proto} is asserted-any with no wave named to narrow it — ` +
          'that is how a temporary exposure becomes permanent',
      );
    }
  }
});

test('every classification is drawn from the declared vocabulary', () => {
  const vocab = new Set(Object.keys(doc._classification_semantics));
  for (const [host, cfg] of Object.entries(doc.hosts)) {
    for (const rule of [...cfg.inbound, ...(cfg.loopback_only ?? [])]) {
      assert.ok(
        vocab.has(rule.classification),
        `${host}:${rule.port} has undeclared classification "${rule.classification}"`,
      );
    }
  }
});

test('the empirical ufw negative cannot be silently dropped', () => {
  // A recorded empirical negative is the only thing stopping a future wave from "adding ufw for
  // defense in depth" and reintroducing lockout risk in exchange for zero enforcement.
  for (const [host, cfg] of Object.entries(doc.hosts)) {
    const ufw = cfg.in_vm_layer?.ufw;
    assert.equal(ufw?.state, 'intentionally-absent', `${host}: ufw state must stay declared`);
    assert.ok(
      /filter\/INPUT/.test(ufw.evidence) && /FORWARD/.test(ufw.evidence),
      `${host}: the ufw ruling lost its DNAT→FORWARD-bypasses-INPUT evidence. Without the ` +
        'mechanism recorded, the ruling is just an opinion and gets re-litigated.',
    );
    assert.ok(ufw.do_not_re_litigate, `${host}: ufw ruling lost its do-not-re-litigate note`);
    assert.equal(
      cfg.in_vm_layer?.docker_user_chain?.state,
      'declared-empty',
      `${host}: DOCKER-USER emptiness must be declared intentional, or it reads as unfinished work`,
    );
  }
});

test('udp/443 never diverges from tcp/443 — the lock is cosmetic if it does', () => {
  // OPS-CF-ORIGIN-LOCK-W1. Locking tcp/443 while leaving udp/443 open does not narrow the
  // origin at all: anyone who knows the address simply speaks HTTP/3 instead. The measured
  // traffic being on :80 and bare-IP reflects what scanners CHOSE, never what was available.
  // The duplication is deliberate, so this guard exists to stop a future tidy-up splitting it.
  for (const [host, cfg] of Object.entries(doc.hosts)) {
    const tcp443 = cfg.inbound.find((r) => r.port === 443 && r.proto === 'tcp');
    const udp443 = cfg.inbound.find((r) => r.port === 443 && r.proto === 'udp');
    if (!tcp443 && !udp443) continue;
    assert.ok(
      tcp443 && udp443,
      `${host}: 443 is declared for only one protocol — H3 and H2 must both be governed`,
    );
    assert.deepEqual(
      [...udp443.allowed_sources].sort(),
      [...tcp443.allowed_sources].sort(),
      `${host}: udp/443 (HTTP/3) source set has diverged from tcp/443. An unlocked udp/443 ` +
        'makes the whole origin lock cosmetic.',
    );
    assert.ok(
      udp443.shares_source_set_with === '443/tcp',
      `${host}: udp/443 must record that it shares tcp/443's source set BY DESIGN, or a future ` +
        'wave reads the duplication as an error and "fixes" it',
    );
  }
});

test('a locked port records why it is restricted, and :80 records why it is NOT closed', () => {
  const sig = doc.hosts['signal-1'];
  for (const rule of sig.inbound.filter((r) => r.classification === 'restrict-to-source')) {
    assert.ok(
      rule.justification && rule.justification.length > 40,
      `signal-1:${rule.port}/${rule.proto} is restricted with no recorded reason`,
    );
  }
  const p80 = sig.inbound.find((r) => r.port === 80);
  assert.ok(
    p80.why_not_closed,
    ':80 must record WHY it stays open-to-CF rather than closed — closing it was predicated on ' +
      'DNS-01, and without that note a later wave closes it and breaks renewal ~60 days later',
  );
  assert.ok(
    sig.dns01_deferred?.blocker,
    'the DNS-01 blocker must stay recorded so it is not re-derived',
  );
});

test('the github-actions dead end stays marked unusable', () => {
  const gha = doc.source_aliases['github-actions'];
  assert.equal(
    gha.usable,
    false,
    'github-actions must stay marked unusable — 7,297 CIDRs against a 2,500-rule/server ' +
      'ceiling. Recorded so the next wave does not re-derive the same dead end.',
  );
  assert.ok(gha.count_at_owner_wave > 2500, 'the count that makes it unusable must stay recorded');
});

// OPS-CVE-2026-98432-INTERIM-W1 — the ONE in-VM exception to "the cloud firewall is the only
// enforcement layer". It must stay DECLARED on every host, so that claim is never silently false. It
// must stay TIME-BOXED: the removal trigger names the floor row, never a date or a bare version. And
// it must stay in step with the committed bytes that enforce it.
const NFT = path.join(REPO, 'ops/systemd/cve-2026-98432/cve-2026-98432.nft');
const FLOORS = path.join(REPO, 'ops/monitoring/kernel-cve-floors.json');
const nftCode = (text) => text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
const verdictRules = (text) => nftCode(text).split('\n')
  .filter((l) => /\b(accept|drop|reject)\b/.test(l) && !/\bpolicy\b/.test(l));

test('the CVE-2026-98432 in-VM exception is declared on every host, time-boxed, and matches its ruleset', () => {
  const row = JSON.parse(readFileSync(FLOORS, 'utf8')).floors.find((r) => r.cve === 'CVE-2026-98432');
  assert.ok(row?.mitigation, 'kernel-cve-floors.json lost the CVE-2026-98432 row or its mitigation');
  assert.match(doc._enforcement_semantics, /in_vm_layer\.cve_2026_98432/,
    '_enforcement_semantics must name the exception, or its "ONLY enforcement layer" claim is false');
  for (const [host, cfg] of Object.entries(doc.hosts)) {
    const ex = cfg.in_vm_layer?.cve_2026_98432;
    assert.equal(ex?.state, 'interim-mitigation', `${host}: the in-VM exception is not declared`);
    assert.ok(ex.rollback?.includes('systemctl disable --now cve-2026-98432-nft.service'),
      `${host}: the per-host rollback is not recorded`);
  }
  const trigger = doc.hosts['signal-1'].in_vm_layer.cve_2026_98432.removal_trigger;
  assert.match(trigger, /kernel-cve-floors\.json/, 'the removal trigger must point at the floor row');
  assert.match(trigger, /dpkg --compare-versions/, 'the removal trigger must compare PACKAGE versions');
  assert.doesNotMatch(trigger, /\b6\.8\.0-\d+\.\d+\b/, 'a bare version here is a second copy of the floor');

  const ruleset = readFileSync(NFT, 'utf8');
  const m = row.mitigation;
  assert.ok(nftCode(ruleset).includes(`table ${m.nft_family} ${m.nft_table} {`),
    'the committed ruleset does not define the table the floors row declares');
  assert.match(nftCode(ruleset), /type filter hook prerouting priority -310;/,
    'prerouting at -310 is what covers Docker-published ports (DNAT at -100)');
  assert.doesNotMatch(nftCode(ruleset), /flush\s+ruleset/, 'the ruleset must never clobber Docker/f2b/nftables.service');
  const rules = verdictRules(ruleset);
  assert.equal(rules.length, 1, `exactly ONE verdict rule expected, found ${rules.length}`);
  assert.ok(rules[0].includes(m.nft_rule_match) && /\bdrop\b/.test(rules[0]),
    `the one rule must ${m.nft_rule_verdict} \`${m.nft_rule_match}\`: ${rules[0]}`);
});

test('self-check: every detector fires on a known-bad fixture (both directions)', () => {
  // In-VM exception detectors (OPS-CVE-2026-98432-INTERIM-W1).
  assert.match(nftCode('flush ruleset\ntable inet x {}'), /flush\s+ruleset/, 'flush detector would not fire');
  assert.doesNotMatch(nftCode('# flush ruleset is forbidden here\ntable inet x {}'), /flush\s+ruleset/,
    'flush detector would false-fire on a comment');
  assert.equal(verdictRules('type filter hook prerouting priority -310; policy accept;\nip hdrlength > 5 drop\ntcp dport 22 accept').length, 2,
    'verdict-rule counter would not see a second rule');

  // Address detector — RFC-5737 documentation addresses, never a real host address.
  assert.ok(!isNonRoutable('198.51.100.7'), 'address detector would not fire on a public address');
  assert.ok(isNonRoutable('127.0.0.1') && isNonRoutable('172.18.0.1') && isNonRoutable('0.0.0.0'),
    'address detector would false-fire on a legitimately non-routable address');

  // Unresolved-alias detector.
  const aliases = new Set(['any', 'cloudflare']);
  assert.ok(!aliases.has('cloudfare'), 'alias detector would not fire on a typo');

  // Bare-`any` detector.
  const bad = { allowed_sources: ['any'], justification: 'short', classification: 'must-stay-public' };
  assert.ok(!(bad.justification.length > 40), 'justification detector would not fire');
  assert.notEqual(bad.classification, 'asserted-any', 'classification detector would not fire');

  // ufw-negative detector.
  assert.ok(!/filter\/INPUT/.test('ufw is off because we said so'),
    'ufw-evidence detector would not fire on an evidence-free ruling');
});
