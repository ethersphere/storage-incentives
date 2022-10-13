# Swarm Storage Incentives

This repository contains the contracts and tests for Swarm storage incentives.

# Overview

In order to distribute to upload content to the Swarm network, _batches_ of _postage stamps_ are purchased by nodes. These _stamps_ are then attached to content that is divided into 4kb chunks and then uploaded to the Swarm network. In order to distribute the proceeds from the sales of these _batches_, a [Schelling Co-ordination Game](https://en.wikipedia.org/wiki/Coordination_game) is implemented, using the smart contracts contained in this repository, to identify nodes storing the canonical subset of valid chunks that fall within the radius of resposibility of each node in a _neighbourhood_ at the time of their application. Correct identification of this hash qualifies a node to apply to receive a rewards comprising value arising from _expired_ _batches_.

# Stakes

Each _storage node_ seeking to rewards should stake at least the _minimum stake_ by sending _BZZ_ to the [staking contract](src/Staking.sol). This stake allows each node to particpate in the Schelling game. At this stage, to keep things simple, a stake is not withdrawable. It is expected over time that neighbourhood stakes will find a homeostasis at an amount based on a node's expected future returns given their running costs.

For each _round_ of the storage rewards redistribution process, a node is chosen at random from the participants proportional to their _stake density_ to be that round's _truth teller_. Nodes that agree with this _"truth"_ are qualified to receive the entire reward for that round if they are chosen in another random selection procedure, where the probability of their selection is also weighted by the _density_ of their stake. Over time, all else being equal, a node will hence receive reward relative to the size of their stake.

A node must have _staked_ at least two _rounds_ prior to their application. If a _stake_ is updated, a node may not participate in the next two _rounds_.

# Rounds

Every _N_ blocks, at the end of the previous _reveal phase_, the [redistribution contract](src/Staking.sol) selects a random _round anchor_ which determines which _neighbourhood_ may participate in the current _round_. Eligibility is determined by calculating the proximity of a node's _overlay address_ to the _round anchor_. A node is eligible oiftheir proximity order to the anchor is less than or equal to the canonical _storage depth_ that they will include in their _commit hash_.

If eligible to participate, a node will use the chunks in its _reserve_ to calculate a _reserve commitment_. This is the _keccack256_ hash of a the first _m_ chunk addresses when transformed using a hmac function with the round anchor as the key. This _reserve commitment_ should be the same for each node in a neighbourhood and represents their ability to access a full canonical reserve of chunks at the time that the _anchor_ was selected. The nodes then combine this with a unique _reveal nonce_, their _overlay_ and their current _storage depth_, determined as the maximum _proximity order_ of the furthest chunk that still falls within the node's fixed size _reserve_. The _keccack256_ hash of the concatentation of these values is known as a _commit hash_. This is submitted to the blockchain during the _commit_ phase.

If nodes in the neighbourhood's _pull sync_ protocols are running as they should, each node in the neighbourhood will have the same _reserve commitment hash_ and _storage depth_. However, since they include a random _reveal nonce_ in their application, each node's _commit hash_ is kept private during the _commit phase_. Once the _commit phase_ is over, the _reveal phase_ begins, and each participating node is expected to send another transaction to the _redistribution contract_ with the unobsfucated _reserve commitment_, _storage depth_ and _reveal nonce_.

If the revealed _reserve commitment_, _storage depth_ and _reveal nonce_ values are found to re-hash to the submitted _commit hash_, the node is entered into a procedure to select the node that will be the beneficiary of the rewards from this round. If they do not, the node's overlay is _frozen_ for a number of rounds proportional to the reported _storage depth_, and prevented from being able to participate until this period has elapsed.

Once the _reveal phase_ is over, the _claim phase_ begins. A random _seed_ is chosen using the _block.difficulty_ (= _block.prevrandao_ in post-merge chains) as a source of randomness. Based on this, a node is selected as the _truth teller_ for this round, with a probability proportional to its _stake density_, then, from the nodes that agree with this _"truth"_, a beneficiary of this round's rewards is selected, with a probability similarly proportional to its _stake density_.

The entire amount of the total of the _postage batch_ proceeds that have _expired_ during this round are _withdrawn_ from the [postage stamp contract](src/Postage.sol) and transferred to the _winner_. Nodes that have revealed _reserve commitments_ or _storage depths_ which do not agree with the _truth teller_ are _slashed_ and will have to re-stake to participate in future •rounds\*.

As the _seed_ is chosen, the _anchor_ for the next round is revealed. Once it has noticed it is within the _neighbourhood_, a node may begin calculating it's
_reserve commitment_ in preparation for the upcoming _commit phase_, and so the cycle repeats.

- it is planned that in future iterations, the node will be slashed for not revealing truthy values.

## Requirements:

To set up the project, you will need `yarn` and `node`.

The project has been tested with the latest node LTS (Erbium). A `.nvmrc` file is also provided.

## Installation:

Run `yarn install` to install all depencencies.

## Testing:

You may run tests with `yarn test`.

Hardhat is configured to deploy all contracts to the testing hardhat devchain and to use all named accounts.

## Deployments

| Network | Address                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| XDai    | [0x6a1a21eca3ab28be85c7ba22b2d6eae5907c900e](https://blockscout.com/xdai/mainnet/address/0x6a1a21eca3ab28be85c7ba22b2d6eae5907c900e/transactions) |
| Goerli  | [0x621e455C4a139f5C4e4A8122Ce55Dc21630769E4](https://goerli.etherscan.io/address/0x621e455C4a139f5C4e4A8122Ce55Dc21630769E4)                      |
