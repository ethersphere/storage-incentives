//! Postage accounting in the proof: what `PostageStamp.expireLimited` and its batch tree did on chain.
//!
//! `PostageStampZK` keeps no tree. It appends every change that affects the pot (batch created, topped
//! up, deepened, price changed) to an event log. Each settlement replays the new log entries up to a cut
//! block, credits the pot, and drops the batches that expired. Settlement stores only the hash of the
//! carried state (`PostageHeader::hash`).
//!
//! The live batches are the leaves of a Merkle tree (an "indexed Merkle tree"). Each leaf is in two
//! sorted linked lists at the same time: by batch id, and by (normalisedBalance, id), which is expiry
//! order. The header holds only the root. A settlement touches only the leaves that change: the batches
//! of its events, the batches that expire (always at the front of the expiry list), and the batches a
//! claim reads. The id list lets the proof show that a batch does not exist.
//!
//! The same algorithm (`apply`) runs on two trees: `FullTree` in the prover, which has every leaf and
//! records a Merkle proof for each leaf it reads or writes, and `WitnessTree` in the zkVM, which checks
//! those proofs against the root and updates the root. A prover cannot answer differently from the tree:
//! every answer is checked (a leaf by its Merkle proof, a list position by the order of its neighbours).
//!
//! Pot: between two points in the log, every batch in the tree pays size * Δoutpayment. A batch that
//! expires is removed at the cut, and the part it did not pay, size * (outpayment at cut - its
//! normalisedBalance), is taken back. This is the same amount `expireLimited` credits. See
//! docs/ZK-SETTLEMENT.md, "Postage accounting in the proof".

use alloy_primitives::{keccak256, Address, B256, U256};
use alloy_sol_types::{sol, SolValue};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const KIND_CREATE: u8 = 1;
pub const KIND_TOPUP: u8 = 2;
pub const KIND_DEPTH: u8 = 3;
pub const KIND_PRICE: u8 = 4;

/// Levels of the batch tree: room for 2^32 leaves. Leaf 0 is the head of both lists.
pub const TREE_DEPTH: usize = 32;
/// Next-index value at the end of a list (leaf 0, the head, is never a successor).
const END: u64 = 0;
/// Hint value for a batch that is not in the tree.
pub const NOT_FOUND: u64 = u64::MAX;

sol! {
    /// Hashed form of the carried header. `PostageHeader::hash` encodes this.
    struct PostageHeaderSol {
        bytes32 root;
        uint64 nextFree;
        uint256 liveChunks;
        uint64 lastCutBlock;
        uint64 priceBlock;
        uint256 priceOutpayment;
        uint256 price;
    }
}

/// The postage state Settlement carries from one settlement to the next, by its hash.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PostageHeader {
    /// Root of the batch tree.
    pub root: B256,
    /// Next unused leaf index.
    pub next_free: u64,
    /// Chunks of the batches in the tree (PostageStamp.validChunkCount after a cut).
    pub live_chunks: U256,
    /// Cut block of the last settlement.
    pub last_cut_block: u64,
    /// Last price change: block, outpayment at that block, price from that block on.
    pub price_block: u64,
    pub price_outpayment: U256,
    pub price: U256,
}

impl PostageHeader {
    pub fn is_genesis(&self) -> bool {
        *self == PostageHeader::default()
    }

    /// Settlement stores this. The genesis header (no batches, nothing replayed) hashes to zero.
    pub fn hash(&self) -> B256 {
        if self.is_genesis() {
            return B256::ZERO;
        }
        keccak256(SolValue::abi_encode(&PostageHeaderSol {
            root: self.root,
            nextFree: self.next_free,
            liveChunks: self.live_chunks,
            lastCutBlock: self.last_cut_block,
            priceBlock: self.price_block,
            priceOutpayment: self.price_outpayment,
            price: self.price,
        }))
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
}

/// A leaf of the batch tree: one live batch and its successors in the two lists. The empty leaf (all
/// zero) hashes to zero.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Leaf {
    pub id: B256,
    pub owner: Address,
    pub depth: u8,
    pub bucket_depth: u8,
    /// normalisedBalance: the batch expires when the total outpayment reaches it.
    pub balance: U256,
    /// Next leaf in id order, and its id.
    pub next_id_index: u64,
    pub next_id: B256,
    /// Next leaf in expiry order, and its (balance, id).
    pub next_bal_index: u64,
    pub next_bal: U256,
    pub next_bal_id: B256,
}

