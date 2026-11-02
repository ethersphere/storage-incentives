//! Postage accounting in the proof: what `PostageStamp.expireLimited` and its batch tree did on chain.
//!
//! `PostageStampZK` keeps no tree. It appends every change that affects the pot (batch created, topped
//! up, deepened, price changed) to an event log. Each settlement replays the new log entries up to a cut
//! block, credits the pot for every batch up to its expiry, and drops expired batches. The batch set is
//! carried between settlements as `PostageState`; Settlement stores only its hash.
//!
//! A batch with `normalisedBalance` n, size 2^depth and "counted to" outpayment c has paid the network
//! size * (min(n, now) - c) since c. That is the same amount `expireLimited` credits: the per-batch term
//! when it expires plus `validChunkCount * Δoutpayment` while it lives. See docs/ZK-SETTLEMENT.md,
//! "Postage accounting in the proof".

use alloy_primitives::{keccak256, Address, B256, U256};
use alloy_sol_types::{sol, SolValue};
use serde::{Deserialize, Serialize};

pub const KIND_CREATE: u8 = 1;
pub const KIND_TOPUP: u8 = 2;
pub const KIND_DEPTH: u8 = 3;
pub const KIND_PRICE: u8 = 4;

sol! {
    /// Hashed form of the carried state. `PostageState::hash` encodes this.
    struct BatchStateSol {
        bytes32 id;
        address owner;
        uint8 depth;
        uint8 bucketDepth;
        uint256 normalisedBalance;
        uint256 countedTo;
    }

    struct PostageStateSol {
        uint64 lastCutBlock;
        uint64 priceBlock;
        uint256 priceOutpayment;
        uint256 price;
        BatchStateSol[] batches;
    }
}

/// A live batch as the proof tracks it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchState {
    pub id: B256,
    pub owner: Address,
    pub depth: u8,
    pub bucket_depth: u8,
    pub normalised_balance: U256,
    /// Outpayment up to which this batch's payment is already in the pot.
    pub counted_to: U256,
}

/// Postage state carried from one settlement to the next.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PostageState {
    /// Cut block of the last settlement.
    pub last_cut_block: u64,
    /// Last price change: block, outpayment at that block, price from that block on.
    pub price_block: u64,
    pub price_outpayment: U256,
    pub price: U256,
    /// Live batches, sorted by id.
    pub batches: Vec<BatchState>,
}

impl PostageState {
    /// Settlement stores this. The empty genesis state hashes to zero.
    pub fn hash(&self) -> B256 {
        if *self == PostageState::default() {
            return B256::ZERO;
        }
        let sol = PostageStateSol {
            lastCutBlock: self.last_cut_block,
            priceBlock: self.price_block,
            priceOutpayment: self.price_outpayment,
            price: self.price,
            batches: self
                .batches
                .iter()
                .map(|b| BatchStateSol {
                    id: b.id,
                    owner: b.owner,
                    depth: b.depth,
                    bucketDepth: b.bucket_depth,
                    normalisedBalance: b.normalised_balance,
                    countedTo: b.counted_to,
                })
                .collect(),
        };
        keccak256(SolValue::abi_encode(&sol))
    }

    /// `PostageStamp.currentTotalOutPayment()` at `block`, from the last price change. Valid for blocks
    /// at or after `price_block`.
    pub fn outpayment_at(&self, block: u64) -> Result<U256, PostageError> {
        let blocks = block
            .checked_sub(self.price_block)
            .ok_or(PostageError::BlockBeforePrice)?;
        self.price
            .checked_mul(U256::from(blocks))
            .and_then(|x| x.checked_add(self.price_outpayment))
            .ok_or(PostageError::Overflow)
    }

    pub fn batch(&self, id: &B256) -> Option<&BatchState> {
        self.batches
            .binary_search_by(|b| b.id.cmp(id))
            .ok()
            .map(|i| &self.batches[i])
    }
}

/// One `PostageLog` entry of PostageStampZK.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PostageEvent {
    pub index: u64,
    pub kind: u8,
    pub batch_id: B256,
    pub owner: Address,
    pub depth: u8,
    pub bucket_depth: u8,
    /// New normalisedBalance, or the new price for KIND_PRICE.
    pub value: U256,
    /// currentTotalOutPayment() after the change.
    pub outpayment: U256,
    pub block: u64,
}

/// The log hash chain of PostageStampZK._log.
pub fn event_hash(prev: B256, e: &PostageEvent) -> B256 {
    let mut buf = Vec::with_capacity(32 + 1 + 32 + 20 + 1 + 1 + 32 + 32 + 8);
    buf.extend_from_slice(prev.as_slice());
    buf.push(e.kind);
    buf.extend_from_slice(e.batch_id.as_slice());
    buf.extend_from_slice(e.owner.as_slice());
    buf.push(e.depth);
    buf.push(e.bucket_depth);
    buf.extend_from_slice(&e.value.to_be_bytes::<32>());
    buf.extend_from_slice(&e.outpayment.to_be_bytes::<32>());
    buf.extend_from_slice(&e.block.to_be_bytes());
    keccak256(buf)
}

