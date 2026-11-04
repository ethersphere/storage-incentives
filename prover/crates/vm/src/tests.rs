use super::*;
use crate::claim::{
    address_to_bucket, verify_claim, BatchRecord, ClaimContext, ClaimError, PostageProof,
};
use crate::sample::{Sample, SampleEntry, SAMPLE_SIZE};
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
        stake_age_rounds: 2,
        claim: None,
        forced_claims: vec![],
        sample_max_value: U256::MAX,
        postage: postage::PostageInput {
            cut_block: SEED_BLOCK,
            ..Default::default()
        },
    }
}

const SEED_BLOCK: u64 = ROUND * ROUND_LENGTH + SEED_OFFSET;

/// Give the round a postage state with these batches (and their normalisedBalance) alive since the last
/// cut at SEED_BLOCK - ROUND_LENGTH, price 1 since block 1, and replay `events` up to SEED_BLOCK + 1. The
/// witness covers the batches of the round's current claim candidates, so call this after setting them.
fn set_postage(
    input: &mut RoundInput,
    batches: &[(BatchRecord, U256)],
    events: Vec<postage::PostageEvent>,
) {
    let leaves: Vec<postage::Leaf> = batches
        .iter()
        .map(|(b, balance)| postage::Leaf {
            id: b.batch_id,
            owner: b.owner,
            depth: b.depth,
            bucket_depth: b.bucket_depth,
            balance: *balance,
            ..Default::default()
        })
        .collect();
    let mut state = postage::PostageState::from_batches(
        SEED_BLOCK - ROUND_LENGTH,
        1,
        U256::ZERO,
        U256::from(1u8),
        &leaves,
    )
    .unwrap();
    let ids = claim_batch_ids(input);
    let (_, p) = state
        .settle(
            0,
            B256::ZERO,
            events,
            SEED_BLOCK + 1,
            SEED_BLOCK,
            &ids,
            true,
        )
        .unwrap();
    input.postage = p.unwrap();
}

/// `batch()` alive and funded far beyond the round.
fn postage_with_batch(input: &mut RoundInput) {
    set_postage(input, &[(batch(), U256::from(10u64.pow(18)))], vec![]);
}

fn batch_owner() -> PrivateKeySigner {
    PrivateKeySigner::from_bytes(&keccak256(b"batch owner")).unwrap()
}

fn batch() -> BatchRecord {
    BatchRecord {
        batch_id: keccak256(b"batch"),
        owner: batch_owner().address(),
        depth: 20,
        bucket_depth: 16,
    }
}

/// A postage stamp for `addr` in `batch()`, signed by its owner, as Bee would attach it.
fn stamp_with(key: &PrivateKeySigner, addr: B256) -> PostageProof {
    let b = batch();
    let index = (address_to_bucket(addr, b.bucket_depth) as u64) << 32;
    let mut msg = Vec::new();
    msg.extend_from_slice(addr.as_slice());
    msg.extend_from_slice(b.batch_id.as_slice());
    msg.extend_from_slice(&index.to_be_bytes());
    msg.extend_from_slice(&1u64.to_be_bytes());
    let sig = key.sign_message_sync(keccak256(msg).as_slice()).unwrap();
    PostageProof {
        signature: Bytes::from(sig.as_bytes().to_vec()),
        postageId: b.batch_id,
        index,
        timeStamp: 1,
    }
}

fn stamp(addr: B256) -> PostageProof {
    stamp_with(&batch_owner(), addr)
}

/// 32-byte payload like the tests' numberToArray(n).
fn payload(n: u32) -> Vec<u8> {
    let mut p = vec![0u8; 32];
    p[..4].copy_from_slice(&n.to_be_bytes());
    p
}

/// 16 chunks whose original addresses are in proximity of `anchor` at `depth`.
fn sample(anchor: B256, depth: u8) -> Sample {
    let entries: Vec<SampleEntry> = (0u32..)
        .map(|i| SampleEntry::new(payload(i), &anchor))
        .filter(|e| in_proximity(e.original, anchor, depth))
        .take(SAMPLE_SIZE)
        .collect();
    Sample::new(entries)
}