impl Leaf {
    /// The head (leaf 0) of two empty lists: its key is the smallest, the end key is the largest.
    fn head() -> Leaf {
        Leaf {
            next_id: B256::repeat_byte(0xff),
            next_bal: U256::MAX,
            next_bal_id: B256::repeat_byte(0xff),
            ..Default::default()
        }
    }

    pub fn is_empty(&self) -> bool {
        *self == Leaf::default()
    }

    pub fn hash(&self) -> B256 {
        if self.is_empty() {
            return B256::ZERO;
        }
        let mut buf = Vec::with_capacity(198);
        buf.extend_from_slice(self.id.as_slice());
        buf.extend_from_slice(self.owner.as_slice());
        buf.push(self.depth);
        buf.push(self.bucket_depth);
        buf.extend_from_slice(&self.balance.to_be_bytes::<32>());
        buf.extend_from_slice(&self.next_id_index.to_be_bytes());
        buf.extend_from_slice(self.next_id.as_slice());
        buf.extend_from_slice(&self.next_bal_index.to_be_bytes());
        buf.extend_from_slice(&self.next_bal.to_be_bytes::<32>());
        buf.extend_from_slice(self.next_bal_id.as_slice());
        keccak256(buf)
    }

    /// Position in the expiry list.
    pub fn key(&self) -> (U256, B256) {
        (self.balance, self.id)
    }

    fn next_key(&self) -> (U256, B256) {
        (self.next_bal, self.next_bal_id)
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

/// A leaf and the sibling hashes from it to the root (leaf level first).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeafProof {
    pub leaf: Leaf,
    pub siblings: Vec<B256>,
}

/// What the prover gives the zkVM about the tree, in the order the algorithm asks for it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PostageWitness {
    /// One proof for each leaf read or written.
    pub proofs: Vec<LeafProof>,
    /// Leaf indices: where a batch is, or which leaf comes before a key in a list.
    pub hints: Vec<u64>,
}

/// Everything the proof needs for postage in one settlement.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PostageInput {
    /// Header after the previous settlement; its hash must equal Settlement.postageStateHash.
    pub header: PostageHeader,
    /// Log position after the previous settlement (Settlement.postageEventIndex / postageEventHash).
    pub prev_event_index: u64,
    pub prev_event_hash: B256,
    /// Log entries prev_event_index+1 ..= the last entry with block <= cut_block, in order.
    pub events: Vec<PostageEvent>,
    /// Every entry up to this block is applied; the pot is credited up to the outpayment at this block.
    pub cut_block: u64,
    pub witness: PostageWitness,
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
    /// A Merkle proof does not match the root, or the witness has too few proofs or hints.
    BadWitness,
    /// A hint names a leaf that does not have the claimed place in a list.
    BadHint,
    /// The witness has more proofs or hints than the settlement used.
    WitnessTooLong,
}

/// What a claim sees of one batch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaimBatch {
    pub id: B256,
    /// The batch's leaf after this settlement's events, or None if it is not in the tree.
    pub leaf: Option<Leaf>,
}

/// Result of a settlement's postage part.
#[derive(Clone, Debug)]
pub struct PostageRun {
    /// Outpayment at the probe block (the round's seed block): a batch is alive for the claim when its
    /// normalisedBalance is above this. If a price change after the probe was already applied by the
    /// previous settlement, this is the outpayment at that change (the earliest point still known).
    pub outpayment_at_probe: U256,
    /// The batches the claim asked for, after the events and before the cut.
    pub claims: Vec<ClaimBatch>,
    pub new_header: PostageHeader,
    pub event_index: u64,
    pub event_hash: B256,
    /// Pot earned in this settlement.
    pub pot: U256,
    /// Chunks of live batches after the cut (PostageStamp.validChunkCount).
    pub valid_chunk_count: U256,
}

