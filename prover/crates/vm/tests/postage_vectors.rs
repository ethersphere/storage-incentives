//! Differential test: replaying PostageStampZK's event log must give the same pot and validChunkCount as
//! master's PostageStamp (tree + expireLimited) at every checkpoint. Both contracts ran the same random
//! history in the same blocks (test/PostageStampZK.test.ts). Regenerate with:
//!
//!   DUMP_POSTAGE_VECTORS=1 npx hardhat test test/PostageStampZK.test.ts

use alloy_primitives::{Address, B256, U256};
use swarm_vm::postage::{apply, PostageEvent, PostageInput, PostageState};

fn load(seed: u32) -> (Vec<PostageEvent>, Vec<(u64, U256, U256)>) {
    let path = format!(
        "{}/tests/vectors/postage-{seed}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let u = |x: &serde_json::Value| x.as_str().unwrap().parse::<U256>().unwrap();
    let events = v["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| PostageEvent {
            index: e["index"].as_u64().unwrap(),
            kind: e["kind"].as_u64().unwrap() as u8,
            batch_id: e["batchId"].as_str().unwrap().parse::<B256>().unwrap(),
            owner: e["owner"].as_str().unwrap().parse::<Address>().unwrap(),
            depth: e["depth"].as_u64().unwrap() as u8,
            bucket_depth: e["bucketDepth"].as_u64().unwrap() as u8,
            value: u(&e["value"]),
            outpayment: u(&e["outpayment"]),
            block: e["blockNumber"].as_u64().unwrap(),
        })
        .collect();
    let checkpoints = v["checkpoints"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["block"].as_u64().unwrap(),
                u(&c["pot"]),
                u(&c["validChunkCount"]),
            )
        })
        .collect();
    (events, checkpoints)
}

#[test]
fn replay_matches_master_postage_stamp() {
    for seed in [1, 2, 3] {
        let (events, checkpoints) = load(seed);
        let mut state = PostageState::default();
        let mut prev = (0u64, B256::ZERO);
        let mut total = U256::ZERO;

        for (cut, master_pot, master_valid) in checkpoints {
            let input = PostageInput {
                state,
                prev_event_index: prev.0,
                prev_event_hash: prev.1,
                events: events
                    .iter()
                    .filter(|e| e.index > prev.0 && e.block <= cut)
                    .cloned()
                    .collect(),
                cut_block: cut,
            };
            let r = apply(&input, cut).unwrap_or_else(|e| panic!("seed {seed}, cut {cut}: {e:?}"));
            total += r.pot;
            assert_eq!(total, master_pot, "seed {seed}: pot at block {cut}");
            assert_eq!(
                r.valid_chunk_count, master_valid,
                "seed {seed}: validChunkCount at block {cut}"
            );
            prev = (r.event_index, r.event_hash);
            state = r.new_state;
        }
    }
}

#[test]
fn one_settlement_or_many_gives_the_same_pot() {
    for seed in [1, 2, 3] {
        let (events, checkpoints) = load(seed);
        let (last_cut, master_pot, _) = *checkpoints.last().unwrap();
        let input = PostageInput {
            state: PostageState::default(),
            prev_event_index: 0,
            prev_event_hash: B256::ZERO,
            events: events
                .iter()
                .filter(|e| e.block <= last_cut)
                .cloned()
                .collect(),
            cut_block: last_cut,
        };
        assert_eq!(
            apply(&input, last_cut).unwrap().pot,
            master_pot,
            "seed {seed}"
        );
    }
}
