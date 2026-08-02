#!/usr/bin/env tsx
/**
 * deploy-merkle-contract.ts — Deploy MerkleRootRegistry to Base L2.
 *
 * Usage: npx hardhat run src/scripts/deploy-merkle-contract.ts --network base
 */
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

// SEC-22 (OPS-AUDIT-REMEDIATION-LOW-W1): a cron/CLI entrypoint must guard its top-level
// main() so importing this module for a test does not execute it. Live cron invokes
// `node dist/scripts/<name>.js`, so require.main === module is true there and the
// scheduled run is unaffected.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
