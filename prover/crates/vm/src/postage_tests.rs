use crate::postage::*;
use alloy_primitives::{keccak256, Address, B256, U256};

/// A small log builder that keeps the outpayment the way PostageStampZK computes it.
struct Log {
    events: Vec<PostageEvent>,
    price: U256,
    price_block: u64,
    price_outpayment: U256,
}

impl Log {
    fn new() -> Self {
        Log {
            events: vec![],
            price: U256::ZERO,
            price_block: 0,
            price_outpayment: U256::ZERO,
        }
    }

    fn outpayment(&self, block: u64) -> U256 {
        self.price_outpayment + self.price * U256::from(block - self.price_block)
    }

    fn push(&mut self, kind: u8, id: u8, depth: u8, value: U256, block: u64) -> U256 {
        let outpayment = self.outpayment(block);
        if kind == KIND_PRICE {
            self.price_outpayment = outpayment;
            self.price_block = block;
            self.price = value;
        }
        self.events.push(PostageEvent {
            index: self.events.len() as u64 + 1,
            kind,
            batch_id: if kind == KIND_PRICE {
                B256::ZERO
            } else {
                keccak256([id])
            },
            owner: if kind == KIND_PRICE {
                Address::ZERO
            } else {
                Address::repeat_byte(id)
            },
            depth,
            bucket_depth: if kind == KIND_PRICE { 0 } else { 16 },
            value,
            outpayment,
            block,
        });
        outpayment
    }

    fn price(&mut self, price: u64, block: u64) {
        self.push(KIND_PRICE, 0, 0, U256::from(price), block);
    }

    /// Create batch `id` with `per_chunk` balance: normalisedBalance = outpayment + per_chunk.
    fn create(&mut self, id: u8, depth: u8, per_chunk: u64, block: u64) {
        let n = self.outpayment(block) + U256::from(per_chunk);
        self.push(KIND_CREATE, id, depth, n, block);
    }
}

fn settle(state: PostageState, prev: (u64, B256), events: &[PostageEvent], cut: u64) -> PostageRun {
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
    apply(&input, cut).unwrap()
}

#[test]
fn a_batch_pays_its_whole_balance_then_expires() {
    let mut log = Log::new();
    log.price(2, 10);
    log.create(1, 17, 100, 20); // outpayment 20, normalisedBalance 120, expires at block 60

    let r1 = settle(PostageState::default(), (0, B256::ZERO), &log.events, 40);
    // 2^17 chunks * (outpayment 60 at block 40 - 20)
    assert_eq!(r1.pot, U256::from(40u64 << 17));
    assert_eq!(r1.valid_chunk_count, U256::from(1u64 << 17));
    assert_eq!(r1.new_state.batches.len(), 1);

    let r2 = settle(
        r1.new_state,
        (r1.event_index, r1.event_hash),
        &log.events,
        100,
    );
    // The rest of its balance: 120 - 60. Not more, although the cut is past its expiry.
    assert_eq!(r2.pot, U256::from(60u64 << 17));
    assert!(r2.new_state.batches.is_empty());
    assert_eq!(r2.valid_chunk_count, U256::ZERO);
}

#[test]
fn the_split_of_settlements_does_not_change_the_total() {
    let mut log = Log::new();
    log.price(3, 5);
    log.create(1, 17, 300, 10);
    log.create(2, 18, 90, 12);
    log.price(5, 30);
    let n = log.outpayment(35) + U256::from(500u64);
    log.push(KIND_TOPUP, 1, 17, n + U256::from(0u8), 35); // top-up recorded with its new balance
    log.create(3, 17, 1000, 50);

    let all = settle(PostageState::default(), (0, B256::ZERO), &log.events, 400);
    let mut state = PostageState::default();
    let mut prev = (0, B256::ZERO);
    let mut total = U256::ZERO;
    for cut in [11, 29, 36, 120, 400] {
        let r = settle(state, prev, &log.events, cut);
        total += r.pot;
        prev = (r.event_index, r.event_hash);
        state = r.new_state;
    }
    assert_eq!(total, all.pot);
    assert_eq!(state.hash(), all.new_state.hash());
}