/// Everything the proof needs for postage in one settlement.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PostageInput {
    /// State after the previous settlement; its hash must equal Settlement.postageStateHash.
    pub state: PostageState,
    /// Log position after the previous settlement (Settlement.postageEventIndex / postageEventHash).
    pub prev_event_index: u64,
    pub prev_event_hash: B256,
    /// Log entries prev_event_index+1 ..= the last entry with block <= cut_block, in order.
    pub events: Vec<PostageEvent>,
    /// Every entry up to this block is applied; the pot is credited up to the outpayment at this block.
    pub cut_block: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PostageError {
    /// Events are not consecutive, or after the cut block.
    EventOrder,
    /// An event's outpayment does not follow from the last price change.
    OutpaymentMismatch,
    /// The cut block is before the last cut or before an event.
    BadCut,
    BlockBeforePrice,
    BatchExists,
    UnknownBatch,
    UnknownKind,
    Overflow,
}

/// Result of replaying a settlement's postage events.
pub struct PostageRun {
    /// State after all events, before the final expiry. The claim reads batches from here.
    pub before_cut: PostageState,
    /// Outpayment at the probe block (the round's seed block): a batch is alive for the claim when its
    /// normalisedBalance is above this. If a price change after the probe was already applied by the
    /// previous settlement, this is the outpayment at that change (the earliest point still known).
    pub outpayment_at_probe: U256,
    pub new_state: PostageState,
    pub event_index: u64,
    pub event_hash: B256,
    /// Pot earned in this settlement.
    pub pot: U256,
    /// Chunks of live batches after the cut (PostageStamp.validChunkCount).
    pub valid_chunk_count: U256,
}

fn size(depth: u8) -> Result<U256, PostageError> {
    U256::from(1u8)
        .checked_shl(depth as usize)
        .ok_or(PostageError::Overflow)
}

/// Credit `b` up to outpayment `to` (never past its own expiry) and move its counter.
fn accrue(b: &mut BatchState, to: U256, pot: &mut U256) -> Result<(), PostageError> {
    let end = b.normalised_balance.min(to);
    if end > b.counted_to {
        let paid = size(b.depth)?
            .checked_mul(end - b.counted_to)
            .ok_or(PostageError::Overflow)?;
        *pot = pot.checked_add(paid).ok_or(PostageError::Overflow)?;
    }
    if to > b.counted_to {
        b.counted_to = to;
    }
    Ok(())
}

/// Replay the events, credit the pot up to the cut block and drop the batches that expired.
pub fn apply(input: &PostageInput, probe_block: u64) -> Result<PostageRun, PostageError> {
    let mut s = input.state.clone();
    let mut probe = if probe_block < s.price_block {
        Some(s.price_outpayment)
    } else {
        None
    };
    let mut pot = U256::ZERO;
    let mut hash = input.prev_event_hash;
    let mut index = input.prev_event_index;

    if input.cut_block < s.last_cut_block {
        return Err(PostageError::BadCut);
    }

    for e in &input.events {
        if e.index != index + 1 || e.block > input.cut_block || e.block < s.last_cut_block {
            return Err(PostageError::EventOrder);
        }
        if probe.is_none() && e.block > probe_block {
            probe = Some(s.outpayment_at(probe_block)?);
        }
        if e.outpayment != s.outpayment_at(e.block)? {
            return Err(PostageError::OutpaymentMismatch);
        }
        match e.kind {
            KIND_PRICE => {
                s.price_block = e.block;
                s.price_outpayment = e.outpayment;
                s.price = e.value;
            }
            KIND_CREATE => {
                let at = match s.batches.binary_search_by(|b| b.id.cmp(&e.batch_id)) {
                    Ok(_) => return Err(PostageError::BatchExists),
                    Err(at) => at,
                };
                s.batches.insert(
                    at,
                    BatchState {
                        id: e.batch_id,
                        owner: e.owner,
                        depth: e.depth,
                        bucket_depth: e.bucket_depth,
                        normalised_balance: e.value,
                        counted_to: e.outpayment,
                    },
                );
            }
            KIND_TOPUP | KIND_DEPTH => {
                let i = s
                    .batches
                    .binary_search_by(|b| b.id.cmp(&e.batch_id))
                    .map_err(|_| PostageError::UnknownBatch)?;
                let b = &mut s.batches[i];
                // Credit at the old size and balance up to this moment, then apply the change.
                accrue(b, e.outpayment, &mut pot)?;
                b.normalised_balance = e.value;
                b.depth = e.depth;
            }
            _ => return Err(PostageError::UnknownKind),
        }
        hash = event_hash(hash, e);
        index = e.index;
    }

    let before_cut = s.clone();
    let outpayment_at_probe = match probe {
        Some(p) => p,
        None => s.outpayment_at(probe_block)?,
    };

    let cut = s.outpayment_at(input.cut_block)?;
    for b in s.batches.iter_mut() {
        accrue(b, cut, &mut pot)?;
    }
    s.batches.retain(|b| b.normalised_balance > cut);
    s.last_cut_block = input.cut_block;

    let mut valid = U256::ZERO;
    for b in &s.batches {
        valid = valid
            .checked_add(size(b.depth)?)
            .ok_or(PostageError::Overflow)?;
    }

    Ok(PostageRun {
        before_cut,
        outpayment_at_probe,
        new_state: s,
        event_index: index,
        event_hash: hash,
        pot,
        valid_chunk_count: valid,
    })
}