/// Attach the off-chain claim witness for `s` and the batch it uses.
fn with_claim(input: &mut RoundInput, s: &Sample) {
    let w = s.witness(&input.round_anchor, input.selection_seed, stamp);
    input.claim = Some(Bytes::from(w.encode()));
    postage_with_batch(input);
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
    let s = sample(B256::ZERO, 0);
    let h = s.hash();
    let mut input = play(&ns, 0, &[h; 4], &[true; 4]);
    with_claim(&mut input, &s);
    let pv = run(&input).unwrap();
    assert!(pv.outcome.hasTruth);
    assert!(!pv.outcome.unclaimed);
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
    let s = sample(B256::ZERO, 0);
    let h = s.hash();
    let lie = keccak256(b"lie");
    // Node 4 lies, node 3 never reveals. With 3 honest stakes against one liar the truth can still
    // land on the lie, so pick the outcome from the VM and check consistency.
    let mut input = play(&ns, 0, &[h, h, h, h, lie], &[true, true, true, false, true]);
    with_claim(&mut input, &s);
    let pv = run(&input).unwrap();
    let silent = ns[3].key.address();
    let liar = ns[4].key.address();
    if pv.outcome.truthHash != h {
        // The lie won the draw. Nobody holds a sample for it, so the round is unclaimed: no effects.
        assert!(pv.outcome.unclaimed && !pv.outcome.hasTruth);
        assert!(pv.outcome.freezeOwners.is_empty());
        assert_eq!(pv.outcome.winner, liar);
        return;
    }
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
    assert!(pv.outcome.freezeOwners.contains(&liar));
    assert_eq!(pv.outcome.redundancy, 3);
}

#[test]
fn bad_signature_is_dropped_not_fatal() {
    let ns = nodes(3);
    let smp = sample(B256::ZERO, 0);
    let h = smp.hash();
    let mut input = play(&ns, 0, &[h; 3], &[true; 3]);
    input.commits[1].signature = Bytes::from(vec![0u8; 65]);
    input.stakes.remove(1);
    with_claim(&mut input, &smp);
    let pv = run(&input).unwrap();
    assert_eq!(pv.inputs.participants.len(), 2);
    assert_eq!(pv.outcome.redundancy, 2);
    // commitsHash still covers the anchored list as the chain saw it.
    assert_eq!(pv.inputs.commitCount, 3);
}

#[test]
fn forced_commit_and_reveal_count() {
    let ns = nodes(3);
    let smp = sample(B256::ZERO, 0);
    let h = smp.hash();
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
    with_claim(&mut input, &smp);
    let pv = run(&input).unwrap();
    assert_eq!(pv.outcome.redundancy, 3);
    assert_eq!(pv.inputs.participants[2], c.owner);
    assert_ne!(pv.inputs.forcedCommitsHash, B256::ZERO);
    assert_ne!(pv.inputs.forcedRevealsHash, B256::ZERO);
}

#[test]
fn anchored_reveals_are_public_and_a_dropped_reveal_can_be_forced() {
    let ns = nodes(3);
    let smp = sample(B256::ZERO, 0);
    let h = smp.hash();
    let mut input = play(&ns, 0, &[h; 3], &[true; 3]);
    with_claim(&mut input, &smp);
    let pv = run(&input).unwrap();
    assert_eq!(pv.inputs.revealCount, 3);
    assert_eq!(pv.inputs.revealsHash, reveals_hash(&input.reveals));
    assert!(pv.outcome.freezeOwners.is_empty());

    // A censoring prover keeps node 1's commit but leaves its reveal out of the anchored list: the
    // node is frozen for non-reveal, and revealsHash on chain shows the list without it.
    let dropped = input.reveals.remove(1);
    let pv = run(&input).unwrap();
    assert_eq!(pv.inputs.revealCount, 2);
    assert_eq!(pv.outcome.freezeOwners, vec![ns[1].key.address()]);

    // The node sees that and calls forceReveal before the seed block: not frozen.
    input.forced_reveals.push(dropped);
    let pv = run(&input).unwrap();
    assert!(pv.outcome.freezeOwners.is_empty());
    assert_eq!(pv.outcome.redundancy, 3);

    assert_eq!(reveals_hash(&[]), B256::ZERO);
}

