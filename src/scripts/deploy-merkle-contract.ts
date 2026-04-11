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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
