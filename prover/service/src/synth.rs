//! Synthetic rounds for measuring the cost of proving as the number of participants grows.
//! Mix: 80% honest, 10% liars, 10% silent; all at depth 0 so every node is in the neighbourhood.

use alloy::{
    primitives::{keccak256, Address, Bytes, B256, U256},
    signers::{local::PrivateKeySigner, SignerSync},
};
use anyhow::Result;
use swarm_vm::{commit_digest, wrap_commit, Reveal, RoundInput, SignedCommit, StakeRecord};

pub fn round(n: usize) -> Result<RoundInput> {
    let chain_id = U256::from(11155111u64);
    let settlement = Address::repeat_byte(0xaa);
    let round = 1000u64;
    let truth = keccak256(b"reserve");

    let mut nodes: Vec<(PrivateKeySigner, usize)> = (0..n)
        .map(|i| {
            (
                PrivateKeySigner::from_bytes(&keccak256((i as u64 + 1).to_be_bytes())).unwrap(),
                i,
            )
        })
        .collect();
    nodes.sort_by_key(|(k, _)| k.address());

    let mut input = RoundInput {
        chain_id,
        settlement,
        round,
        round_anchor: keccak256(b"anchor"),
        selection_seed: keccak256(b"seed"),
        commits: vec![],
        forced_commits: vec![],
        reveals: vec![],
        forced_reveals: vec![],
        stakes: vec![],
        stake_price: 24000,
        last_claim_round: round - 1,
        last_winner_depth: 0,
        penalty_multiplier_disagreement: 1,
        penalty_multiplier_non_revealed: 2,
        penalty_random_factor: 100,
    };
    for (key, i) in nodes {
        let overlay = keccak256([b"overlay".as_slice(), &i.to_be_bytes()].concat());
        let hash = if i % 10 == 8 {
            keccak256(i.to_be_bytes())
        } else {
            truth
        };
        let nonce = keccak256([b"nonce".as_slice(), &i.to_be_bytes()].concat());
        let obf = wrap_commit(overlay, 0, hash, nonce);
        let sig =
            key.sign_message_sync(commit_digest(chain_id, settlement, round, obf).as_slice())?;
        input.commits.push(SignedCommit {
            owner: key.address(),
            obfuscated_hash: obf,
            signature: Bytes::from(sig.as_bytes().to_vec()),
        });
        let stake = U256::from(10u64.pow(17)) * U256::from(1 + i as u64 % 7);
        input.stakes.push(StakeRecord {
            owner: key.address(),
            overlay,
            committed_stake: stake / U256::from(24000u32),
            potential_stake: stake,
            height: 0,
            last_updated: U256::from(1u8),
        });
        if i % 10 != 9 {
            input.reveals.push(Reveal {
                overlay,
                depth: 0,
                hash,
                nonce,
            });
        }
    }
    let _ = B256::ZERO;
    Ok(input)
}