#[test]
fn out_of_proximity_reveal_counts_as_not_revealed() {
    let mut ns = nodes(2);
    // depth 1 with height 0: overlay must share the first bit with the zero anchor.
    ns[0].overlay = b256!("0100000000000000000000000000000000000000000000000000000000000000");
    ns[1].overlay = b256!("8100000000000000000000000000000000000000000000000000000000000000");
    let smp = sample(B256::ZERO, 1);
    let h = smp.hash();
    let mut input = play(&ns, 1, &[h; 2], &[true; 2]);
    with_claim(&mut input, &smp);
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
    let smp = sample(B256::ZERO, 0);
    let h = smp.hash();
    let mut input = play(&ns, 0, &[h; 2], &[true; 2]);
    input.stakes[1].last_updated = U256::from(ROUND * ROUND_LENGTH - 10);
    with_claim(&mut input, &smp);
    let pv = run(&input).unwrap();
    assert_eq!(pv.outcome.redundancy, 1);
    assert_eq!(pv.inputs.participants.len(), 2);
}

#[test]
fn stake_age_zero_lets_a_node_play_in_the_next_round() {
    let ns = nodes(2);
    let smp = sample(B256::ZERO, 0);
    let mut input = play(&ns, 0, &[smp.hash(); 2], &[true; 2]);
    with_claim(&mut input, &smp);
    // Node 1 staked in the previous round.
    input.stakes[1].last_updated = U256::from(ROUND * ROUND_LENGTH - 10);
    assert_eq!(run(&input).unwrap().outcome.redundancy, 1);
    input.stake_age_rounds = 0;
    assert_eq!(run(&input).unwrap().outcome.redundancy, 2);
    // A stake made during the round still does not count.
    input.stakes[1].last_updated = U256::from(ROUND * ROUND_LENGTH + 3);
    assert_eq!(run(&input).unwrap().outcome.redundancy, 1);
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
    let smp = sample(B256::ZERO, 0);
    let mut input = play(&ns, 0, &[smp.hash(); 3], &[true, true, false]);
    with_claim(&mut input, &smp);
    let pv = run(&input).unwrap();
    let bytes = PublicValues::abi_encode(&pv);
    assert_eq!(PublicValues::abi_decode(&bytes).unwrap(), pv);
}

// ------------------------------------------------------------------------------------------------
// claim (storage evidence)
// ------------------------------------------------------------------------------------------------

#[test]
fn bmt_builder_matches_proof_verification() {
    let anchor = keccak256(b"anchor");
    let p = payload(7);
    let plain = bmt::Tree::new(&p, None);
    let keyed = bmt::Tree::new(&p, Some(anchor));
    for i in [0usize, 1, 5, 127] {
        assert_eq!(
            bmt::chunk_address_from_proof(&plain.proof(i), plain.segment(i), i as u64, 32),
            plain.address()
        );
        assert_eq!(
            bmt::transformed_address_from_proof(
                &keyed.proof(i),
                keyed.segment(i),
                i as u64,
                32,
                &anchor
            ),
            keyed.address()
        );
    }
    let fast = sample::FastHasher::new(anchor);
    let seg = B256::from_slice(&p);
    assert_eq!(fast.original(seg), plain.address());
    assert_eq!(fast.transformed(seg), keyed.address());
}

fn claim_ctx<'a>(
    s: &Sample,
    anchor: B256,
    seed: B256,
    batches: &'a [BatchRecord],
) -> ClaimContext<'a> {
    ClaimContext {
        anchor,
        seed,
        sample_hash: s.hash(),
        depth: 0,
        batches,
        sample_max_value: U256::MAX,
    }
}

#[test]
fn valid_witness_verifies_for_many_seeds() {
    let anchor = keccak256(b"anchor");
    let s = sample(anchor, 0);
    let batches = [batch()];
    for i in 0u8..20 {
        let seed = keccak256([i]);
        let w = s.witness(&anchor, seed, stamp);
        assert_eq!(
            verify_claim(&w, &claim_ctx(&s, anchor, seed, &batches)),
            Ok(()),
            "seed {i}"
        );
    }
}

