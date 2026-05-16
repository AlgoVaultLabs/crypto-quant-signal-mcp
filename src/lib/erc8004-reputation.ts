/**
 * /api/erc-8004-reputation body builder.
 *
 * Path 3 (DEFERRED) shape per Plan-Mode Amendment C: score=null,
 * status='pending', attestation_registry=null. Shape is locked by
 * audits/api-erc-8004-reputation-shape-snapshot-2026-05-16.json; future
 * shape changes ship a NEW dated snapshot rather than mutating the existing.
 *
 * Forbidden keys (Data Integrity LAW): outcome_return_pct, outcome_price,
 * phase_e_* — never appear in the response. Locked by tests/unit/erc8004-public-shape.test.ts.
 */

import {
  IDENTITY_REGISTRY_ADDRESS,
  BASE_CHAIN_ID,
} from './erc8004.js';

export interface Erc8004ReputationBodyOptions {
  pkgVersion: string;
  agentId: string | null;
  firstRegisteredAt: string | null;
  freshnessSeconds: number;
}

export interface Erc8004ReputationBody {
  agent_id: string | null;
  registry: 'ERC-8004';
  chain: 'base';
  chain_id: typeof BASE_CHAIN_ID;
  identity_registry: typeof IDENTITY_REGISTRY_ADDRESS;
  attestation_registry: string | null;
  score: number | null;
  total_attestations: number;
  status: 'pending' | 'active';
  status_message: string;
  first_registered_at: string | null;
  last_attestation_at: string | null;
  basescan_url: string | null;
  _algovault: {
    version: string;
    endpoint_version: 'v1';
    freshness_seconds: number;
  };
}

const PATH_3_STATUS_MESSAGE =
  'Identity verified on-chain via ERC-8004 Identity Registry. Attestation pipeline rolling out — interim verification via /api/merkle-batches.';

export function buildErc8004ReputationBody(
  opts: Erc8004ReputationBodyOptions,
): Erc8004ReputationBody {
  return {
    agent_id: opts.agentId,
    registry: 'ERC-8004',
    chain: 'base',
    chain_id: BASE_CHAIN_ID,
    identity_registry: IDENTITY_REGISTRY_ADDRESS,
    attestation_registry: null,
    score: null,
    total_attestations: 0,
    status: 'pending',
    status_message: PATH_3_STATUS_MESSAGE,
    first_registered_at: opts.firstRegisteredAt,
    last_attestation_at: null,
    basescan_url: opts.agentId
      ? `https://basescan.org/token/${IDENTITY_REGISTRY_ADDRESS}?a=${opts.agentId}`
      : null,
    _algovault: {
      version: opts.pkgVersion,
      endpoint_version: 'v1',
      freshness_seconds: opts.freshnessSeconds,
    },
  };
}