// ---------------------------------------------------------------------------------------------------
// Merkle helpers
// ---------------------------------------------------------------------------------------------------

fn hash_pair(l: &B256, r: &B256) -> B256 {
    let mut buf = [0u8; 64];
    buf[..32].copy_from_slice(l.as_slice());
    buf[32..].copy_from_slice(r.as_slice());
    keccak256(buf)
}

/// Root of an all-empty subtree at each level 0..=TREE_DEPTH.
pub fn zero_hashes() -> Vec<B256> {
    let mut z = vec![B256::ZERO; TREE_DEPTH + 1];
    for i in 1..=TREE_DEPTH {
        z[i] = hash_pair(&z[i - 1], &z[i - 1]);
    }
    z
}

fn root_from(index: u64, leaf: B256, siblings: &[B256]) -> B256 {
    let mut h = leaf;
    for (level, s) in siblings.iter().enumerate() {
        h = if (index >> level) & 1 == 0 {
            hash_pair(&h, s)
        } else {
            hash_pair(s, &h)
        };
    }
    h
}

fn size(depth: u8) -> Result<U256, PostageError> {
    U256::from(1u8)
        .checked_shl(depth as usize)
        .ok_or(PostageError::Overflow)
}

// ---------------------------------------------------------------------------------------------------
// The two trees
// ---------------------------------------------------------------------------------------------------

/// A question the algorithm asks the tree. The answer is a leaf index; the algorithm checks it.
#[derive(Clone, Copy, Debug)]
pub enum Query {
    /// The leaf with this batch id, or NOT_FOUND.
    Find(B256),
    /// The leaf before this id in the id list.
    PredId(B256),
    /// The leaf before this (balance, id) in the expiry list.
    PredBal(U256, B256),
}

pub trait BatchTree {
    fn read(&mut self, index: u64) -> Result<Leaf, PostageError>;
    /// Replace the leaf at `index` with `f(old leaf)`.
    fn write(
        &mut self,
        index: u64,
        f: impl FnOnce(&Leaf) -> Result<Leaf, PostageError>,
    ) -> Result<(), PostageError>;
    fn hint(&mut self, q: Query) -> Result<u64, PostageError>;
    fn root(&mut self) -> B256;
}

/// The zkVM side: checks every leaf against the root and moves the root on each write.
pub struct WitnessTree<'a> {
    root: B256,
    proofs: std::slice::Iter<'a, LeafProof>,
    hints: std::slice::Iter<'a, u64>,
}

impl<'a> WitnessTree<'a> {
    pub fn new(header: &PostageHeader, witness: &'a PostageWitness) -> Self {
        WitnessTree {
            root: if header.is_genesis() {
                zero_hashes()[TREE_DEPTH]
            } else {
                header.root
            },
            proofs: witness.proofs.iter(),
            hints: witness.hints.iter(),
        }
    }

    fn proof(&mut self, index: u64) -> Result<&'a LeafProof, PostageError> {
        let p = self.proofs.next().ok_or(PostageError::BadWitness)?;
        if p.siblings.len() != TREE_DEPTH
            || index >> TREE_DEPTH != 0
            || root_from(index, p.leaf.hash(), &p.siblings) != self.root
        {
            return Err(PostageError::BadWitness);
        }
        Ok(p)
    }

    fn done(&self) -> bool {
        self.proofs.len() == 0 && self.hints.len() == 0
    }
}

impl BatchTree for WitnessTree<'_> {
    fn read(&mut self, index: u64) -> Result<Leaf, PostageError> {
        Ok(self.proof(index)?.leaf.clone())
    }

    fn write(
        &mut self,
        index: u64,
        f: impl FnOnce(&Leaf) -> Result<Leaf, PostageError>,
    ) -> Result<(), PostageError> {
        let p = self.proof(index)?;
        let new = f(&p.leaf)?;
        self.root = root_from(index, new.hash(), &p.siblings);
        Ok(())
    }

    fn hint(&mut self, _q: Query) -> Result<u64, PostageError> {
        self.hints.next().copied().ok_or(PostageError::BadWitness)
    }

    fn root(&mut self) -> B256 {
        self.root
    }
}