#[test]
fn tampered_witnesses_are_rejected() {
    let anchor = keccak256(b"anchor");
    let seed = keccak256(b"seed");
    let s = sample(anchor, 0);
    let good = s.witness(&anchor, seed, stamp);
    let batches = [batch()];
    let ctx = claim_ctx(&s, anchor, seed, &batches);
    let check = |f: &dyn Fn(&mut claim::ClaimWitness)| {
        let mut w = good.clone();
        f(&mut w);
        verify_claim(&w, &ctx)
    };

    assert_eq!(
        check(&|w| w.proofLast.proofSegments[1] = keccak256(b"x")),
        Err(ClaimError::InclusionProofFailed(1))
    );
    assert_eq!(
        check(&|w| w.proofLast.proofSegments2[0] = keccak256(b"x")),
        Err(ClaimError::InclusionProofFailed(2))
    );
    assert_eq!(
        check(&|w| w.proofLast.proveSegment2 = keccak256(b"x")),
        Err(ClaimError::InclusionProofFailed(3))
    );
    assert_eq!(
        check(&|w| w.proofLast.proofSegments3[3] = keccak256(b"x")),
        Err(ClaimError::InclusionProofFailed(4))
    );
    assert_eq!(
        check(&|w| w.proofLast.chunkSpan = 33),
        Err(ClaimError::InclusionProofFailed(3))
    );
    assert_eq!(
        check(&|w| w.proofLast.postageProof =
            stamp_with(&PrivateKeySigner::random(), w.proofLast.proveSegment)),
        Err(ClaimError::SigRecoveryFailed)
    );
    assert_eq!(
        check(&|w| w.proofLast.postageProof.index += 1 << 32),
        Err(ClaimError::BucketDiffers)
    );
    assert_eq!(
        check(&|w| w.proofLast.postageProof.index |= 16),
        Err(ClaimError::IndexOutsideSet)
    );
    assert_eq!(
        check(&|w| w.proofLast.postageProof.postageId = B256::ZERO),
        Err(ClaimError::BatchDoesNotExist)
    );
    assert_eq!(
        check(&|w| w.proofLast.postageProof.signature = Bytes::from(vec![1u8; 64])),
        Err(ClaimError::SigRecoveryFailed)
    );
    assert_eq!(
        check(&|w| w.proofLast.proofSegments.clear()),
        Err(ClaimError::InclusionProofFailed(1))
    );
    // Witness 1 and 2 swapped: the inclusion index no longer matches.
    assert_eq!(
        check(&|w| std::mem::swap(&mut w.proof1, &mut w.proof2)),
        Err(ClaimError::InclusionProofFailed(1))
    );

    let mut tight = claim_ctx(&s, anchor, seed, &batches);
    tight.sample_max_value = U256::from_be_bytes(s.entries[SAMPLE_SIZE - 1].transformed.0);
    assert_eq!(
        verify_claim(&good, &tight),
        Err(ClaimError::ReserveCheckFailed)
    );

    let mut deep = claim_ctx(&s, anchor, seed, &batches);
    deep.depth = 12;
    assert!(matches!(
        verify_claim(&good, &deep),
        Err(ClaimError::OutOfDepthClaim(_))
    ));

    let dead = [BatchRecord {
        owner: Address::ZERO,
        ..batch()
    }];
    assert_eq!(
        verify_claim(&good, &claim_ctx(&s, anchor, seed, &dead)),
        Err(ClaimError::BatchDoesNotExist)
    );
}

