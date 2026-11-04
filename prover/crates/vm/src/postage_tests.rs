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
                id_of(id)
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

fn id_of(id: u8) -> B256 {
    keccak256([id])
}

/// Run a settlement on the prover's tree, then the same settlement in zkVM mode from the recorded
/// witness. Both must give the same result. Returns the run and the new prover state.
fn settle_with(
    state: &PostageState,
    prev: (u64, B256),
    events: &[PostageEvent],
    cut: u64,
    probe: u64,
    claims: &[B256],
) -> Result<(PostageRun, PostageState), PostageError> {
    let mut next = state.clone();
    let events: Vec<_> = events
        .iter()
        .filter(|e| e.index > prev.0 && e.block <= cut)
        .cloned()
        .collect();
    let (host, input) = next.settle(prev.0, prev.1, events, cut, probe, claims, true)?;
    let input = input.unwrap();
    assert_eq!(input.header.hash(), state.hash());
    let guest = verify(&input, probe, claims).expect("zkVM mode rejects the prover's witness");
    assert_eq!(guest.pot, host.pot);
    assert_eq!(guest.new_header, host.new_header);
    assert_eq!(guest.claims, host.claims);
    assert_eq!(guest.outpayment_at_probe, host.outpayment_at_probe);
    assert_eq!(next.header.root, {
        let mut t = next.tree.clone();
        BatchTree::root(&mut t)
    });
    Ok((host, next))
}

fn settle(
    state: &PostageState,
    prev: (u64, B256),
    events: &[PostageEvent],
    cut: u64,
) -> (PostageRun, PostageState) {
    settle_with(state, prev, events, cut, cut, &[]).unwrap()
}

fn genesis() -> PostageState {
    PostageState::default()
}

#[test]
fn a_batch_pays_its_whole_balance_then_expires() {
    let mut log = Log::new();
    log.price(2, 10);
    log.create(1, 17, 100, 20); // outpayment 20, normalisedBalance 120, expires at block 60

    let (r1, s1) = settle(&genesis(), (0, B256::ZERO), &log.events, 40);
    // 2^17 chunks * (outpayment 60 at block 40 - 20)
    assert_eq!(r1.pot, U256::from(40u64 << 17));
    assert_eq!(r1.valid_chunk_count, U256::from(1u64 << 17));
    assert_eq!(s1.batches().len(), 1);

    let (r2, s2) = settle(&s1, (r1.event_index, r1.event_hash), &log.events, 100);
    // The rest of its balance: 120 - 60. Not more, although the cut is past its expiry.
    assert_eq!(r2.pot, U256::from(60u64 << 17));
    assert!(s2.batches().is_empty());
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
    log.push(KIND_TOPUP, 1, 17, n, 35); // top-up recorded with its new balance
    log.create(3, 17, 1000, 50);

    let (all, all_state) = settle(&genesis(), (0, B256::ZERO), &log.events, 400);
    let mut state = genesis();
    let mut prev = (0, B256::ZERO);
    let mut total = U256::ZERO;
    for cut in [11, 29, 36, 120, 400] {
        let (r, s) = settle(&state, prev, &log.events, cut);
        total += r.pot;
        prev = (r.event_index, r.event_hash);
        state = s;
    }
    assert_eq!(total, all.pot);
    // The same batches remain; the trees differ only by where leaves were freed.
    assert_eq!(state.batches(), all_state.batches());
    assert_eq!(state.header.live_chunks, all_state.header.live_chunks);
}

#[test]
fn depth_increase_counts_old_size_before_and_new_size_after() {
    let mut log = Log::new();
    log.price(1, 1);
    log.create(1, 17, 1000, 10); // outpayment 9, balance 1009
                                 // At block 20 (outpayment 19): remaining 990, halved to 495 for depth 18.
    let n = log.outpayment(20) + U256::from(495u64);
    log.push(KIND_DEPTH, 1, 18, n, 20);
    let (r, s) = settle(&genesis(), (0, B256::ZERO), &log.events, 30);
    // 10 blocks at 2^17, then 10 blocks at 2^18.
    assert_eq!(r.pot, U256::from((10u64 << 17) + (10u64 << 18)));
    assert_eq!(s.batches()[0].depth, 18);
    assert_eq!(r.valid_chunk_count, U256::from(1u64 << 18));
}

#[test]
fn a_price_change_between_settlements_is_followed() {
    let mut log = Log::new();
    log.price(1, 1);
    log.create(1, 17, 10_000, 10);
    log.price(4, 20);
    let (r, _) = settle(&genesis(), (0, B256::ZERO), &log.events, 30);
    // outpayment 9 -> 19 at price 1, then 10 blocks at price 4: 59.
    assert_eq!(r.pot, U256::from(50u64 << 17));
}