/// The prover side: every leaf, the tree's node hashes, and the two lists as sorted maps to answer
/// queries. With `record` set, it writes down the proofs and hints the zkVM needs.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FullTree {
    leaves: Vec<Leaf>,
    /// Node hashes by level, built from `leaves` when first needed. Missing entries are empty subtrees.
    #[serde(skip)]
    levels: Vec<Vec<B256>>,
    #[serde(skip)]
    zeros: Vec<B256>,
    #[serde(skip)]
    by_id: BTreeMap<B256, u64>,
    #[serde(skip)]
    by_bal: BTreeMap<(U256, B256), u64>,
    #[serde(skip)]
    pub(crate) record: Option<PostageWitness>,
}

impl FullTree {
    fn ensure(&mut self) {
        if !self.zeros.is_empty() {
            return;
        }
        self.zeros = zero_hashes();
        let mut level: Vec<B256> = self.leaves.iter().map(Leaf::hash).collect();
        self.levels = Vec::with_capacity(TREE_DEPTH + 1);
        for l in 0..TREE_DEPTH {
            let next = level
                .chunks(2)
                .map(|p| hash_pair(&p[0], p.get(1).unwrap_or(&self.zeros[l])))
                .collect();
            self.levels.push(std::mem::replace(&mut level, next));
        }
        self.levels.push(level);
        for (i, leaf) in self.leaves.iter().enumerate() {
            if i != 0 && !leaf.is_empty() {
                self.by_id.insert(leaf.id, i as u64);
                self.by_bal.insert(leaf.key(), i as u64);
            }
        }
    }

    fn node(&self, level: usize, index: u64) -> B256 {
        self.levels[level]
            .get(index as usize)
            .copied()
            .unwrap_or(self.zeros[level])
    }

    fn siblings(&self, index: u64) -> Vec<B256> {
        (0..TREE_DEPTH)
            .map(|l| self.node(l, (index >> l) ^ 1))
            .collect()
    }

    fn leaf(&self, index: u64) -> Leaf {
        self.leaves.get(index as usize).cloned().unwrap_or_default()
    }

    fn set(&mut self, index: u64, leaf: Leaf) {
        let i = index as usize;
        if self.leaves.len() <= i {
            self.leaves.resize(i + 1, Leaf::default());
        }
        let old = std::mem::replace(&mut self.leaves[i], leaf);
        if index != 0 && !old.is_empty() {
            self.by_id.remove(&old.id);
            self.by_bal.remove(&old.key());
        }
        let new = &self.leaves[i];
        if index != 0 && !new.is_empty() {
            self.by_id.insert(new.id, index);
            self.by_bal.insert(new.key(), index);
        }
        let mut h = new.hash();
        for l in 0..=TREE_DEPTH {
            let at = (index >> l) as usize;
            if self.levels[l].len() <= at {
                let z = self.zeros[l];
                self.levels[l].resize(at + 1, z);
            }
            self.levels[l][at] = h;
            if l < TREE_DEPTH {
                let s = self.node(l, (index >> l) ^ 1);
                h = if (index >> l) & 1 == 0 {
                    hash_pair(&h, &s)
                } else {
                    hash_pair(&s, &h)
                };
            }
        }
    }

    fn prove(&mut self, index: u64) {
        if self.record.is_some() {
            let p = LeafProof {
                leaf: self.leaf(index),
                siblings: self.siblings(index),
            };
            self.record.as_mut().unwrap().proofs.push(p);
        }
    }
}

impl BatchTree for FullTree {
    fn read(&mut self, index: u64) -> Result<Leaf, PostageError> {
        self.ensure();
        self.prove(index);
        Ok(self.leaf(index))
    }

