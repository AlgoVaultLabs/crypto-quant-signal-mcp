/**
 * ERC-8004-W1 C1 — registration JSON shape + address-constant + idempotency tests.
 *
 * Amendment B forbidden-key canary covers BOTH top-level keys AND the
 * algovault.* subtree (recursive walk).
 *
 * Amendment D idempotency check is exercised via a subprocess invocation
 * with ERC8004_AGENT_ID pre-set — must exit 0 with no RPC calls.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  IDENTITY_REGISTRY_ADDRESS,
  REPUTATION_REGISTRY_ADDRESS,
  VALIDATION_REGISTRY_ADDRESS,
  AGENT_REGISTRY_CAIP10,
  BASE_CHAIN_ID,
} from '../../src/lib/erc8004.js';
import {
  buildRegistrationJson,
  type RegistrationJson,
} from '../../src/lib/erc8004-registration-json.js';

const FORBIDDEN_KEY_RE = /outcome_return_pct|outcome_price|phase_e/i;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

describe('ERC-8004 registration JSON shape', () => {
  const fixture: RegistrationJson = buildRegistrationJson({
    agentId: '42',
    firstRegisteredAt: '2026-05-16T12:00:00.000Z',
  });

  it('locks the canonical ERC-8004 shape per Amendment B', () => {
    expect(fixture).toEqual({
      type: 'AgentCard',
      name: 'AlgoVault MCP',
      description:
        'The Brain Layer for AI Trading Agents — cross-venue composite trade calls, market regime, and funding arbitrage signals over the Model Context Protocol. Verified track record on Base via Merkle anchoring.',
      image: 'https://algovault.com/logo.png',
      services: [
        {
          type: 'ModelContextProtocol',
          endpoint: 'https://api.algovault.com/mcp',
          transport: 'streamable-http',
        },
      ],
      registrations: [
        {
          agentId: '42',
          agentRegistry:
            'eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
        },
      ],
      supportedTrust: ['reputation', 'merkle-anchor'],
      algovault: {
        schema_version: 'algovault-extension-v1',
        performance_pointer: 'https://api.algovault.com/api/performance-public',
        merkle_anchor_pointer: 'https://api.algovault.com/api/merkle-batches',
        verify_url: 'https://algovault.com/verify',
        track_record_url: 'https://algovault.com/track-record',
        x402_facilitator: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        operator: 'AlgoVault Labs',
        operator_contact: 'admin@algovault.com',
        x_handle: '@AlgoVaultLabs',
        license: 'MIT',
        first_registered_at: '2026-05-16T12:00:00.000Z',
      },
    });
  });

  it('forbidden-key canary — no key matches /outcome_return_pct|outcome_price|phase_e/ at any depth', () => {
    const allKeys = collectAllKeys(fixture);
    const offenders = allKeys.filter((k) => FORBIDDEN_KEY_RE.test(k));
    expect(offenders).toEqual([]);
  });

  it('forbidden-key canary — algovault.* subtree alone has zero forbidden keys', () => {
    const subtreeKeys = collectAllKeys(fixture.algovault);
    const offenders = subtreeKeys.filter((k) => FORBIDDEN_KEY_RE.test(k));
    expect(offenders).toEqual([]);
  });

  it('forbidden-key canary — emits zero forbidden keys when serialized to JSON string', () => {
    const serialized = JSON.stringify(fixture);
    expect(FORBIDDEN_KEY_RE.test(serialized)).toBe(false);
  });

  it('MCP endpoint URL is exactly https://api.algovault.com/mcp', () => {
    expect(fixture.services[0].endpoint).toBe('https://api.algovault.com/mcp');
    expect(fixture.services[0].type).toBe('ModelContextProtocol');
    expect(fixture.services[0].transport).toBe('streamable-http');
  });

  it('registrations[].agentRegistry is CAIP-10 form for Base mainnet', () => {
    expect(fixture.registrations[0].agentRegistry).toBe(
      `eip155:${BASE_CHAIN_ID}:${IDENTITY_REGISTRY_ADDRESS}`,
    );
  });

  it('placeholder agentId when not yet minted', () => {
    const v1 = buildRegistrationJson({
      agentId: 'pending-mint',
      firstRegisteredAt: '2026-05-16T12:00:00.000Z',
    });
    expect(v1.registrations[0].agentId).toBe('pending-mint');
  });

  it('omits agentId when not provided (defaults to empty string)', () => {
    const v0 = buildRegistrationJson({
      firstRegisteredAt: '2026-05-16T12:00:00.000Z',
    });
    expect(v0.registrations[0].agentId).toBe('');
  });
});

describe('ERC-8004 address constants', () => {
  it('IDENTITY_REGISTRY_ADDRESS matches Plan-Mode-probed Base mainnet value (EIP-55 checksummed)', () => {
    expect(IDENTITY_REGISTRY_ADDRESS).toBe(
      '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    );
    expect(IDENTITY_REGISTRY_ADDRESS).not.toBe(
      IDENTITY_REGISTRY_ADDRESS.toLowerCase(),
    );
  });

  it('REPUTATION_REGISTRY_ADDRESS matches Plan-Mode-probed Base mainnet value (EIP-55 checksummed)', () => {
    expect(REPUTATION_REGISTRY_ADDRESS).toBe(
      '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    );
    expect(REPUTATION_REGISTRY_ADDRESS).not.toBe(
      REPUTATION_REGISTRY_ADDRESS.toLowerCase(),
    );
  });

  it('VALIDATION_REGISTRY_ADDRESS is null (not canonically deployed on Base mainnet per Plan-Mode B-5)', () => {
    expect(VALIDATION_REGISTRY_ADDRESS).toBeNull();
  });

  it('AGENT_REGISTRY_CAIP10 binds to Base chain (8453) + Identity Registry', () => {
    expect(AGENT_REGISTRY_CAIP10).toBe(
      'eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    );
  });

  it('BASE_CHAIN_ID is 8453', () => {
    expect(BASE_CHAIN_ID).toBe(8453);
  });
});

describe('register-erc8004-agent.ts idempotency (Amendment D)', () => {
  it('exits 0 with "Already registered, skipping" when ERC8004_AGENT_ID is preset (no RPC, no IPFS)', () => {
    const result = spawnSync(
      'npx',
      ['tsx', join(REPO_ROOT, 'src/scripts/register-erc8004-agent.ts')],
      {
        env: {
          ...process.env,
          ERC8004_AGENT_ID: '99999',
          ERC8004_AGENT_OWNER_KEY: '',
          IPFS_PINNING_PROVIDER: '',
          IPFS_PINNING_TOKEN: '',
        },
        encoding: 'utf-8',
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(
      /Already registered.*ERC8004_AGENT_ID=99999/,
    );
    // Sanity: no RPC error / no IPFS provider error / no balance probe should
    // have fired. The presence of either string indicates the idempotency
    // gate failed to fire.
    expect(result.stdout + result.stderr).not.toMatch(/PINNING_PROVIDER/i);
    expect(result.stdout + result.stderr).not.toMatch(/balanceOf/);
    expect(result.stdout + result.stderr).not.toMatch(/RPC/);
  });
});

describe('register-erc8004-agent.ts --update-uri mode (ERC-8004-W1 post-discovery)', () => {
  it('fails fast when --update-uri is set but ERC8004_AGENT_ID is unset', () => {
    const result = spawnSync(
      'npx',
      [
        'tsx',
        join(REPO_ROOT, 'src/scripts/register-erc8004-agent.ts'),
        '--update-uri',
        '--dry-run',
      ],
      {
        env: {
          ...process.env,
          ERC8004_AGENT_ID: '',
          ERC8004_AGENT_OWNER_KEY:
            '0x0000000000000000000000000000000000000000000000000000000000000001',
          IPFS_PINNING_PROVIDER: 'pinata',
          IPFS_PINNING_TOKEN: 'unused-in-dry-run',
        },
        encoding: 'utf-8',
        timeout: 30_000,
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(
      /--update-uri requires ERC8004_AGENT_ID/,
    );
  });

  it('does NOT trigger the idempotency-exit when --update-uri is set with ERC8004_AGENT_ID (env var is the OPT-IN here)', () => {
    // We can't fully exercise the on-chain path in a unit test, so this only
    // asserts the script does NOT exit 0 with "Already registered, skipping"
    // (which it WOULD do in mint mode). Instead it tries to proceed past the
    // idempotency check and fails on the next layer (ownership check needs RPC).
    const result = spawnSync(
      'npx',
      [
        'tsx',
        join(REPO_ROOT, 'src/scripts/register-erc8004-agent.ts'),
        '--update-uri',
        '--dry-run',
      ],
      {
        env: {
          ...process.env,
          ERC8004_AGENT_ID: '99999',
          ERC8004_AGENT_OWNER_KEY:
            '0x0000000000000000000000000000000000000000000000000000000000000001',
          IPFS_PINNING_PROVIDER: 'pinata',
          IPFS_PINNING_TOKEN: 'unused-in-dry-run',
          BASE_RPC_URL: 'https://mainnet.base.org',
        },
        encoding: 'utf-8',
        timeout: 30_000,
      },
    );
    // Must NOT have short-circuited via the mint-mode idempotency exit.
    expect(result.stdout + result.stderr).not.toMatch(
      /Already registered.*skipping/,
    );
    // Must have entered update-uri mode (mode banner printed before any RPC).
    expect(result.stdout + result.stderr).toMatch(/mode: update-uri/);
  });
});
