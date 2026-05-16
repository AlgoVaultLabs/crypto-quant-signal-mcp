/**
 * ERC-8004-W1 / C3 — /api/erc-8004-reputation public-shape lock.
 *
 * Asserts the canonical Amendment-C (Path-3 'pending') shape + forbidden-key
 * canary + drift-check semantics. Locked against
 * audits/api-erc-8004-reputation-shape-snapshot-2026-05-16.json.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildErc8004ReputationBody,
  type Erc8004ReputationBody,
} from '../../src/lib/erc8004-reputation.js';
import { IDENTITY_REGISTRY_ADDRESS } from '../../src/lib/erc8004.js';

const FORBIDDEN_KEY_RE = /outcome_return_pct|outcome_price|phase_e/i;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHAPE_SNAPSHOT_PATH = join(
  REPO_ROOT,
  'audits',
  'api-erc-8004-reputation-shape-snapshot-2026-05-16.json',
);

function collectAllKeys(obj: unknown, acc: string[] = []): string[] {
  if (obj === null || typeof obj !== 'object') return acc;
  if (Array.isArray(obj)) {
    for (const item of obj) collectAllKeys(item, acc);
    return acc;
  }
  for (const [k, v] of Object.entries(obj)) {
    acc.push(k);
    collectAllKeys(v, acc);
  }
  return acc;
}

describe('/api/erc-8004-reputation shape (Path 3 / Amendment C)', () => {
  const body: Erc8004ReputationBody = buildErc8004ReputationBody({
    pkgVersion: '1.12.0',
    agentId: '44544',
    firstRegisteredAt: '2026-04-12T08:57:21Z',
    freshnessSeconds: 0,
  });

  it('locks the canonical Amendment-C shape', () => {
    expect(body).toEqual({
      agent_id: '44544',
      registry: 'ERC-8004',
      chain: 'base',
      chain_id: 8453,
      identity_registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
      attestation_registry: null,
      score: null,
      total_attestations: 0,
      status: 'pending',
      status_message:
        'Identity verified on-chain via ERC-8004 Identity Registry. Attestation pipeline rolling out — interim verification via /api/merkle-batches.',
      first_registered_at: '2026-04-12T08:57:21Z',
      last_attestation_at: null,
      basescan_url:
        'https://basescan.org/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a=44544',
      _algovault: {
        version: '1.12.0',
        endpoint_version: 'v1',
        freshness_seconds: 0,
      },
    });
  });

  it('forbidden-key canary — no key matches /outcome_return_pct|outcome_price|phase_e/ at any depth', () => {
    const offenders = collectAllKeys(body).filter((k) =>
      FORBIDDEN_KEY_RE.test(k),
    );
    expect(offenders).toEqual([]);
  });

  it('forbidden-key canary — serialized JSON contains no forbidden tokens', () => {
    expect(FORBIDDEN_KEY_RE.test(JSON.stringify(body))).toBe(false);
  });

  it('basescan_url uses canonical Base mainnet Identity Registry address', () => {
    expect(body.basescan_url).toBe(
      `https://basescan.org/token/${IDENTITY_REGISTRY_ADDRESS}?a=44544`,
    );
  });

  it('returns null fields when agent_id env unset (graceful degradation)', () => {
    const empty = buildErc8004ReputationBody({
      pkgVersion: '1.12.0',
      agentId: null,
      firstRegisteredAt: null,
      freshnessSeconds: 0,
    });
    expect(empty.agent_id).toBeNull();
    expect(empty.basescan_url).toBeNull();
    expect(empty.first_registered_at).toBeNull();
    // status_message + identity_registry + chain still populated (env-independent constants).
    expect(empty.status).toBe('pending');
    expect(empty.identity_registry).toBe(IDENTITY_REGISTRY_ADDRESS);
  });

  it('freshness_seconds propagates from caller', () => {
    const aged = buildErc8004ReputationBody({
      pkgVersion: '1.12.0',
      agentId: '44544',
      firstRegisteredAt: '2026-04-12T08:57:21Z',
      freshnessSeconds: 287,
    });
    expect(aged._algovault.freshness_seconds).toBe(287);
  });

  it('Path-3 lock — score AND attestation_registry AND last_attestation_at all null; status=pending; total_attestations=0', () => {
    expect(body.score).toBeNull();
    expect(body.attestation_registry).toBeNull();
    expect(body.last_attestation_at).toBeNull();
    expect(body.status).toBe('pending');
    expect(body.total_attestations).toBe(0);
  });
});

describe('audits/api-erc-8004-reputation-shape-snapshot-2026-05-16.json', () => {
  const snapshot = JSON.parse(readFileSync(SHAPE_SNAPSHOT_PATH, 'utf-8'));

  it('exists and declares the required 6 CLAUDE.md Build-rule sections', () => {
    expect(snapshot.allowed_keys).toBeInstanceOf(Array);
    expect(snapshot.forbidden_keys).toBeInstanceOf(Array);
    expect(snapshot.error_contract).toBeTypeOf('object');
    expect(snapshot.cache_contract).toBeTypeOf('object');
    expect(snapshot.consumers).toBeInstanceOf(Array);
    expect(snapshot.drift_check_command).toBeTypeOf('string');
  });

  it("allowed_keys covers every top-level key the builder emits", () => {
    const builderKeys = Object.keys(
      buildErc8004ReputationBody({
        pkgVersion: '1.12.0',
        agentId: '44544',
        firstRegisteredAt: '2026-04-12T08:57:21Z',
        freshnessSeconds: 0,
      }),
    );
    for (const key of builderKeys) {
      expect(snapshot.allowed_keys).toContain(key);
    }
  });

  it('forbidden_keys includes the Data Integrity LAW tokens', () => {
    expect(snapshot.forbidden_keys).toContain('outcome_return_pct');
    expect(snapshot.forbidden_keys).toContain('outcome_price');
    expect(snapshot.forbidden_keys).toContain('phase_e_wr');
  });

  it('drift_check_command exits with DRIFT_CHECK_OK / DRIFT_CHECK_FAIL labels', () => {
    expect(snapshot.drift_check_command).toMatch(/DRIFT_CHECK_OK/);
    expect(snapshot.drift_check_command).toMatch(/DRIFT_CHECK_FAIL/);
  });

  it('cache_contract advertises 5-minute TTL', () => {
    expect(snapshot.cache_contract.ttl_ms).toBe(300000);
  });
});