    fn write(
        &mut self,
        index: u64,
        f: impl FnOnce(&Leaf) -> Result<Leaf, PostageError>,
    ) -> Result<(), PostageError> {
        self.ensure();
        self.prove(index);
        let new = f(&self.leaf(index))?;
        self.set(index, new);
        Ok(())
    }

    fn hint(&mut self, q: Query) -> Result<u64, PostageError> {
        self.ensure();
        let v = match q {
            Query::Find(id) => self.by_id.get(&id).copied().unwrap_or(NOT_FOUND),
            Query::PredId(id) => self.by_id.range(..id).next_back().map_or(0, |(_, i)| *i),
            Query::PredBal(b, id) => self
                .by_bal
                .range(..(b, id))
                .next_back()
                .map_or(0, |(_, i)| *i),
        };
        if let Some(r) = self.record.as_mut() {
            r.hints.push(v);
        }
        Ok(v)
    }

    fn root(&mut self) -> B256 {
        self.ensure();
        self.node(TREE_DEPTH, 0)
    }
}

// ---------------------------------------------------------------------------------------------------
// List operations (the same on both trees)
// ---------------------------------------------------------------------------------------------------

/// A leaf that is in the lists: the head, or any non-empty leaf (every insert links both lists, every
/// remove unlinks both and empties the leaf).
fn member(index: u64, l: &Leaf) -> Result<(), PostageError> {
    if index != 0 && l.is_empty() {
        return Err(PostageError::BadHint);
    }
    Ok(())
}

/// Link `leaf` (to be written at `index`) into the expiry list. Sets its expiry pointers.
fn link_bal<T: BatchTree>(t: &mut T, index: u64, leaf: &mut Leaf) -> Result<(), PostageError> {
    let q = t.hint(Query::PredBal(leaf.balance, leaf.id))?;
    if q == index {
        return Err(PostageError::BadHint);
    }
    t.write(q, |ql| {
        member(q, ql)?;
        if !(ql.key() < leaf.key() && leaf.key() < ql.next_key()) {
            return Err(PostageError::BadHint);
        }
        leaf.next_bal_index = ql.next_bal_index;
        leaf.next_bal = ql.next_bal;
        leaf.next_bal_id = ql.next_bal_id;
        let mut n = ql.clone();
        n.next_bal_index = index;
        n.next_bal = leaf.balance;
        n.next_bal_id = leaf.id;
        Ok(n)
    })
}

/// Take the leaf at `index` (contents `leaf`) out of the expiry list.
fn unlink_bal<T: BatchTree>(t: &mut T, index: u64, leaf: &Leaf) -> Result<(), PostageError> {
    let q = t.hint(Query::PredBal(leaf.balance, leaf.id))?;
    t.write(q, |ql| {
        if ql.next_bal_index != index || ql.next_key() != leaf.key() {
            return Err(PostageError::BadHint);
        }
        let mut n = ql.clone();
        n.next_bal_index = leaf.next_bal_index;
        n.next_bal = leaf.next_bal;
        n.next_bal_id = leaf.next_bal_id;
        Ok(n)
    })
}

/// Add a new batch at the unused leaf `index`.
fn insert<T: BatchTree>(t: &mut T, index: u64, mut leaf: Leaf) -> Result<(), PostageError> {
    if leaf.id.is_zero() || leaf.id == B256::repeat_byte(0xff) || leaf.balance == U256::MAX {
        return Err(PostageError::Overflow); // reserved for the head and the list ends
    }
    let p = t.hint(Query::PredId(leaf.id))?;
    t.write(p, |pl| {
        member(p, pl)?;
        if pl.next_id == leaf.id {
            return Err(PostageError::BatchExists);
        }
        if !(pl.id < leaf.id && leaf.id < pl.next_id) {
            return Err(PostageError::BadHint);
        }
        leaf.next_id_index = pl.next_id_index;
        leaf.next_id = pl.next_id;
        let mut n = pl.clone();
        n.next_id_index = index;
        n.next_id = leaf.id;
        Ok(n)
    })?;
    link_bal(t, index, &mut leaf)?;
    t.write(index, |old| {
        if !old.is_empty() {
            return Err(PostageError::BadWitness);
        }
        Ok(leaf)
    })
}

