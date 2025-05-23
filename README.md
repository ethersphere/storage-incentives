# Swarm Storage Incentives

This repository contains the smart contracts for Swarm's storage incentives.

# Overview

In order to distribute to upload content to the Swarm network, _batches_ of _postage stamps_ are purchased by nodes. These _stamps_ are then attached to content that is divided into 4kb chunks and then uploaded to the Swarm network. In order to distribute the proceeds from the sales of these _batches_, a [Schelling Co-ordination Game](https://en.wikipedia.org/wiki/Coordination_game) is implemented using the smart contracts contained in this repository, in order to identify nodes storing the canonical subset of valid chunks that fall within the radius of responsibility of each node in a _neighbourhood_ at the time of their application. Correct identification of this hash qualifies a node to apply to receive a reward comprising value arising from _expired_ _batches_.

# Stakes

Each _storage node_ seeking to benefit from _storage incentive_ rewards should stake at least the _minimum stake_ by sending _BZZ_ to the [staking contract](src/Staking.sol). This stake permits each node to participate in the Schelling game. At this stage, to keep things simple, a stake is not withdrawable. It is expected over time that neighbourhood stakes will find a homeostasis at an amount proportional to a node's expected future returns minus their running costs.

For each _round_ of the _storage rewards redistribution_ process, a node is chosen at random from the participants proportional to their _stake density_ to be that round's _truth teller_. Nodes that agree with this _"truth"_ are qualified to receive the entire reward for that _round_ if they are chosen by a second random selection procedure, wherein the probability of their selection is similarly weighted by the _density_ of their stake. Over time, all else being equal, a node will hence receive reward relative to the proportional size of their stake if they are fully participant in the Swarm protocols.

A node must have _staked_ at least two _rounds_ prior to their application. If a _stake_ is updated, a node may not participate until the next two _rounds_ have elapsed.

# Current Implementation (Phase 3)

Every _N_ blocks, at the end of the previous _reveal phase_, the [redistribution contract](src/Staking.sol) selects a random _round anchor_ which determines which _neighbourhood_ may participate in the current _round_. Eligibility is determined by calculating the proximity of a node's _overlay address_ to the _round anchor_. A node is eligible if their proximity order to the anchor is less than or equal to the canonical _storage depth_ that they use to calculate their _commit hash_.

If eligible to participate, a node will use the chunks in its _reserve_ to calculate a _reserve commitment_. This is the _keccack256_ hash of the first _m_ chunk addresses when transformed using the standard _hmac_ keyed hash function where the _round anchor_ is used as the key. The _reserve commitment_ should be the same for each node in a neighbourhood and represents their ability to access a full canonical reserve of chunks at the time that the _anchor_ was selected. The nodes then combine this with a unique _reveal nonce_, their _overlay_ and their current _storage depth_, defined as the maximum _proximity order_ between their _address_ and that of the furthest chunk that still falls within the node's fixed size _reserve_. The _keccack256_ hash of the concatenation of these values is known as a _commit hash_. This is then submitted to the blockchain during that _round's_ _commit_ phase.

If nodes in the neighbourhood's _pull sync_ protocols are running as they should, each node in the neighbourhood will calculate the same _reserve commitment hash_ and _storage depth_. However, since the _commit hash_ calculation also includes a random _reveal nonce_ in before it is hashed, each node's _reserve commitment hash_ and _storage depth_ is kept private during the _commit phase_. Once the _commit phase_ is over, the _reveal phase_ begins, and each participating node is expected to send another transaction to the _redistribution contract_ with the corresponding pre-image of the hash, comprising the _reserve commitment_, _storage depth_ and _reveal nonce_.

If the revealed _reserve commitment_, _storage depth_ and _reveal nonce_ values are found to correctly re-hash to the _commit hash_ the node has submitted, the node is included in a procedure to select the node that will be the beneficiary of the rewards from this round. If the reveal values do not has to the submitted pre-image, the node's overlay is _frozen_ for a number of rounds proportional to the reported _storage depth_, and that overlay is prevented from being able to participate until this period has elapsed.

Once the _reveal phase_ is over, the _claim phase_ begins. A random _seed_ is chosen using the _block.difficulty_ (= _block.prevrandao_ in post-merge chains) as a source of randomness. Based on this, a node is selected as the _truth teller_ for this round, with a probability proportional to its _stake density_, then, from the nodes that agree with this _"truth"_, a beneficiary of this round's rewards is selected, with a probability similarly proportional to its _stake density_.

The entire amount of the total of the _postage batch_ proceeds that have _expired_ during this round are _withdrawn_ from the [postage stamp contract](src/Postage.sol) and transferred to the _winner_. Nodes that have revealed _reserve commitments_ or _storage depths_ that do not agree with the _truth teller_ are _frozen_ for a period longer but similarly proportioned to the truthy depth and will have to wait until _unfrozen_ to participate again.

When the claim is submitted, the cardinality of the truthy set of applicants is used as to provide a signal to change the price of storage. If the redundancy per neighbourhood is at the desired amount (4), no action is taken and the price remains static. If it is lower, this indicates an overdemand for storage and an undersupply of storage nodes - the price per chunk per block is increased to cause batches to expire more quickly and to attract more storage nodes to the network. Conversely, if more than 4 nodes per neighbourhood apply with a truthy _reserve commitment_, this indicates an oversupply of storage nodes and the price is decreased to ensure the efficiency of service provision.

As the _seed_ is chosen, the _anchor_ for the next round is revealed. Once it has noticed it is within the _neighbourhood_, a node may begin calculating its
_reserve commitment_ in preparation for the upcoming _commit phase_, and so the cycle repeats.

# Future Implementations Plan

## Phase 4

Nodes will be expected to submit inclusion proofs during the claim period, which prove...

## Phase 5

Nodes will be expected to submit inclusion proofs during the claim period, which prove inclusion of ...

## End Phase

Relinquish admin rights...

## Emergency

# Deployment and Bootstrapping Procedure

...

## Contents:

### Smart Contracts and Metadata

This project includes the following smart contracts and their metadata:

- [Smart Contracts](./src)

  - Redistribution
  - Staking Registry
  - Price Oracle
  - Postage Stamps
    - HitchensOrderStatisticsTreeLib
  - Test Token

- Metadata ([Testnet](./testnet_deployed.json),[Mainnet](./mainnet_deployed.json))
  - **Chain ID**: Chain ID of the blockchain.
  - **Network ID**: Network ID.
  - **ABI**: Interface to communicate with smart contracts.
  - **Bytecode**: Compiled object code that is executed during communication with smart contract.
  - **Address**: Address of the deployed contract on the blockchain.
  - **Block**: Block height in which the transaction is mined.
  - **URL**: URL for analyzing the transaction.

### [Scripts](./scripts)

- Script for deploying all and individual contracts
- Script assigning roles/permissions for smart contracts
  - Redistributor role
  - Price Oracle role
  - Price Updater role

## Project Setup

### Prerequisites

To set up the project, you will need `yarn` and `node`.

The project has been tested with the latest node LTS (Erbium). A `.nvmrc` file is also provided.

### Setup

To get started with this project, follow these steps:

1. Clone the repo.
2. Run `yarn install` at the root of the repo to install all dependencies.
3. Add a `.env` file in your root directory, where you'll store your sensitive information for deployment. An example file [`.env.example`](./.env.example) is provided for reference.

## Run

### [Tests](./test)

- Unit Tests
  - Run `yarn hardhat test` to run all the tests.
  - Run `yarn hardhat coverage` to see the coverage of smart contracts.

### Deployments

#### Method

All deployments and Tests are fully dependant on Hardhat Deploy library https://github.com/wighawag/hardhat-deploy and follow best practices used there

##### Prerequisites

Feel free to use public RPCs but if you want extra security and speed, feel free to use Infura, Alchemy or any other private RPC and add full path with your KEY to .env file

##### Steps

1. Run `yarn hardhat compile` to get all the contracts compiled.
2. Run `yarn hardhat test` to run all the tests.
3. Configure `.env` file
   - Set your `WALLET_SECRET` in the `.env` file.
   - Set your `INFURA_TOKEN` in the `.env` file.
4. To deploy all contracts and set roles:
   - Mainnet: `yarn hardhat deploy --network mainnet`
   - Testnet: `yarn hardhat deploy --network testnet`

**Note** can also use npx instead of yarn, so it would be 'yarn hardhat compile'. For fastest typing you can install https://hardhat.org/hardhat-runner/docs/guides/command-line-completion and then just run 'hh compile' 'hh test'

**Note:** After successfully deploying to mainnet or testnet the [mainnet_deployed.json](./mainnet_deployed.json) and [testnet_deployed.json](./testnet_deployed.json) will be automatically updated and those changes should be committed as bee node is picking them up as data that is used in nodes. This is done utilizing codegen/generate_src.sh script that is activated as github action, more on this at the bottom in Releasing section

**Note:** `WALLET_SECRET` can be **Mnemonic** or **Private Key**.

#### Local

- Run `yarn hardhat deploy` to deploy all contracts on hardhat environment(network).
- To deploy on Ganache (or other networks):

  - Add network configuration in your [hardhat.config.ts](./hardhat.config.ts).
    ```
    ganache: {
          url: 'http://localhost:8545',
          chainId: 1337,
    },
    ```
  - To run: `yarn hardhat deploy --network ganache`

#### Light Testnet

- Make a new RC tag and commit to generate new ABI for Bee Node creation
- Make a cluster with minimal required number of nodes (10) all point to that tag
- Latest tag should have all new contracts deployed for SI
- We reuse and share testnet token sBZZ with proper testnet and S3, easier for setup and config
- To have that we need to copy from deployments/testnet directory TestToken.json so "hardhat deploy" reuses it and
  doesn't create new contract, with this it will insert this address in all other contract deployments
- We use swarm network 333 ID
- This testnet will probably not be continuosly running

#### Testnet

- Regullar RC tagging for testent
- We have continuos running testnet with deployed contracts on sepolia
- We just deploy changes/new contracts that will go to mainet
- We use swarm net id 10
- As we already have running nodes there, we need to upgrade few/half of those to new node with latest contracts tag so we can have simulation of node upgrades and network working with different node versions

#### Additional commands and flags:

- Make necessary changes to [hardhat.config.ts](./hardhat.config.ts).
  - List of available configs can be found [here](https://hardhat.org/hardhat-runner/docs/config).
- Run script `yarn hardhat run <script> --network <network>`
  - **Network**: Configure network name
  - **Script**: Configure script name and path

#### Tasks

To run hardhat task put in CLI

npx hardhat (hh) contracts --target main
hh compare --source main --target test

There are 4 tasks currently copyBatch, signatures, contracts and compare

## Releasing

To release a new rc version, tag the commit with the `-rcX` suffix, where `X` is the release candidate number.
For example, to release `v0.9.1-rc1`, execute the following command: `git tag v0.9.1-rc1 && git push origin v0.9.1-rc1`.
This will generate Golang source code for the smart contracts and publish it to the [`ethersphere/go-storage-incentives-abi`](https://github.com/ethersphere/go-storage-incentives-abi) repository.
It'll also generate .env file with the bytecodes and publish it to the [`ethersphere/docker-setup-contracts`](https://github.com/ethersphere/docker-setup-contracts) repository.
The values for the Golang source code and .env file are taken from the [testnet_deployed.json](testnet_deployed.json) file, (see the [Deployment](#deployment) section).

To release a new stable version, tag the commit without the `-rcX` suffix.
For example, to release `v0.9.1`, execute the following command: `git tag v0.9.1 && git push origin v0.9.1`.
This will generate Golang source code for the smart contracts and publish it to the [`ethersphere/go-storage-incentives-abi`](https://github.com/ethersphere/go-storage-incentives-abi) repository.
The values for the Golang source code file are taken from the [mainnet_deployed.json](mainnet_deployed.json) file (see the [Deployment](#deployment) section).