#[test]
fn wrong_order_in_sample_is_rejected() {
    // Build a "sample" whose entries are not sorted by transformed address.
    let anchor = keccak256(b"anchor");
    let seed = keccak256(b"seed");
    let s = sample(anchor, 0);
    let mut entries = s.entries.clone();
    entries.reverse();
    let mut payload_bytes = Vec::new();
    for e in &entries {
        payload_bytes.extend_from_slice(e.original.as_slice());
        payload_bytes.extend_from_slice(e.transformed.as_slice());
    }
    let tree = bmt::Tree::new(&payload_bytes, None);
    // Re-point the witness at the unsorted tree: proofs are valid, order is not.
    let (i1, i2) = claim::witness_indices(seed);
    let mut w = s.witness(&anchor, seed, stamp);
    for (p, k) in [
        (&mut w.proof1, i1 as usize),
        (&mut w.proof2, i2 as usize),
        (&mut w.proofLast, 15),
    ] {
        let e = &entries[k];
        p.proofSegments = tree.proof(k * 2);
        p.proveSegment = tree.segment(k * 2);
        let og = bmt::Tree::new(&e.payload, None);
        let tr = bmt::Tree::new(&e.payload, Some(anchor));
        let seg = claim::chunk_segment_index(seed) as usize;
        p.proofSegments2 = og.proof(seg);
        p.proveSegment2 = og.segment(seg);
        p.proofSegments3 = tr.proof(seg);
        p.postageProof = stamp(e.original);
    }
    let batches = [batch()];
    let ctx = ClaimContext {
        sample_hash: tree.address(),
        ..claim_ctx(&s, anchor, seed, &batches)
    };
    assert!(matches!(
        verify_claim(&w, &ctx),
        Err(ClaimError::RandomElementCheckFailed) | Err(ClaimError::LastElementCheckFailed)
    ));
}

#[test]
fn truth_without_witness_is_unclaimed() {
    let ns = nodes(3);
    let s = sample(B256::ZERO, 0);
    let input = play(&ns, 0, &[s.hash(); 3], &[true, true, false]);
    let pv = run(&input).unwrap();
    assert!(!pv.outcome.hasTruth);
    assert!(pv.outcome.unclaimed);
    assert!(pv.outcome.freezeOwners.is_empty());
}

#[test]
fn forced_claim_counts_when_the_prover_has_none() {
    let ns = nodes(3);
    let s = sample(B256::ZERO, 0);
    let mut input = play(&ns, 0, &[s.hash(); 3], &[true; 3]);
    let w = s.witness(&input.round_anchor, input.selection_seed, stamp);
    input.forced_claims = vec![Bytes::from(vec![1, 2, 3]), Bytes::from(w.encode())];
    postage_with_batch(&mut input);
    let pv = run(&input).unwrap();
    assert!(pv.outcome.hasTruth);
    assert_eq!(
        pv.inputs.forcedClaimsHash,
        claim::forced_claims_hash(&input.forced_claims)
    );
}

#[test]
fn claim_needs_the_batch_in_the_postage_state() {
    let ns = nodes(2);
    let s = sample(B256::ZERO, 0);
    let mut input = play(&ns, 0, &[s.hash(); 2], &[true; 2]);
    with_claim(&mut input, &s);
    // The batch is unknown to the proven postage state: the claim fails, the round is unclaimed. The
    // proof shows that the batch is not in the tree.
    set_postage(&mut input, &[], vec![]);
    let pv = run(&input).unwrap();
    assert!(pv.outcome.unclaimed && !pv.outcome.hasTruth);
}

#[test]
fn claim_needs_a_batch_alive_at_the_seed_block() {
    let ns = nodes(2);
    let s = sample(B256::ZERO, 0);
    let mut input = play(&ns, 0, &[s.hash(); 2], &[true; 2]);
    with_claim(&mut input, &s);
    // Outpayment at the seed block is SEED_BLOCK - 1 (price 1 since block 1): balance just at it.
    set_postage(&mut input, &[(batch(), U256::from(SEED_BLOCK - 1))], vec![]);
    assert!(run(&input).unwrap().outcome.unclaimed);
    set_postage(&mut input, &[(batch(), U256::from(SEED_BLOCK))], vec![]);
    assert!(run(&input).unwrap().outcome.hasTruth);
}

#[test]
fn postage_outcome_is_part_of_every_round() {
    // Even a round without reveals settles the postage accounting.
    let ns = nodes(2);
    let mut input = play(&ns, 0, &[keccak256(b"x"); 2], &[false; 2]);
    postage_with_batch(&mut input);
    let pv = run(&input).unwrap();
    assert!(!pv.outcome.hasTruth);
    // Paid to the outpayment at the last cut, SEED_BLOCK - ROUND_LENGTH - 1. Price 1 since block 1, so the outpayment at the cut
    // (SEED_BLOCK + 1) is SEED_BLOCK: ROUND_LENGTH + 1 blocks of 2^20 chunks.
    assert_eq!(
        pv.outcome.postage.potAmount,
        U256::from((ROUND_LENGTH + 1) << 20)
    );
    assert_eq!(pv.outcome.postage.validChunkCount, U256::from(1u64 << 20));
    assert_eq!(pv.inputs.postage.prevStateHash, input.postage.header.hash());
}

