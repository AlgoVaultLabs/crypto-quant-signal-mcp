#!/usr/bin/env tsx
/**
 * deploy-merkle-contract.ts — Deploy MerkleRootRegistry to Base L2.
 *
 * Usage: npx hardhat run src/scripts/deploy-merkle-contract.ts --network base
 */
import { runScript } from '../lib/script-lifecycle.js';
import hre from 'hardhat';

async function main() {
  console.log('Compiling MerkleRootRegistry...');

  const registry = await hre.viem.deployContract('MerkleRootRegistry');

  console.log(`MerkleRootRegistry deployed at: ${registry.address}`);
  console.log(`Set MERKLE_CONTRACT_ADDRESS=${registry.address} in .env`);

  // Verify the owner
  const owner = await registry.read.owner();
  console.log(`Contract owner: ${owner}`);
}

// SEC-22 (OPS-AUDIT-REMEDIATION-LOW-W1): guard the entrypoint AND terminate through
// runScript(), which drains and exits. A bare main().catch() leaves the process alive
// on success and pins a Postgres connection forever (OPS-SCRIPT-EXIT-LIFECYCLE-W1).
if (require.main === module) {
  void runScript('deploy-merkle-contract', main);
}
