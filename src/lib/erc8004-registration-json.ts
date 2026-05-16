/**
 * ERC-8004 registration JSON builder.
 *
 * Canonical ERC-8004 shape (per erc-8004/erc-8004-contracts README §"Agent
 * registration file (recommended shape)"): top-level `type`, `name`,
 * `description`, `image`, `services[]`, `registrations[]`, `supportedTrust[]`.
 *
 * AlgoVault-specific extension fields nest under the `algovault` namespace
 * to keep the canonical shape clean for 8004-aware indexers (per ERC-8004-W1
 * Plan-Mode Amendment B).
 *
 * Forbidden keys (Data Integrity LAW): outcome_return_pct, outcome_price,
 * phase_e_*, phase_e_wr — never appear in either the top-level object OR
 * the algovault.* subtree. Locked by tests/unit/erc8004-registration.test.ts.
 */

import { AGENT_REGISTRY_CAIP10 } from './erc8004.js';

export interface RegistrationService {
  type: string;
  endpoint: string;
  transport?: string;
}

export interface RegistrationLink {
  agentId: string;
  agentRegistry: string;
}

export interface AlgovaultExtension {
  schema_version: 'algovault-extension-v1';
  performance_pointer: string;
  merkle_anchor_pointer: string;
  verify_url: string;
  track_record_url: string;
  x402_facilitator: string;
  operator: string;
  operator_contact: string;
  x_handle: string;
  license: string;
  first_registered_at: string;
}

export interface RegistrationJson {
  type: 'AgentCard';
  name: string;
  description: string;
  image: string;
  services: RegistrationService[];
  registrations: RegistrationLink[];
  supportedTrust: string[];
  algovault: AlgovaultExtension;
}

export interface BuildRegistrationJsonOptions {
  agentId?: string;
  firstRegisteredAt: string;
}

const DESCRIPTION =
  'The Brain Layer for AI Trading Agents — cross-venue composite trade calls, market regime, and funding arbitrage signals over the Model Context Protocol. Verified track record on Base via Merkle anchoring.';

export function buildRegistrationJson(
  opts: BuildRegistrationJsonOptions,
): RegistrationJson {
  return {
    type: 'AgentCard',
    name: 'AlgoVault MCP',
    description: DESCRIPTION,
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
        agentId: opts.agentId ?? '',
        agentRegistry: AGENT_REGISTRY_CAIP10,
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
      first_registered_at: opts.firstRegisteredAt,
    },
  };
}
