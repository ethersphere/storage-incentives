// ABI type of Settlement.PublicValues. Must match src/settlement/Settlement.sol and
// prover/crates/vm/src/types.rs field for field.
export const PV_TYPE =
  'tuple(' +
  'tuple(uint256 chainId,address settlement,uint64 round,bytes32 anchorBlockHash,bytes32 seedBlockHash,' +
  'bytes32 commitsHash,uint32 commitCount,bytes32 revealsHash,uint32 revealCount,' +
  'bytes32 forcedCommitsHash,bytes32 forcedRevealsHash,' +
  'uint64 lastClaimRound,uint8 lastWinnerDepth,uint8 penaltyMultiplierDisagreement,' +
  'uint8 penaltyMultiplierNonRevealed,uint8 penaltyRandomFactor,uint8 stakeAgeRounds,address[] participants,bytes32 stakeDigest,' +
  'uint32 stakePrice,bytes32 forcedClaimsHash,uint256 sampleMaxValue,' +
  'tuple(bytes32 prevStateHash,uint64 prevEventIndex,bytes32 prevEventHash,uint64 eventIndex,bytes32 eventHash,' +
  'uint64 cutBlock) postage) inputs,' +
  'tuple(bool hasTruth,bytes32 truthHash,uint8 truthDepth,address winner,bytes32 winnerOverlay,' +
  'uint256 winnerStakeDensity,uint16 redundancy,address[] freezeOwners,uint256[] freezeDurations,bool unclaimed,address feeRecipient,' +
  'tuple(bytes32 newStateHash,uint256 potAmount,uint256 validChunkCount) postage) outcome)';