#[test]
fn expiry_follows_the_balance_order_not_the_creation_order() {
    let mut log = Log::new();
    log.price(1, 1);
    log.create(1, 17, 100, 10); // expires at outpayment 109
    log.create(2, 17, 20, 11); // 30
    log.create(3, 17, 50, 12); // 61
    log.create(4, 17, 1000, 13); // 1012
    let (r1, s1) = settle(&genesis(), (0, B256::ZERO), &log.events, 13);
    assert_eq!(s1.batches().len(), 4);
    // Outpayment 69 at block 70: batches 2 and 3 have expired, 1 and 4 remain.
    let (r2, s2) = settle(&s1, (r1.event_index, r1.event_hash), &log.events, 70);
    let ids: Vec<B256> = s2.batches().iter().map(|b| b.id).collect();
    let mut want = vec![id_of(1), id_of(4)];
    want.sort();
    assert_eq!(ids, want);
    // From outpayment 12 to 69 for 1 and 4; 2 paid to 30 and 3 to 61.
    let paid = 2 * (69 - 12) + (30 - 12) + (61 - 12);
    assert_eq!(r2.pot, U256::from(paid as u64) << 17);
}

#[test]
fn event_chain_matches_the_contract_rule() {
    let mut log = Log::new();
    log.price(1, 1);
    log.create(1, 17, 10, 2);
    let (r, _) = settle(&genesis(), (0, B256::ZERO), &log.events, 3);
    let h1 = event_hash(B256::ZERO, &log.events[0]);
    assert_eq!(r.event_hash, event_hash(h1, &log.events[1]));
    assert_eq!(r.event_index, 2);
}

#[test]
fn bad_logs_are_rejected() {
    let mut log = Log::new();
    log.price(1, 1);
    log.create(1, 17, 10, 2);
    let run = |events: Vec<PostageEvent>, cut| {
        genesis()
            .settle(0, B256::ZERO, events, cut, cut, &[], false)
            .err()
    };

    // Skipped entry.
    assert_eq!(
        run(vec![log.events[1].clone()], 5),
        Some(PostageError::EventOrder)
    );
    // Entry after the cut.
    assert_eq!(run(log.events.clone(), 1), Some(PostageError::EventOrder));
    // Outpayment that does not follow from the price.
    let mut bad = log.events.clone();
    bad[1].outpayment += U256::from(1u8);
    assert_eq!(run(bad, 5), Some(PostageError::OutpaymentMismatch));
    // The same batch twice.
    let mut twice = log.events.clone();
    let mut again = twice[1].clone();
    again.index = 3;
    twice.push(again);
    assert_eq!(run(twice, 5), Some(PostageError::BatchExists));
    // Top-up of a batch the state does not know.
    let mut unknown = log.events.clone();
    unknown[1].kind = KIND_TOPUP;
    assert_eq!(run(unknown, 5), Some(PostageError::UnknownBatch));
}

#[test]
fn genesis_state_hashes_to_zero() {
    assert_eq!(PostageHeader::default().hash(), B256::ZERO);
    let h = PostageHeader {
        price: U256::from(1u8),
        ..Default::default()
    };
    assert_ne!(h.hash(), B256::ZERO);
}

#[test]
fn probe_uses_the_outpayment_at_the_seed_block() {
    let mut log = Log::new();
    log.price(1, 1);
    log.create(1, 17, 10, 5);
    log.price(10, 50);
    let at = |probe| {
        settle_with(&genesis(), (0, B256::ZERO), &log.events, 60, probe, &[])
            .unwrap()
            .0
            .outpayment_at_probe
    };
    // Before the price change at block 50: price 1 since block 1.
    assert_eq!(at(40), U256::from(39u8));
    // After it: 49 at block 50, then price 10.
    assert_eq!(at(55), U256::from(99u8));
}

/// Three batches alive after a first settlement.
fn three_batches() -> (Log, PostageState, (u64, B256)) {
    let mut log = Log::new();
    log.price(1, 1);
    log.create(1, 17, 1000, 10);
    log.create(2, 18, 2000, 11);
    log.create(3, 19, 3000, 12);
    let (r, s) = settle(&genesis(), (0, B256::ZERO), &log.events, 20);
    (log, s, (r.event_index, r.event_hash))
}

#[test]
fn a_claim_reads_present_and_absent_batches_with_proofs() {
    let (log, s, prev) = three_batches();
    let absent = id_of(9);
    let (r, _) = settle_with(&s, prev, &log.events, 30, 25, &[id_of(2), absent]).unwrap();
    let found = r.claims[0].leaf.as_ref().unwrap();
    assert_eq!(
        (found.id, found.depth, found.owner),
        (id_of(2), 18, Address::repeat_byte(2))
    );
    assert_eq!(
        r.claims[1],
        ClaimBatch {
            id: absent,
            leaf: None
        }
    );
}

/// A prover's tree that lies: it says a present batch is not there.
struct HideBatch {
    inner: FullTree,
    hide: B256,
}

