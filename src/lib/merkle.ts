/**
 * Merkle tree library for tamper-proof signal verification.
 *
 * - hashSignal(): deterministic keccak256 hash of a trade signal
 * - buildMerkleTree(): builds a sorted, padded Merkle tree with proofs
 * - verifyProof(): checks a leaf against a root using its proof
 */
import { keccak256, encodePacked } from 'viem';

// ── Signal Hashing ──

export function hashSignal(signal: {
  coin: string;
  signal: 'BUY' | 'SELL';
  confidence: number;
  timeframe: string;
  timestamp: number; // unix seconds
  price: number;
}): `0x${string}` {
  return keccak256(
    encodePacked(
      ['string', 'string', 'uint8', 'string', 'uint64', 'uint256'],
      [
        signal.coin,
        signal.signal,
        Math.round(signal.confidence),
        signal.timeframe,
        BigInt(signal.timestamp),
        BigInt(Math.round(signal.price * 1e8)), // 8 decimal places
      ]
    )
  );
}

// ── Merkle Tree ──

export interface MerkleTreeResult {
  root: `0x${string}`;
  tree: `0x${string}`[][];
  proofs: Map<string, `0x${string}`[]>;
}

export function buildMerkleTree(leaves: `0x${string}`[]): MerkleTreeResult {
  if (leaves.length === 0) {
    return { root: ('0x' + '0'.repeat(64)) as `0x${string}`, tree: [], proofs: new Map() };
  }

  // Sort leaves for deterministic tree
  const sortedLeaves = [...leaves].sort();

  // Pad to power of 2
  let level = [...sortedLeaves];
  while (level.length > 1 && (level.length & (level.length - 1)) !== 0) {
    level.push(level[level.length - 1]); // duplicate last
  }

  const tree: `0x${string}`[][] = [level];
  const proofs = new Map<string, `0x${string}`[]>();

  // Build tree bottom-up
  while (level.length > 1) {
    const nextLevel: `0x${string}`[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] || left;
      // Sort pair before hashing (order-independent)
      const [a, b] = left < right ? [left, right] : [right, left];
      nextLevel.push(keccak256(encodePacked(['bytes32', 'bytes32'], [a, b])));
    }
    tree.push(nextLevel);
    level = nextLevel;
  }

  const root = level[0];

  // Generate proofs for each original leaf
  for (const leaf of sortedLeaves) {
    const proof: `0x${string}`[] = [];
    let idx = tree[0].indexOf(leaf);

    for (let i = 0; i < tree.length - 1; i++) {
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      if (siblingIdx >= 0 && siblingIdx < tree[i].length) {
        proof.push(tree[i][siblingIdx]);
      }
      idx = Math.floor(idx / 2);
    }

    proofs.set(leaf, proof);
  }

  return { root, tree, proofs };
}

// ── Proof Verification ──

export function verifyProof(
  leaf: `0x${string}`,
  proof: `0x${string}`[],
  root: `0x${string}`
): boolean {
  let hash = leaf;
  for (const sibling of proof) {
    const [a, b] = hash < sibling ? [hash, sibling] : [sibling, hash];
    hash = keccak256(encodePacked(['bytes32', 'bytes32'], [a, b]));
  }
  return hash === root;
}