#[test]
fn depth_increase_counts_old_size_before_and_new_size_after() {
    let mut log = Log::new();
    log.price(1, 1);
    log.create(1, 17, 1000, 10); // outpayment 9, balance 1009
                                 // At block 20 (outpayment 19): remaining 990, halved to 495 for depth 18.
    let n = log.outpayment(20) + U256::from(495u64);
    log.push(KIND_DEPTH, 1, 18, n, 20);
    let r = settle(PostageState::default(), (0, B256::ZERO), &log.events, 30);
    // 10 blocks at 2^17, then 10 blocks at 2^18.
    assert_eq!(r.pot, U256::from((10u64 << 17) + (10u64 << 18)));
}

#[test]
fn a_price_change_between_settlements_is_followed() {
    let mut log = Log::new();
    log.price(1, 1);
    log.create(1, 17, 10_000, 10);
    log.price(4, 20);
    let r = settle(PostageState::default(), (0, B256::ZERO), &log.events, 30);
    // outpayment 9 -> 19 at price 1, then 10 blocks at price 4: 59.
    assert_eq!(r.pot, U256::from(50u64 << 17));
}

#[test]
fn event_chain_matches_the_contract_rule() {
    let mut log = Log::new();
    log.price(1, 1);
    log.create(1, 17, 10, 2);
    let r = settle(PostageState::default(), (0, B256::ZERO), &log.events, 3);
    let h1 = event_hash(B256::ZERO, &log.events[0]);
    assert_eq!(r.event_hash, event_hash(h1, &log.events[1]));
    assert_eq!(r.event_index, 2);
}

#[test]
fn bad_logs_are_rejected() {
    let mut log = Log::new();
    log.price(1, 1);
    log.create(1, 17, 10, 2);
    let input = |events: Vec<PostageEvent>, cut| PostageInput {
        state: PostageState::default(),
        prev_event_index: 0,
        prev_event_hash: B256::ZERO,
        events,
        cut_block: cut,
    };

    // Skipped entry.
    assert_eq!(
        apply(&input(vec![log.events[1].clone()], 5), 5).err(),
        Some(PostageError::EventOrder)
    );
    // Entry after the cut.
    assert_eq!(
        apply(&input(log.events.clone(), 1), 1).err(),
        Some(PostageError::EventOrder)
    );
    // Outpayment that does not follow from the price.
    let mut bad = log.events.clone();
    bad[1].outpayment += U256::from(1u8);
    assert_eq!(
        apply(&input(bad, 5), 5).err(),
        Some(PostageError::OutpaymentMismatch)
    );
    // The same batch twice.
    let mut twice = log.events.clone();
    let mut again = twice[1].clone();
    again.index = 3;
    twice.push(again);
    assert_eq!(
        apply(&input(twice, 5), 5).err(),
        Some(PostageError::BatchExists)
    );
    // Top-up of a batch the state does not know.
    let mut unknown = log.events.clone();
    unknown[1].kind = KIND_TOPUP;
    assert_eq!(
        apply(&input(unknown, 5), 5).err(),
        Some(PostageError::UnknownBatch)
    );
}

#[test]
fn genesis_state_hashes_to_zero() {
    assert_eq!(PostageState::default().hash(), B256::ZERO);
    let s = PostageState {
        price: U256::from(1u8),
        ..Default::default()
    };
    assert_ne!(s.hash(), B256::ZERO);
}

#[test]
fn probe_uses_the_outpayment_at_the_seed_block() {
    let mut log = Log::new();
    log.price(1, 1);
    log.create(1, 17, 10, 5);
    log.price(10, 50);
    let input = PostageInput {
        state: PostageState::default(),
        prev_event_index: 0,
        prev_event_hash: B256::ZERO,
        events: log.events.clone(),
        cut_block: 60,
    };
    // Before the price change at block 50: price 1 since block 1.
    assert_eq!(
        apply(&input, 40).unwrap().outpayment_at_probe,
        U256::from(39u8)
    );
    // After it: 49 at block 50, then price 10.
    assert_eq!(
        apply(&input, 55).unwrap().outpayment_at_probe,
        U256::from(99u8)
    );
}
