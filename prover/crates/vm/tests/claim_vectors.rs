//! Differential test: the Rust claim checks must accept exactly the claims that the real
//! `Redistribution.claim` accepted in test/Redistribution.test.ts, including the Bee-generated CAC and
//! SOC proofs. Regenerate with:
//!
//!   DUMP_CLAIM_VECTORS=1 npx hardhat test test/Redistribution.test.ts --grep "should claim pot by"

use alloy_primitives::{hex, Address, B256, U256};
use swarm_vm::claim::{verify_claim, BatchRecord, ClaimContext, ClaimError, ClaimWitness};

/// Redistribution.sampleMaxValue default.
const SAMPLE_MAX_VALUE: &str =
    "1284401000000000000000000000000000000000000000000000000000000000000000000";

struct Vector {
    name: &'static str,
    anchor: B256,
    seed: B256,
    hash: B256,
    depth: u8,
    batches: Vec<BatchRecord>,
    witness: ClaimWitness,
}

fn load(name: &'static str) -> Vector {
    let path = format!("{}/tests/vectors/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let b32 = |k: &str| v[k].as_str().unwrap().parse::<B256>().unwrap();
    Vector {
        name,
        anchor: b32("anchor"),
        seed: b32("seed"),
        hash: b32("hash"),
        depth: v["depth"].as_u64().unwrap() as u8,
        batches: v["batches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| BatchRecord {
                batch_id: b["batchId"].as_str().unwrap().parse().unwrap(),
                owner: b["owner"].as_str().unwrap().parse::<Address>().unwrap(),
                depth: b["depth"].as_u64().unwrap() as u8,
                bucket_depth: b["bucketDepth"].as_u64().unwrap() as u8,
            })
            .collect(),
        witness: ClaimWitness::decode(&hex::decode(v["witness"].as_str().unwrap()).unwrap())
            .unwrap(),
    }
}

fn ctx(v: &Vector) -> ClaimContext<'_> {
    ClaimContext {
        anchor: v.anchor,
        seed: v.seed,
        sample_hash: v.hash,
        depth: v.depth,
        batches: &v.batches,
        sample_max_value: SAMPLE_MAX_VALUE.parse::<U256>().unwrap(),
    }
}

const ALL: [&str; 4] = ["bee-cac", "bee-soc", "generated-cac", "generated-soc"];

#[test]
fn accepts_what_redistribution_accepted() {
    for name in ALL {
        let v = load(name);
        assert_eq!(verify_claim(&v.witness, &ctx(&v)), Ok(()), "{}", v.name);
    }
}

#[test]
fn soc_vectors_exercise_the_soc_path() {
    for name in ["bee-soc", "generated-soc"] {
        let v = load(name);
        assert!(!v.witness.proofLast.socProof.is_empty(), "{name}");
    }
}

#[test]
fn rejects_the_same_vectors_when_tampered() {
    for name in ALL {
        let v = load(name);

        let mut w = v.witness.clone();
        let mut sig = w.proof1.postageProof.signature.to_vec();
        sig[10] ^= 1;
        w.proof1.postageProof.signature = sig.into();
        assert!(
            verify_claim(&w, &ctx(&v)).is_err(),
            "{name}: stamp signature"
        );

        let mut wrong_seed = ctx(&v);
        wrong_seed.seed = B256::from(U256::from_be_bytes(v.seed.0) + U256::from(1u8));
        assert!(
            verify_claim(&v.witness, &wrong_seed).is_err(),
            "{name}: other seed"
        );

        let mut wrong_anchor = ctx(&v);
        wrong_anchor.anchor = B256::repeat_byte(7);
        assert!(
            verify_claim(&v.witness, &wrong_anchor).is_err(),
            "{name}: other anchor"
        );

        let mut wrong_hash = ctx(&v);
        wrong_hash.sample_hash = B256::repeat_byte(1);
        assert_eq!(
            verify_claim(&v.witness, &wrong_hash),
            Err(ClaimError::InclusionProofFailed(1)),
            "{name}"
        );

        if let Some(soc) = v.witness.proofLast.socProof.first() {
            let mut w = v.witness.clone();
            let mut sig = soc.signature.to_vec();
            sig[5] ^= 1;
            w.proofLast.socProof[0].signature = sig.into();
            assert_eq!(
                verify_claim(&w, &ctx(&v)),
                Err(ClaimError::SocVerificationFailed),
                "{name}"
            );
        }
    }
}
