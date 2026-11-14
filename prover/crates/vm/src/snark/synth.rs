//! Synthetic rounds for tests and measurements.

use super::game::{self, PublicValues, RoundInput, SignedCommit, Stake};
use super::postage::{self, Event, State, KIND_CREATE, KIND_DEPTH, KIND_PRICE, KIND_TOPUP};
use super::{game_key, sign};
use crate::{ForcedCommit, Reveal, ROUND_LENGTH, SEED_OFFSET};
use alloy_primitives::{keccak256, Address, B256, U256};

fn h(tag: &str, i: u64) -> B256 {
    keccak256([tag.as_bytes(), &i.to_be_bytes()].concat())
}

/// A round with `nodes` nodes (80% honest, 10% liars, 10% silent), of which the last `forced` use the
/// escape hatches, `events` postage events and `expiries` batches that expire. `batches` live batches
/// exist before the round.
pub fn synth(
    nodes: usize,
    forced: usize,
    events: usize,
    expiries: usize,
    batches: usize,
) -> (RoundInput, PublicValues, State) {
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

    // Postage: a price, `batches` live batches and `expiries` batches that expire in this round.
    let price = 24_000u64;
    let prev_cut = (round - 1) * ROUND_LENGTH + SEED_OFFSET;
    let cut = round * ROUND_LENGTH + SEED_OFFSET;
    let mut st = State::default();
    let mut ev = vec![Event {
        index: 1,
        kind: KIND_PRICE,
        batch_id: B256::ZERO,
        depth: 0,
        value: U256::from(price),
        block: 1,
    }];
    for i in 0..(batches + expiries) as u64 {
        let expires = i >= batches as u64;
        ev.push(Event {
            index: 2 + i,
            kind: KIND_CREATE,
            batch_id: h("batch", i),
            depth: 20 + (i % 5) as u8,
            value: if expires {
                U256::from(price * (prev_cut + 10 + i))
            } else {
                U256::from(1_000_000_000_000u64 + i)
            },
            block: 5,
        });
    }
    let mut hash = B256::ZERO;
    for e in &ev {
        hash = postage::event_hash(hash, e);
    }
    let (r0, _) = st.settle(0, B256::ZERO, ev, prev_cut).expect("pre-population");
    assert_eq!(r0.event_hash, hash);

    let mut ev = Vec::new();
    for i in 0..events as u64 {
        let index = r0.event_index + 1 + i;
        let block = prev_cut + 1 + i % 60;
        let target = h("batch", i % batches.max(1) as u64);
        ev.push(match i % 3 {
            0 => Event {
                index,
                kind: KIND_CREATE,
                batch_id: h("new batch", i),
                depth: 22,
                value: U256::from(2_000_000_000_000u64 + i),
                block,
            },
            1 if batches > 0 => Event {
                index,
                kind: KIND_TOPUP,
                batch_id: target,
                depth: 20 + ((i % batches as u64) % 5) as u8,
                value: U256::from(3_000_000_000_000u64 + i),
                block,
            },
            2 if batches > 0 => Event {
                index,
                kind: KIND_DEPTH,
                batch_id: target,
                depth: 26,
                value: U256::from(1_500_000_000_000u64 + i),
                block,
            },
            _ => Event {
                index,
                kind: KIND_PRICE,
                batch_id: B256::ZERO,
                depth: 0,
                value: U256::from(price + i),
                block,
            },
        });
    }
    ev.sort_by_key(|e| e.block);
    for (i, e) in ev.iter_mut().enumerate() {
        e.index = r0.event_index + 1 + i as u64;
    }
    let (pg, pin) = st.settle(r0.event_index, r0.event_hash, ev, cut).expect("postage");

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
        postage: pin,
    };
    let pv = game::run(&input, &pg).expect("run");
    (input, pv, st)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Caps;

    #[test]
    fn synthetic_round() {
        let (input, pv, _) = synth(20, 2, 6, 2, 20);
        assert!(pv.has_reveals);
        assert_ne!(pv.winner, Address::ZERO);
        assert_eq!(pv.redundancy, 16);
        assert_eq!(pv.freeze.iter().filter(|f| **f == 2).count(), 2);
        assert_eq!(pv.freeze.iter().filter(|f| **f == 1).count(), 2);
        assert_eq!(input.postage.witness.expiries.len(), 2);
        let caps = Caps { p: 32, f: 4, e: 8, x: 4 };
        let w = game::game_witness_json(&input, &pv, &caps).unwrap();
        assert_eq!(w["commits"].as_array().unwrap().len(), 32);
        assert_eq!(w["public"].as_array().unwrap().len(), 12 + 36);
        let w = game::postage_witness_json(&input.postage, &pv, &caps).unwrap();
        assert_eq!(w["public"].as_array().unwrap().len(), 9);
    }
}

