//! Synthetic rounds for measuring the cost of proving as the number of participants grows.
//! Mix: 80% honest, 10% liars, 10% silent; all at depth 0 so every node is in the neighbourhood.

use alloy::{
    primitives::{keccak256, Address, Bytes, B256, U256},
    signers::{local::PrivateKeySigner, SignerSync},
};
use anyhow::Result;
use swarm_vm::{
    claim::{address_to_bucket, BatchRecord, PostageProof},
    commit_digest,
    postage::{BatchState as PostageBatch, PostageInput, PostageState},
    sample::{Sample, SampleEntry, SAMPLE_SIZE},
    wrap_commit, Reveal, RoundInput, SignedCommit, StakeRecord,
};

pub fn round(n: usize, extra_batches: usize) -> Result<RoundInput> {
    let chain_id = U256::from(11155111u64);
    let settlement = Address::repeat_byte(0xaa);
    let round = 1000u64;
    let anchor = keccak256(b"anchor");
    let seed = keccak256(b"seed");
    let sample = sim_sample(anchor);
    let truth = sample.hash();

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
        round_anchor: anchor,
        selection_seed: seed,
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
        stake_age_rounds: 2,
        claim: None,
        forced_claims: vec![],
        sample_max_value: U256::MAX,
        postage: Default::default(),
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
    // The storage evidence for the honest sample, stamped by a synthetic batch.
    let owner = PrivateKeySigner::from_bytes(&keccak256(b"synth batch owner"))?;
    let batch = BatchRecord {
        batch_id: keccak256(b"synth batch"),
        owner: owner.address(),
        depth: 20,
        bucket_depth: 16,
    };
    let witness = sample.witness(&anchor, seed, |addr| stamp(&owner, &batch, addr, 1));
    input.claim = Some(Bytes::from(witness.encode()));
    // The batch is alive in the carried postage state, paid far beyond the round.
    let seed_block = round * swarm_vm::ROUND_LENGTH + swarm_vm::SEED_OFFSET;
    input.postage = PostageInput {
        state: PostageState {
            last_cut_block: seed_block - swarm_vm::ROUND_LENGTH,
            price_block: 1,
            price_outpayment: U256::ZERO,
            price: U256::from(24000u32),
            batches: vec![PostageBatch {
                id: batch.batch_id,
                owner: batch.owner,
                depth: batch.depth,
                bucket_depth: batch.bucket_depth,
                normalised_balance: U256::from(u64::MAX),
                counted_to: U256::from(24000u64 * (seed_block - swarm_vm::ROUND_LENGTH - 1)),
            }],
        },
        prev_event_index: 0,
        prev_event_hash: B256::ZERO,
        events: vec![],
        cut_block: seed_block + 1,
    };
    for i in 0..extra_batches as u64 {
        let id = keccak256([b"synth extra batch".as_slice(), &i.to_be_bytes()].concat());
        let b = PostageBatch {
            id,
            owner: Address::repeat_byte(0x11),
            depth: 20,
            bucket_depth: 16,
            normalised_balance: U256::from(u64::MAX - i),
            counted_to: U256::from(24000u64 * (seed_block - swarm_vm::ROUND_LENGTH - 1)),
        };
        let at = input
            .postage
            .state
            .batches
            .binary_search_by(|x| x.id.cmp(&id))
            .unwrap_err();
        input.postage.state.batches.insert(at, b);
    }
    let _ = B256::ZERO;
    Ok(input)
}

/// 16 single-segment chunks: enough for a sample; the synthetic round does not check reserve size.
fn sim_sample(anchor: B256) -> Sample {
    let entries = (0u64..SAMPLE_SIZE as u64)
        .map(|i| {
            let mut p = vec![0u8; 32];
            p[..8].copy_from_slice(&i.to_be_bytes());
            SampleEntry::new(p, &anchor)
        })
        .collect();
    Sample::new(entries)
}

/// A Bee postage stamp for `addr`: index = (bucket << 32 | 0), signed by the batch owner.
pub fn stamp(
    owner: &PrivateKeySigner,
    batch: &BatchRecord,
    addr: B256,
    timestamp: u64,
) -> PostageProof {
    let index = (address_to_bucket(addr, batch.bucket_depth) as u64) << 32;
    let mut msg = Vec::with_capacity(80);
    msg.extend_from_slice(addr.as_slice());
    msg.extend_from_slice(batch.batch_id.as_slice());
    msg.extend_from_slice(&index.to_be_bytes());
    msg.extend_from_slice(&timestamp.to_be_bytes());
    let sig = owner
        .sign_message_sync(keccak256(msg).as_slice())
        .expect("sign");
    PostageProof {
        signature: Bytes::from(sig.as_bytes().to_vec()),
        postageId: batch.batch_id,
        index,
        timeStamp: timestamp,
    }
}
