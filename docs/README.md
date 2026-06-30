# Swarm Smart Contracts Documentation

This directory contains comprehensive documentation for the Swarm storage incentive smart contracts.

## Documentation Structure

### Core Contracts

- **[Overview](./OVERVIEW.md)** - System architecture and overview
- **[PostageStamp](./POSTAGE_STAMP.md)** - Postage stamp batch management
- **[PriceOracle](./PRICE_ORACLE.md)** - Dynamic price oracle system
- **[StakeRegistry](./STAKING.md)** - Staking registry for node operators
- **[Redistribution](./REDISTRIBUTION.md)** - Schelling game for reserve commitment

### Deployment

- **[Deployment Guide](./DEPLOYMENT.md)** - How to deploy and configure the contracts

## System Components

### Token (`TestToken`)
- ERC20 token with 16 decimal places
- Used for staking and postage stamp purchases
- Deployed separately on mainnet

### PostageStamp (`PostageStamp.sol`)
Manages postage stamp batches that users purchase to store chunks on Swarm.

**Key Features:**
- Batch creation with depth and bucket depth
- Normalized balance tracking per chunk
- Expiration management via order statistics tree
- Role-based access control (Price Oracle, Redistributor, Pauser)

### PriceOracle (`PriceOracle.sol`)
Automatically adjusts the price per chunk based on network redundancy.

**Key Features:**
- Target redundancy: 4 (configurable)
- Price adjustment based on actual redundancy
- Minimum price enforcement
- Rounds of 152 blocks (~19 minutes at 5s/block)

### StakeRegistry (`StakeRegistry.sol`)
Manages staking for node operators participating in the redistribution game.

**Key Features:**
- Stake commitment and potential stake
- Overlay management for nodes
- Freeze and slash mechanisms for penalties
- Height-based reserve calculations

### Redistribution (`Redistribution.sol`)
Implements the Schelling coordination game for reserve commitment consensus.

**Key Features:**
- Three phases: Commit, Reveal, Claim
- Proximity-based participation
- Stochastic winner selection weighted by stake density
- Proof verification for chunk inclusion
- Automatic price adjustment feedback

## Network Configuration

- **Mainnet**: Chain ID 1, Swarm Network ID 1
- **Testnet (Sepolia)**: Chain ID 11155111, Swarm Network ID 10
- **Testnet Light**: Chain ID TBD, Swarm Network ID 5
- **Tenderly**: For testing deployments

## Quick Links

- [Contracts on Etherscan](https://etherscan.io/)
- [Testnet Deployment Status](./DEPLOYMENT.md#deployment-status)
- [Mainnet Deployment Status](./DEPLOYMENT.md#deployment-status)

