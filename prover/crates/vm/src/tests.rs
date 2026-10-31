use super::*;
use alloy_primitives::{address, b256, Bytes};
use alloy_signer::SignerSync;
use alloy_signer_local::PrivateKeySigner;

const ROUND: u64 = 100;

struct Node {
    key: PrivateKeySigner,
    overlay: B256,
    stake: U256,
    height: u8,
}

fn nodes(n: usize) -> Vec<Node> {
    let mut v: Vec<Node> = (0..n)
        .map(|i| Node {
            key: PrivateKeySigner::from_bytes(&keccak256([i as u8 + 1])).unwrap(),
            overlay: keccak256([b'o', i as u8]),
            stake: U256::from(10u64.pow(17)) * U256::from(i as u64 + 1),
            height: 0,
        })
        .collect();
    v.sort_by_key(|n| n.key.address());
    v
}

fn base_input() -> RoundInput {
    RoundInput {
        chain_id: U256::from(11155111u64),
        settlement: address!("00000000000000000000000000000000000000aa"),
        round: ROUND,
        round_anchor: b256!("0000000000000000000000000000000000000000000000000000000000000000"),
        selection_seed: keccak256(b"seed"),
        commits: vec![],
        forced_commits: vec![],
        reveals: vec![],
        forced_reveals: vec![],
        stakes: vec![],
        stake_price: 1,
        last_claim_round: 0,
        last_winner_depth: 0,
        penalty_multiplier_disagreement: 1,
        penalty_multiplier_non_revealed: 2,
        penalty_random_factor: 100,
    }
}

fn stake_of(n: &Node) -> StakeRecord {
    StakeRecord {
        owner: n.key.address(),
        overlay: n.overlay,
        committed_stake: n.stake,
        potential_stake: n.stake,
        height: n.height,
        last_updated: U256::from(1u8),
    }
}

/// Every node commits off chain to (depth, hash) and reveals unless `reveal` says otherwise.
fn play(ns: &[Node], depth: u8, hashes: &[B256], reveal: &[bool]) -> RoundInput {
    let mut input = base_input();
    for (i, n) in ns.iter().enumerate() {
        let nonce = keccak256([b'n', i as u8]);
        let obf = wrap_commit(n.overlay, depth, hashes[i], nonce);
        let digest = commit_digest(input.chain_id, input.settlement, ROUND, obf);
        let sig = n.key.sign_message_sync(digest.as_slice()).unwrap();
        input.commits.push(SignedCommit {
            owner: n.key.address(),
            obfuscated_hash: obf,
            signature: Bytes::from(sig.as_bytes().to_vec()),
        });
        input.stakes.push(stake_of(n));
        if reveal[i] {
            input.reveals.push(Reveal {
                overlay: n.overlay,
                depth,
                hash: hashes[i],
                nonce,
            });
        }
    }
    input
}

#[test]
fn digests_match_solidity_encoding() {
    // abi.encodePacked(bytes32, uint8, bytes32, bytes32) is 97 bytes.
    let w = wrap_commit(B256::ZERO, 1, B256::ZERO, B256::ZERO);
    let mut buf = [0u8; 97];
    buf[32] = 1;
    assert_eq!(w, keccak256(buf));
    assert_eq!(forced_commits_hash(&[]), B256::ZERO);
}

#[test]
fn in_proximity_matches_solidity() {
    let a = b256!("8000000000000000000000000000000000000000000000000000000000000000");
    assert!(in_proximity(a, B256::ZERO, 0));
    assert!(!in_proximity(a, B256::ZERO, 1));
    let b = b256!("4000000000000000000000000000000000000000000000000000000000000000");
    assert!(in_proximity(b, B256::ZERO, 1));
    assert!(!in_proximity(b, B256::ZERO, 2));
}

#[test]
fn minimum_depth_matches_solidity() {
    assert_eq!(minimum_depth(100, 0, 0), 0);
    assert_eq!(minimum_depth(100, 99, 10), 8);
    assert_eq!(minimum_depth(100, 97, 10), 6);
    assert_eq!(minimum_depth(100, 0, 10), 0);
}

#[test]
fn honest_round_pays_one_and_freezes_nobody() {
    let ns = nodes(4);
    let h = keccak256(b"reserve");
    let input = play(&ns, 0, &[h; 4], &[true; 4]);
    let pv = run(&input).unwrap();
    assert!(pv.outcome.hasTruth);
    assert_eq!(pv.outcome.truthHash, h);
    assert_eq!(pv.outcome.redundancy, 4);
    assert!(ns.iter().any(|n| n.key.address() == pv.outcome.winner));
    assert!(pv.outcome.freezeOwners.is_empty());
    assert_eq!(pv.inputs.participants.len(), 4);
    assert_eq!(pv.inputs.stakeDigest, stake_digest(&input.stakes));
}