/// Remove the batch at `index` from both lists and empty its leaf. Returns what it was.
fn remove<T: BatchTree>(t: &mut T, index: u64) -> Result<Leaf, PostageError> {
    let leaf = t.read(index)?;
    if index == 0 || leaf.is_empty() {
        return Err(PostageError::BadHint);
    }
    let p = t.hint(Query::PredId(leaf.id))?;
    t.write(p, |pl| {
        if pl.next_id_index != index || pl.next_id != leaf.id {
            return Err(PostageError::BadHint);
        }
        let mut n = pl.clone();
        n.next_id_index = leaf.next_id_index;
        n.next_id = leaf.next_id;
        Ok(n)
    })?;
    unlink_bal(t, index, &leaf)?;
    t.write(index, |l| {
        if *l != leaf {
            return Err(PostageError::BadWitness);
        }
        Ok(Leaf::default())
    })?;
    Ok(leaf)
}

/// A top-up or depth increase: new balance and depth for the batch `id`. It keeps its leaf and its place
/// in the id list, and moves in the expiry list. Returns the old leaf.
fn change<T: BatchTree>(t: &mut T, e: &PostageEvent) -> Result<Leaf, PostageError> {
    let index = t.hint(Query::Find(e.batch_id))?;
    if index == NOT_FOUND {
        return Err(PostageError::UnknownBatch);
    }
    let old = t.read(index)?;
    if index == 0 || old.id != e.batch_id {
        return Err(PostageError::BadHint);
    }
    unlink_bal(t, index, &old)?;
    // Write it unlinked first, so the predecessor query for the new key cannot return the old position.
    let mut leaf = Leaf {
        balance: e.value,
        depth: e.depth,
        next_bal_index: END,
        next_bal: U256::ZERO,
        next_bal_id: B256::ZERO,
        ..old.clone()
    };
    let unlinked = leaf.clone();
    t.write(index, |l| {
        if *l != old {
            return Err(PostageError::BadWitness);
        }
        Ok(unlinked)
    })?;
    link_bal(t, index, &mut leaf)?;
    let expect = Leaf {
        next_bal_index: END,
        next_bal: U256::ZERO,
        next_bal_id: B256::ZERO,
        ..leaf.clone()
    };
    t.write(index, |l| {
        if *l != expect {
            return Err(PostageError::BadWitness);
        }
        Ok(leaf)
    })?;
    Ok(old)
}

/// The leaf of batch `id`, or None with a proof that the id list has no such batch.
fn find<T: BatchTree>(t: &mut T, id: B256) -> Result<Option<Leaf>, PostageError> {
    if id.is_zero() || id == B256::repeat_byte(0xff) {
        return Ok(None); // the head's and the end's ids are never batches
    }
    let index = t.hint(Query::Find(id))?;
    if index != NOT_FOUND {
        let l = t.read(index)?;
        if index == 0 || l.id != id {
            return Err(PostageError::BadHint);
        }
        return Ok(Some(l));
    }
    let p = t.hint(Query::PredId(id))?;
    let pl = t.read(p)?;
    member(p, &pl)?;
    if !(pl.id < id && id < pl.next_id) {
        return Err(PostageError::BadHint);
    }
    Ok(None)
}

// ---------------------------------------------------------------------------------------------------
// One settlement
// ---------------------------------------------------------------------------------------------------

