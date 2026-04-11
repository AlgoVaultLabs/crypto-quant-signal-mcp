// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MerkleRootRegistry {
    address public owner;

    struct Batch {
        bytes32 root;
        uint256 signalCount;
        uint256 timestamp;
    }

    // batchId -> Batch data
    mapping(uint256 => Batch) public batches;
    uint256 public latestBatchId;

    event RootPublished(
        uint256 indexed batchId,
        bytes32 root,
        uint256 signalCount,
        uint256 timestamp
    );

    constructor() {
        owner = msg.sender;
    }

    function publishRoot(
        uint256 batchId,
        bytes32 root,
        uint256 signalCount
    ) external {
        require(msg.sender == owner, "Unauthorized");
        require(batches[batchId].timestamp == 0, "Batch already published");

        batches[batchId] = Batch({
            root: root,
            signalCount: signalCount,
            timestamp: block.timestamp
        });

        if (batchId > latestBatchId) {
            latestBatchId = batchId;
        }

        emit RootPublished(batchId, root, signalCount, block.timestamp);
    }

    function verifyRoot(uint256 batchId) external view returns (
        bytes32 root,
        uint256 signalCount,
        uint256 timestamp
    ) {
        Batch memory b = batches[batchId];
        return (b.root, b.signalCount, b.timestamp);
    }
}