#[test]
fn liar_and_silent_nodes_are_frozen() {
    let ns = nodes(5);
    let h = keccak256(b"reserve");
    let lie = keccak256(b"lie");
    // Node 4 lies, node 3 never reveals. With 3 honest stakes against one liar the truth can still
    // land on the lie, so pick the outcome from the VM and check consistency.
    let input = play(&ns, 0, &[h, h, h, h, lie], &[true, true, true, false, true]);
    let pv = run(&input).unwrap();
    let silent = ns[3].key.address();
    let liar = ns[4].key.address();
    assert!(pv.outcome.freezeOwners.contains(&silent));
    let silent_idx = pv
        .outcome
        .freezeOwners
        .iter()
        .position(|o| *o == silent)
        .unwrap();
    assert_eq!(
        pv.outcome.freezeDurations[silent_idx],
        U256::from(2 * ROUND_LENGTH)
    );
    if pv.outcome.truthHash == h {
        assert!(pv.outcome.freezeOwners.contains(&liar));
        assert_eq!(pv.outcome.redundancy, 3);
    } else {
        assert_eq!(pv.outcome.redundancy, 1);
        assert_eq!(pv.outcome.winner, liar);
    }
}

#[test]
fn bad_signature_is_dropped_not_fatal() {
    let ns = nodes(3);
    let h = keccak256(b"reserve");
    let mut input = play(&ns, 0, &[h; 3], &[true; 3]);
    input.commits[1].signature = Bytes::from(vec![0u8; 65]);
    input.stakes.remove(1);
    let pv = run(&input).unwrap();
    assert_eq!(pv.inputs.participants.len(), 2);
    assert_eq!(pv.outcome.redundancy, 2);
    // commitsHash still covers the anchored list as the chain saw it.
    assert_eq!(pv.inputs.commitCount, 3);
}

#[test]
fn forced_commit_and_reveal_count() {
    let ns = nodes(3);
    let h = keccak256(b"reserve");
    let mut input = play(&ns, 0, &[h; 3], &[true; 3]);
    // Move node 2 to the forced path: drop its off-chain commit and reveal.
    let c = input.commits.remove(2);
    let r = input.reveals.remove(2);
    let s = input.stakes.remove(2);
    input.forced_commits.push(ForcedCommit {
        owner: c.owner,
        obfuscated_hash: c.obfuscated_hash,
    });
    input.forced_reveals.push(r);
    input.stakes.push(s);
    let pv = run(&input).unwrap();
    assert_eq!(pv.outcome.redundancy, 3);
    assert_eq!(pv.inputs.participants[2], c.owner);
    assert_ne!(pv.inputs.forcedCommitsHash, B256::ZERO);
    assert_ne!(pv.inputs.forcedRevealsHash, B256::ZERO);
}

#[test]
fn out_of_proximity_reveal_counts_as_not_revealed() {
    let mut ns = nodes(2);
    // depth 1 with height 0: overlay must share the first bit with the zero anchor.
    ns[0].overlay = b256!("0100000000000000000000000000000000000000000000000000000000000000");
    ns[1].overlay = b256!("8100000000000000000000000000000000000000000000000000000000000000");
    let h = keccak256(b"reserve");
    let input = play(&ns, 1, &[h; 2], &[true; 2]);
    let pv = run(&input).unwrap();
    assert_eq!(pv.outcome.redundancy, 1);
    assert_eq!(pv.outcome.winner, ns[0].key.address());
    assert_eq!(pv.outcome.freezeOwners, vec![ns[1].key.address()]);
    // density = stake * 2^(depth - height)
    assert_eq!(pv.outcome.winnerStakeDensity, ns[0].stake * U256::from(2u8));
}

#[test]
fn recently_staked_node_is_ignored() {
    let ns = nodes(2);
    let h = keccak256(b"reserve");
    let mut input = play(&ns, 0, &[h; 2], &[true; 2]);
    input.stakes[1].last_updated = U256::from(ROUND * ROUND_LENGTH - 10);
    let pv = run(&input).unwrap();
    assert_eq!(pv.outcome.redundancy, 1);
    assert_eq!(pv.inputs.participants.len(), 2);
}

#[test]
fn effective_stake_is_capped_by_potential() {
    let s = StakeRecord {
        owner: Address::ZERO,
        overlay: B256::ZERO,
        committed_stake: U256::from(10u8),
        potential_stake: U256::from(1000u16),
        height: 1,
        last_updated: U256::from(1u8),
    };
    assert_eq!(effective_stake(&s, 24), Some(U256::from(480u16)));
    assert_eq!(effective_stake(&s, 100), Some(U256::from(1000u16)));
}

#[test]
fn no_reveals_means_no_truth() {
    let ns = nodes(2);
    let h = keccak256(b"reserve");
    let input = play(&ns, 0, &[h; 2], &[false; 2]);
    let pv = run(&input).unwrap();
    assert!(!pv.outcome.hasTruth);
    assert!(pv.outcome.freezeOwners.is_empty());
}

#[test]
fn unsorted_commits_are_rejected() {
    let ns = nodes(2);
    let h = keccak256(b"reserve");
    let mut input = play(&ns, 0, &[h; 2], &[true; 2]);
    input.commits.swap(0, 1);
    assert_eq!(run(&input), Err(VmError::CommitsNotSorted));
}

#[test]
fn public_values_roundtrip_abi() {
    use alloy_sol_types::SolType;
    let ns = nodes(3);
    let h = keccak256(b"reserve");
    let pv = run(&play(&ns, 0, &[h; 3], &[true, true, false])).unwrap();
    let bytes = PublicValues::abi_encode(&pv);
    assert_eq!(PublicValues::abi_decode(&bytes).unwrap(), pv);
}
