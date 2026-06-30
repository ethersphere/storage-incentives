# Base L2 Network Deployment

Reference for the Swarm storage incentives deployment on **Base Mainnet**, covering smart contracts, Bee node integration, and operational lessons from the POC.

## Summary

Swarm storage incentives contracts are deployed on Base L2 (chain ID `8453`) as a second Swarm network (`swarmNetworkId: 2`). Contract parameters were adjusted for Base's **2s block time** so round duration and minimum validity match Gnosis Mainnet in wall-clock terms. Bee node changes live on the [`feat/base`](https://github.com/ethersphere/bee/compare/master...feat/base) branch; cluster operations validated end-to-end upload/download and redistribution game startup.

---

## Network Configuration

| Parameter | Value | Notes |
|-----------|-------|-------|
| Chain ID | `8453` | Base Mainnet |
| Swarm Network ID | `2` | Unique identifier for Base Swarm network |
| Block time | ~2s | vs ~5s on Gnosis |
| Round length | `380` blocks | ≈ 760s — same as Gnosis (`152 × 5s`) |
| Minimum validity | `43200` blocks | ≈ 24h — same as Gnosis (`17280 × 5s`) |
| Native token | bETH | |
| Swarm token | bBZZ | |

Hardhat / deploy config: `helper-hardhat-config.ts` (`base` entry).

---

## Smart Contracts

### Deployed addresses (Base Mainnet)

| Contract | Address |
|----------|---------|
| BZZ Token | `0x239Db952bde69A15962436C6CD86FDd3b45342e4` |
| Staking (StakeRegistry) | `0x491075e789DBdbb7d08D95946E665eFB2751eE1E` |
| PostageStamp | `0x8613A18717E30be14852846eC6D45F5010339451` |
| PriceOracle | `0x53e13c0656954EF72C028D6D3e352276e61C5115` |
| Redistribution | `0xacDcb3Cd8DeaDd798856AF1C8a1b6c27290f75e5` |

### Oracle / Redistribution redeploy

PriceOracle and Redistribution were **redeployed** to clear a stuck `lastAdjustedRound` backlog that caused claim transactions to fail (overflow / out-of-gas in `adjustPrice`).

| Contract | Superseded address |
|----------|-------------------|
| PriceOracle | `0x0fF044F6bB4F684a5A149B46D7eC03ea659F98A1` |
| Redistribution | `0x6a02826e2a56092F56e0ba4dB766c5f4540414C2` |

Use the **current** Redistribution address for all claim and commit interactions.

### Contract changes for multi-chain support

Round length and minimum validity are chain-specific so wall-clock timing stays consistent across 2s (Base) and 5s (Gnosis) block times. Deploy scripts and artifacts are under `deploy/base/` and `deployments/base/`.

### Integration artifacts

| Path | Purpose |
|------|---------|
| `base_deployed.json` | Full deployment info with ABIs and addresses — primary reference for Bee node integration |
| `deployments/base/` | Per-contract Hardhat deployment artifacts |
| `helper-hardhat-config.ts` | Network parameter reference |

---

## Bee Node Integration

Bee changes for Base are on [`feat/base`](https://github.com/ethersphere/bee/compare/master...feat/base). Chain-specific settings are provided via a `ChainConfig` struct (Gnosis, Sepolia testnet, and Base share one codebase).

### Checklist for Bee developers

1. Set `swarmNetworkId: 2` for Base.
2. Load contract addresses and ABIs from `base_deployed.json`.
3. Block time is 2s; round duration remains ~12.6 minutes (`380` blocks).
4. Use the **current** Redistribution address (see table above).
5. `AcceptedChequebookBytecodeHashes` is still **TODO** for chequebook verification on Base.

### Example `ChainConfig` (Base)

```go
const blocksPerRoundBase = 380

var Base = ChainConfig{
    ChainID:                8453,
    NetworkID:              2,
    PostageStampStartBlock: 45333498,
    NativeTokenSymbol:      "bETH",
    SwarmTokenSymbol:       "bBZZ",

    StakingAddress:         common.HexToAddress("0x491075e789DBdbb7d08D95946E665eFB2751eE1E"),
    PostageStampAddress:    common.HexToAddress("0x8613A18717E30be14852846eC6D45F5010339451"),
    RedistributionAddress:  common.HexToAddress("0xacDcb3Cd8DeaDd798856AF1C8a1b6c27290f75e5"),
    SwapPriceOracleAddress: common.HexToAddress("0x4c90551763C1498aE96589202E386019655c1781"),
    CurrentFactoryAddress:  common.HexToAddress("0xe4620F49ebDEF146366E63B08Eb66cAe32d51c8f"),

    StakingABI:        abi.MainnetStakingABI,
    PostageStampABI:   abi.MainnetPostageStampABI,
    RedistributionABI: abi.MainnetRedistributionABI,

    BlocksPerRound: blocksPerRoundBase,
    BlocksPerPhase: blocksPerRoundBase / 4,
}
```

### RPC-driven Bee changes

Base RPC behaviour required:

- **`block-page`**: reduced from `5000` to `1500`.
- **Chequebook verification**: retry with backoff on failure (RPC caching during testing).

### Testing performed

- Beekeeper load job uploaded enough data to start the redistribution game once contracts were in the correct state (early Oracle issues were resolved via redeploy).
- Manual smoke test: upload picture and video on one node, download from another.
- Cluster funding via a modified Beekeeper node-funder for Base BZZ.

---

## DevOps & Operations

Lessons from the Base POC — apply these when planning future chain rollouts.

### RPC volume is the gating factor

~20 Bee nodes generated ~450k RPC requests/day (~13.5M/month) at default block-sync settings, exceeding the Infura quota and putting all 21 pods into `CrashLoopBackOff` on `init chain: 429`.

**Before committing to a chain**, measure requests per node and size the provider (quota, rate limits, cost).

**Mitigations:**

- Increase `block-sync-interval`
- RPC deduplication proxy (e.g. etherproxy)
- Staggered / randomised pod startup to avoid thundering-herd 429s

### Self-hosted L2 RPC

Running op-reth + op-node for Base did not fast-bootstrap without relaxing archive/fast sync or using checkpoint sync. A paid provider (Alchemy ~$289/mo matched measured load) is the realistic path for production clusters.

### Resource and config planning

- Large reserve PVC per node (capacity + node-group spread).
- Per-chain block time and contract params require chain-specific Bee config — do not assume Gnosis defaults (`feat/base`).

### Bottom line

Vet a new chain on **RPC requirements, sync model, and resource footprint** up front. These operational constraints gate rollouts more than Bee application code itself.

---

## Open Items

| Item | Owner / notes |
|------|---------------|
| `AcceptedChequebookBytecodeHashes` for Base | Derive via `cast keccak $(cast code <chequebook addr> --rpc-url <rpc>)`; append-only set per factory generation |
| Oracle contract history | @0xCardiE — details on early Oracle issues leading to redeploy |