impl BatchTree for HideBatch {
    fn read(&mut self, index: u64) -> Result<Leaf, PostageError> {
        self.inner.read(index)
    }
    fn write(
        &mut self,
        index: u64,
        f: impl FnOnce(&Leaf) -> Result<Leaf, PostageError>,
    ) -> Result<(), PostageError> {
        self.inner.write(index, f)
    }
    fn hint(&mut self, q: Query) -> Result<u64, PostageError> {
        let v = self.inner.hint(q)?;
        if matches!(q, Query::Find(id) if id == self.hide) {
            let r = self.inner.record.as_mut().unwrap();
            *r.hints.last_mut().unwrap() = NOT_FOUND;
            return Ok(NOT_FOUND);
        }
        Ok(v)
    }
    fn root(&mut self) -> B256 {
        self.inner.root()
    }
}

#[test]
fn a_prover_cannot_hide_a_batch_from_a_claim() {
    let (log, s, prev) = three_batches();
    let mut liar = HideBatch {
        inner: s.tree.clone(),
        hide: id_of(2),
    };
    liar.inner.record = Some(PostageWitness::default());
    let claims = [id_of(2)];
    // The shared algorithm checks every answer, so the lying prover cannot even finish its own run...
    let lie = apply(&mut liar, &s.header, prev.0, prev.1, &[], 30, 25, &claims);
    assert_eq!(lie.err(), Some(PostageError::BadHint));
    // ...and the zkVM rejects the witness it recorded: the predecessor in the id list points at the batch.
    let input = PostageInput {
        header: s.header.clone(),
        prev_event_index: prev.0,
        prev_event_hash: prev.1,
        events: vec![],
        cut_block: 30,
        witness: liar.inner.record.take().unwrap(),
    };
    assert_eq!(
        verify(&input, 25, &claims).err(),
        Some(PostageError::BadHint)
    );
    let _ = log;
}

#[test]
fn a_changed_witness_is_rejected() {
    let (log, s, prev) = three_batches();
    let mut next = s.clone();
    let (_, input) = next
        .settle(
            prev.0,
            prev.1,
            log.events[4..].to_vec(),
            30,
            25,
            &[id_of(1)],
            true,
        )
        .unwrap();
    let input = input.unwrap();
    assert!(verify(&input, 25, &[id_of(1)]).is_ok());

    // A leaf with another balance (the claim would see another expiry).
    let mut bad = input.clone();
    let p = bad
        .witness
        .proofs
        .iter_mut()
        .find(|p| p.leaf.id == id_of(1))
        .unwrap();
    p.leaf.balance += U256::from(1u8);
    assert_eq!(
        verify(&bad, 25, &[id_of(1)]).err(),
        Some(PostageError::BadWitness)
    );

    // A wrong sibling.
    let mut bad = input.clone();
    bad.witness.proofs[0].siblings[3] = keccak256(b"x");
    assert_eq!(
        verify(&bad, 25, &[id_of(1)]).err(),
        Some(PostageError::BadWitness)
    );

    // An extra proof at the end.
    let mut bad = input.clone();
    let extra = bad.witness.proofs[0].clone();
    bad.witness.proofs.push(extra);
    assert_eq!(
        verify(&bad, 25, &[id_of(1)]).err(),
        Some(PostageError::WitnessTooLong)
    );

    // A different header (for example another price) is another state hash; Settlement rejects it.
    let mut bad = input;
    bad.header.price += U256::from(1u8);
    assert_ne!(bad.header.hash(), s.hash());
}

#[test]
fn a_settlement_touches_only_what_changes() {
    // 2,000 batches, then one round with one top-up: the witness has a few proofs, not 2,000.
    let mut log = Log::new();
    log.price(1, 1);
    let batches: Vec<Leaf> = (0..2000u32)
        .map(|i| Leaf {
            id: keccak256(i.to_be_bytes()),
            owner: Address::repeat_byte(7),
            depth: 20,
            bucket_depth: 16,
            balance: U256::from(1_000_000u64 + i as u64),
            ..Default::default()
        })
        .collect();
    let s = PostageState::from_batches(100, 1, U256::ZERO, U256::from(1u8), &batches).unwrap();
    let topup = PostageEvent {
        index: 1,
        kind: KIND_TOPUP,
        batch_id: batches[5].id,
        owner: batches[5].owner,
        depth: 20,
        bucket_depth: 16,
        value: U256::from(5_000_000u64),
        outpayment: U256::from(109u64),
        block: 110,
    };
    let mut next = s.clone();
    let (r, input) = next
        .settle(0, B256::ZERO, vec![topup], 164, 150, &[], true)
        .unwrap();
    let input = input.unwrap();
    assert!(
        input.witness.proofs.len() < 12,
        "{} proofs",
        input.witness.proofs.len()
    );
    assert_eq!(r.valid_chunk_count, U256::from(2000u64 << 20));
    let guest = verify(&input, 150, &[]).unwrap();
    assert_eq!(guest.new_header, r.new_header);
    assert_eq!(
        next.batch(&batches[5].id).unwrap().balance,
        U256::from(5_000_000u64)
    );
}
