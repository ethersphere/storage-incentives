//! Synthetic rounds for tests and measurements.

use super::game::{self, PublicValues, RoundInput, SignedCommit, Stake};
use super::{game_key, sign};
use crate::{ForcedCommit, Reveal};
use alloy_primitives::{keccak256, Address, B256, U256};

fn h(tag: &str, i: u64) -> B256 {
    keccak256([tag.as_bytes(), &i.to_be_bytes()].concat())
}

/// A round with `nodes` nodes (80% honest, 10% liars, 10% silent), of which the last `forced` use the
/// escape hatches.
pub fn synth(nodes: usize, forced: usize) -> (RoundInput, PublicValues) {
    let round: u64 = 1000;
    let chain_id = 31337u64;
    let settlement = Address::repeat_byte(0x5e);
    let round_anchor = h("anchor", round);
    let selection_seed = h("seed", round);
    let truth = h("truth", round);
    let depth = 4u8;

    struct Node {
        sk: U256,
        stake: Stake,
        reveal: Option<Reveal>,
    }
    let mut ns: Vec<Node> = (0..nodes as u64)
        .map(|i| {
            let (sk, key) = game_key(&h("key", i));
            let mut overlay = round_anchor;
            overlay.0[16..].copy_from_slice(&h("overlay", i).0[16..]);
            let kind = i % 10;
            let reveal = (kind != 9).then(|| Reveal {
                overlay,
                depth,
                hash: if kind == 8 { h("lie", i) } else { truth },
                nonce: h("nonce", i),
            });
            Node {
                sk,
                stake: Stake {
                    owner: Address::from_slice(&h("owner", i).0[12..]),
                    overlay,
                    committed_stake: U256::from(1_000_000_000_000u64 + i),
                    potential_stake: U256::from(100_000_000_000_000_000u64),
                    height: 0,
                    last_updated: 100,
                    key,
                    frozen: false,
                },
                reveal,
            }
        })
        .collect();
    let forced_nodes = ns.split_off(nodes - forced);
    ns.sort_by_key(|n| n.stake.owner);

    // A silent node committed to something: use a reveal it never sends.
    let obf_of = |n: &Node, i: u64| match &n.reveal {
        Some(r) => game::reveal_hash(r),
        None => game::reveal_hash(&Reveal {
            overlay: n.stake.overlay,
            depth,
            hash: truth,
            nonce: h("silent", i),
        }),
    };
    let commits: Vec<SignedCommit> = ns
        .iter()
        .enumerate()
        .map(|(i, n)| {
            let obf = obf_of(n, i as u64);
            SignedCommit {
                owner: n.stake.owner,
                obf,
                sig: sign(n.sk, game::commit_message(chain_id, &settlement, round, obf)),
            }
        })
        .collect();
    let forced_commits: Vec<ForcedCommit> = forced_nodes
        .iter()
        .enumerate()
        .map(|(i, n)| ForcedCommit {
            owner: n.stake.owner,
            obfuscated_hash: super::fr_bytes(obf_of(n, 1000 + i as u64)),
        })
        .collect();

    let input = RoundInput {
        chain_id,
        settlement,
        round,
        round_anchor,
        selection_seed,
        commits,
        forced_commits,
        reveals: ns.iter().filter_map(|n| n.reveal.clone()).collect(),
        forced_reveals: forced_nodes.iter().filter_map(|n| n.reveal.clone()).collect(),
        stakes: ns.iter().chain(&forced_nodes).map(|n| n.stake.clone()).collect(),
        stake_price: 24_000,
        last_claim_round: round - 1,
        last_winner_depth: depth,
        penalty_multiplier_disagreement: 1,
        penalty_multiplier_non_revealed: 2,
        penalty_random_factor: 100,
        stake_age_rounds: 2,
        fee_recipient: Address::repeat_byte(0xfe),
    };
    let pv = game::run(&input).expect("run");
    (input, pv)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Caps;

    #[test]
    fn synthetic_round() {
        let (input, pv) = synth(20, 2);
        assert!(pv.has_reveals);
        assert_ne!(pv.winner, Address::ZERO);
        assert_eq!(pv.redundancy, 16);
        assert_eq!(pv.freeze.iter().filter(|f| **f == 2).count(), 2);
        assert_eq!(pv.freeze.iter().filter(|f| **f == 1).count(), 2);
        let caps = Caps { p: 32 };
        let w = game::game_witness_json(&input, &pv, &caps).unwrap();
        assert_eq!(w["commits"].as_array().unwrap().len(), 32);
        assert_eq!(w["public"].as_array().unwrap().len(), 12 + 32);
    }

    /// A node whose stake record changed after the round started gets the no-reveal freeze, unless the
    /// change was a freeze of Settlement: then its commit only does not count (on master a frozen node
    /// cannot commit).
    #[test]
    fn frozen_node_gets_no_second_freeze() {
        let (mut input, base) = synth(10, 0);
        let k = 0;
        input.stakes[k].last_updated = input.round * crate::ROUND_LENGTH + 30;
        input.stakes[k].frozen = false;
        let changed = game::run(&input).unwrap();
        assert_eq!(changed.freeze[k], 2, "own stake change: no-reveal freeze");
        input.stakes[k].frozen = true;
        let frozen = game::run(&input).unwrap();
        assert_eq!(frozen.freeze[k], 0, "frozen by Settlement: no new freeze");
        assert!(frozen.frozen[k]);
        // The node does not play: one truth-teller less than in the round where it played honestly.
        let was_truth_teller = base.freeze[k] == 0;
        assert_eq!(frozen.redundancy + was_truth_teller as u16, base.redundancy);
    }
}