/// Soundness: a prover controls the private parts of the input. For each of them, a change must make
/// the VM fail, or change a public input (which Settlement checks against the chain), or leave the
/// outcome as it was. Otherwise a prover could pick the outcome. The claim witness is the one known
/// exception: a prover can withhold it, and the winner's defence is forceClaim (docs/ZK-SETTLEMENT.md).
#[test]
fn every_private_input_is_bound_to_a_public_input() {
    let ns = nodes(4);
    let smp = sample(B256::ZERO, 0);
    let h = smp.hash();
    let lie = keccak256(b"lie");
    // The liar has the smallest stake, so the honest hash is the truth for this seed.
    let liar = (0..4).min_by_key(|&i| ns[i].stake).unwrap();
    let mut hashes = [h; 4];
    hashes[liar] = lie;
    let mut base = play(&ns, 0, &hashes, &[true; 4]);
    with_claim(&mut base, &smp);
    // One PostageStampZK log entry in the replayed range (a price event that keeps the price).
    let block = SEED_BLOCK - 10;
    let event = postage::PostageEvent {
        index: 1,
        kind: postage::KIND_PRICE,
        batch_id: B256::ZERO,
        owner: Address::ZERO,
        depth: 0,
        bucket_depth: 0,
        value: U256::from(1u8),
        outpayment: U256::from(block - 1),
        block,
    };
    set_postage(
        &mut base,
        &[(batch(), U256::from(10u64.pow(18)))],
        vec![event],
    );
    // Node 3 uses the escape hatches, so the forced lists are not empty.
    let c = base.commits.remove(3);
    let r = base.reveals.remove(3);
    let s = base.stakes.remove(3);
    base.forced_commits.push(ForcedCommit {
        owner: c.owner,
        obfuscated_hash: c.obfuscated_hash,
    });
    base.forced_reveals.push(r);
    base.stakes.push(s);
    let good = run(&base).expect("base round");
    assert!(good.outcome.hasTruth);
    assert_eq!(good.outcome.freezeOwners.len(), 1);

    type Mutation = (&'static str, fn(&mut RoundInput));
    let mutations: Vec<Mutation> = vec![
        ("drop an anchored commit", |i| {
            i.commits.remove(0);
        }),
        ("change a commit", |i| {
            i.commits[1].obfuscated_hash = keccak256(b"x")
        }),
        ("break a commit signature", |i| {
            i.commits[1].signature = Bytes::from(vec![1u8; 65])
        }),
        ("drop an anchored reveal", |i| {
            i.reveals.remove(0);
        }),
        ("change a reveal nonce", |i| {
            i.reveals[1].nonce = keccak256(b"x")
        }),
        ("add a reveal that was not anchored", |i| {
            let mut r = i.forced_reveals[0].clone();
            r.nonce = keccak256(b"y");
            i.reveals.push(r);
        }),
        ("drop a forced commit", |i| {
            i.forced_commits.clear();
            i.stakes.pop();
        }),
        ("drop a forced reveal", |i| i.forced_reveals.clear()),
        ("change a stake amount", |i| {
            i.stakes[0].committed_stake *= U256::from(10u8)
        }),
        ("change a stake overlay", |i| {
            i.stakes[1].overlay = keccak256(b"o")
        }),
        ("change a stake height", |i| i.stakes[1].height = 1),
        ("change a stake update block", |i| {
            i.stakes[1].last_updated = U256::from(SEED_BLOCK)
        }),
        ("swap two stake records", |i| i.stakes.swap(0, 1)),
        ("change the stake price", |i| i.stake_price = 7),
        ("change the game state", |i| i.last_claim_round = ROUND - 1),
        ("change a penalty", |i| {
            i.penalty_multiplier_non_revealed = 0
        }),
        ("change the stake age", |i| i.stake_age_rounds = 0),
        ("change the sample bound", |i| {
            i.sample_max_value = U256::from(1u8)
        }),
        ("change the seed", |i| i.selection_seed = keccak256(b"s")),
        ("change the anchor", |i| i.round_anchor = keccak256(b"a")),
        ("change a batch leaf in the postage witness", |i| {
            let p = i
                .postage
                .witness
                .proofs
                .iter_mut()
                .find(|p| p.leaf.id == batch().batch_id);
            p.unwrap().leaf.balance += U256::from(1u8)
        }),
        ("drop a postage proof", |i| {
            i.postage.witness.proofs.pop();
        }),
        ("change a postage hint", |i| i.postage.witness.hints[0] ^= 1),
        ("change the batch tree root", |i| {
            i.postage.header.root = keccak256(b"r")
        }),
        ("change the postage price", |i| {
            i.postage.header.price = U256::from(2u8)
        }),
        ("change a postage log entry", |i| {
            i.postage.events[0].value = U256::from(2u8)
        }),
        ("drop a postage log entry", |i| i.postage.events.clear()),
        ("change the cut block", |i| i.postage.cut_block -= 1),
        ("forge a forced claim", |i| {
            i.forced_claims.push(Bytes::from(vec![0u8; 32]))
        }),
    ];

    for (name, mutate) in mutations {
        let mut m = base.clone();
        mutate(&mut m);
        match run(&m) {
            Err(_) => {}
            Ok(pv) => assert!(
                pv.inputs != good.inputs || pv.outcome == good.outcome,
                "{name}: the outcome changed but the public inputs did not"
            ),
        }
    }

    // The known exception: withholding the off-chain witness changes the outcome (unclaimed) with the
    // same public inputs. Unclaimed rounds settle only after the claim window, so the winner can still
    // call forceClaim, which changes forcedClaimsHash.
    let mut m = base.clone();
    m.claim = None;
    // Without the claim, the prover builds the postage witness for no claim batches.
    let event = base.postage.events.clone();
    set_postage(&mut m, &[(batch(), U256::from(10u64.pow(18)))], event);
    let pv = run(&m).unwrap();
    assert_eq!(pv.inputs, good.inputs);
    assert!(pv.outcome.unclaimed && !pv.outcome.hasTruth);
}

#[test]
fn anchored_lists_are_merkle_roots_a_node_can_check_alone() {
    let leaves: Vec<B256> = (0u8..5).map(|i| keccak256([i])).collect();
    let root = list_root(&leaves);
    for (i, l) in leaves.iter().enumerate() {
        let p = list_proof(&leaves, i);
        assert!(list_verify(root, 5, i, *l, &p));
        // Not at another index, not another leaf. (The count is the one anchored on chain.)
        assert!(!list_verify(root, 5, (i + 1) % 5, *l, &p));
        assert!(!list_verify(root, 5, i, keccak256(b"x"), &p));
    }
    // A padding position is not a member.
    assert!(!list_verify(
        root,
        5,
        5,
        B256::ZERO,
        &list_proof(&leaves, 5)
    ));
    assert_eq!(list_root(&[]), B256::ZERO);
    assert_eq!(list_root(&leaves[..1]), leaves[0]);
    assert_eq!(reveals_hash(&[]), B256::ZERO);
}

#[test]
fn a_node_that_changes_its_stake_during_the_round_is_frozen_not_just_dropped() {
    let ns = nodes(3);
    let smp = sample(B256::ZERO, 0);
    let h = smp.hash();
    let mut input = play(&ns, 0, &[h, h, keccak256(b"lie")], &[true; 3]);
    with_claim(&mut input, &smp);
    // The liar sees the seed and calls manageStake(nonce, 0, height) before the settlement.
    input.stakes[2].last_updated = U256::from(SEED_BLOCK + 1);
    let pv = run(&input).unwrap();
    assert!(pv.outcome.hasTruth);
    assert_eq!(pv.outcome.redundancy, 2);
    let i = pv
        .outcome
        .freezeOwners
        .iter()
        .position(|o| *o == ns[2].key.address())
        .expect("the node that left is frozen");
    // The non-reveal freeze: more than the disagreement freeze it tried to escape.
    let unit = U256::from(ROUND_LENGTH) << pv.outcome.truthDepth as usize;
    assert_eq!(pv.outcome.freezeDurations[i], unit * U256::from(2u8));
}