/// Replay `events` on the tree, look up `claim_ids`, credit the pot up to `cut_block` and remove the
/// batches that expired. `probe_block` is the round's seed block.
#[allow(clippy::too_many_arguments)]
pub fn apply<T: BatchTree>(
    t: &mut T,
    header: &PostageHeader,
    prev_event_index: u64,
    prev_event_hash: B256,
    events: &[PostageEvent],
    cut_block: u64,
    probe_block: u64,
    claim_ids: &[B256],
) -> Result<PostageRun, PostageError> {
    let mut h = header.clone();

    // Nothing ever happened: no batches, no price. Nothing to replay, prove or store.
    if h.is_genesis() && events.is_empty() {
        return Ok(PostageRun {
            outpayment_at_probe: U256::ZERO,
            claims: claim_ids
                .iter()
                .map(|id| ClaimBatch {
                    id: *id,
                    leaf: None,
                })
                .collect(),
            new_header: h,
            event_index: prev_event_index,
            event_hash: prev_event_hash,
            pot: U256::ZERO,
            valid_chunk_count: U256::ZERO,
        });
    }
    if h.is_genesis() {
        t.write(0, |l| {
            if !l.is_empty() {
                return Err(PostageError::BadWitness);
            }
            Ok(Leaf::head())
        })?;
        h.next_free = 1;
    }
    if cut_block < h.last_cut_block {
        return Err(PostageError::BadCut);
    }

    let mut probe = if probe_block < h.price_block {
        Some(h.price_outpayment)
    } else {
        None
    };
    let mut pot = U256::ZERO;
    let mut live = h.live_chunks;
    let mut paid_to = h.outpayment_at(h.last_cut_block)?;
    let mut hash = prev_event_hash;
    let mut index = prev_event_index;
    let add = |a: U256, b: U256| a.checked_add(b).ok_or(PostageError::Overflow);
    let mul = |a: U256, b: U256| a.checked_mul(b).ok_or(PostageError::Overflow);

    for e in events {
        if e.index != index + 1 || e.block > cut_block || e.block < h.last_cut_block {
            return Err(PostageError::EventOrder);
        }
        if probe.is_none() && e.block > probe_block {
            probe = Some(h.outpayment_at(probe_block)?);
        }
        if e.outpayment != h.outpayment_at(e.block)? {
            return Err(PostageError::OutpaymentMismatch);
        }
        // Every batch in the tree pays up to this point; expired ones are corrected at the cut.
        let delta = e
            .outpayment
            .checked_sub(paid_to)
            .ok_or(PostageError::Overflow)?;
        pot = add(pot, mul(live, delta)?)?;
        paid_to = e.outpayment;

        match e.kind {
            KIND_PRICE => {
                h.price_block = e.block;
                h.price_outpayment = e.outpayment;
                h.price = e.value;
            }
            KIND_CREATE => {
                let leaf = Leaf {
                    id: e.batch_id,
                    owner: e.owner,
                    depth: e.depth,
                    bucket_depth: e.bucket_depth,
                    balance: e.value,
                    ..Default::default()
                };
                insert(t, h.next_free, leaf)?;
                h.next_free += 1;
                live = add(live, size(e.depth)?)?;
            }
            KIND_TOPUP | KIND_DEPTH => {
                let old = change(t, e)?;
                live = add(
                    live.checked_sub(size(old.depth)?)
                        .ok_or(PostageError::Overflow)?,
                    size(e.depth)?,
                )?;
            }
            _ => return Err(PostageError::UnknownKind),
        }
        hash = event_hash(hash, e);
        index = e.index;
    }

    let outpayment_at_probe = match probe {
        Some(p) => p,
        None => h.outpayment_at(probe_block)?,
    };
    let mut claims = Vec::with_capacity(claim_ids.len());
    for id in claim_ids {
        claims.push(ClaimBatch {
            id: *id,
            leaf: find(t, *id)?,
        });
    }

    // The cut: pay up to it, then remove every batch whose balance it reached and take back what such a
    // batch did not pay. Expired batches are at the front of the expiry list.
    let cut = h.outpayment_at(cut_block)?;
    let delta = cut.checked_sub(paid_to).ok_or(PostageError::Overflow)?;
    pot = add(pot, mul(live, delta)?)?;
    loop {
        let head = t.read(0)?;
        if head.next_bal_index == END || head.next_bal > cut {
            break;
        }
        let gone = remove(t, head.next_bal_index)?;
        let s = size(gone.depth)?;
        let unpaid = mul(s, cut - gone.balance)?;
        pot = pot.checked_sub(unpaid).ok_or(PostageError::Overflow)?;
        live = live.checked_sub(s).ok_or(PostageError::Overflow)?;
    }

    h.live_chunks = live;
    h.last_cut_block = cut_block;
    h.root = t.root();
    Ok(PostageRun {
        outpayment_at_probe,
        claims,
        new_header: h,
        event_index: index,
        event_hash: hash,
        pot,
        valid_chunk_count: live,
    })
}

/// The zkVM side: run a settlement from its input and witness.
pub fn verify(
    input: &PostageInput,
    probe_block: u64,
    claim_ids: &[B256],
) -> Result<PostageRun, PostageError> {
    let mut t = WitnessTree::new(&input.header, &input.witness);
    let r = apply(
        &mut t,
        &input.header,
        input.prev_event_index,
        input.prev_event_hash,
        &input.events,
        input.cut_block,
        probe_block,
        claim_ids,
    )?;
    if !t.done() {
        return Err(PostageError::WitnessTooLong);
    }
    Ok(r)
}

// ---------------------------------------------------------------------------------------------------
// The prover's state
// ---------------------------------------------------------------------------------------------------

/// The full postage state the prover keeps between settlements (by `hash()`).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PostageState {
    pub header: PostageHeader,
    pub tree: FullTree,
}

impl PostageState {
    pub fn hash(&self) -> B256 {
        self.header.hash()
    }

    /// The live batches, in id order.
    pub fn batches(&self) -> Vec<Leaf> {
        let mut out: Vec<Leaf> = self
            .tree
            .leaves
            .iter()
            .skip(1)
            .filter(|l| !l.is_empty())
            .cloned()
            .collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    pub fn batch(&self, id: &B256) -> Option<Leaf> {
        self.tree
            .leaves
            .iter()
            .skip(1)
            .find(|l| l.id == *id)
            .cloned()
    }

    /// A state as if the last settlement cut at `last_cut_block` with these batches alive (owner, depth,
    /// bucket depth and normalisedBalance taken from each leaf). For tests and synthetic rounds.
    pub fn from_batches(
        last_cut_block: u64,
        price_block: u64,
        price_outpayment: U256,
        price: U256,
        batches: &[Leaf],
    ) -> Result<Self, PostageError> {
        let mut tree = FullTree::default();
        tree.write(0, |_| Ok(Leaf::head()))?;
        let mut live = U256::ZERO;
        for (i, b) in batches.iter().enumerate() {
            let leaf = Leaf {
                id: b.id,
                owner: b.owner,
                depth: b.depth,
                bucket_depth: b.bucket_depth,
                balance: b.balance,
                ..Default::default()
            };
            insert(&mut tree, i as u64 + 1, leaf)?;
            live += size(b.depth)?;
        }
        Ok(PostageState {
            header: PostageHeader {
                root: tree.root(),
                next_free: batches.len() as u64 + 1,
                live_chunks: live,
                last_cut_block,
                price_block,
                price_outpayment,
                price,
            },
            tree,
        })
    }

    /// Run a settlement on this state in place. With `record`, also return the zkVM input.
    #[allow(clippy::too_many_arguments)]
    pub fn settle(
        &mut self,
        prev_event_index: u64,
        prev_event_hash: B256,
        events: Vec<PostageEvent>,
        cut_block: u64,
        probe_block: u64,
        claim_ids: &[B256],
        record: bool,
    ) -> Result<(PostageRun, Option<PostageInput>), PostageError> {
        let header = self.header.clone();
        self.tree.record = record.then(PostageWitness::default);
        let r = apply(
            &mut self.tree,
            &header,
            prev_event_index,
            prev_event_hash,
            &events,
            cut_block,
            probe_block,
            claim_ids,
        );
        let witness = self.tree.record.take();
        let r = r?;
        self.header = r.new_header.clone();
        let input = witness.map(|witness| PostageInput {
            header,
            prev_event_index,
            prev_event_hash,
            events,
            cut_block,
            witness,
        });
        Ok((r, input))
    }
}
