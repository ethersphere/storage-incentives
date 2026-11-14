//! Postage accounting for the circuit (docs/SNARK-SETTLEMENT.md, section 6).
//!
//! The same accounting as `crate::postage`, with a state that a circuit can check with few constraints:
//! a MiMC Merkle tree of depth 24, and one linked list of the live batches in expiry order. The key of a
//! batch in the list is (normalisedBalance, leaf index). Leaf 0 is the head of the list, and
//! `next_index == 0` is its end.
//!
//! The claim does not read this state: `Settlement` checks the batches of a claim on chain.

use super::{compress, halves, mimc, u, Fr};
use alloy_primitives::{B256, U256};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const KIND_CREATE: u8 = 1;
pub const KIND_TOPUP: u8 = 2;
pub const KIND_DEPTH: u8 = 3;
pub const KIND_PRICE: u8 = 4;

pub const TREE_DEPTH: usize = 24;
/// A batch depth must be below this, so that the chunk counts fit.
pub const MAX_DEPTH: u8 = 64;

fn max128() -> U256 {
    (U256::from(1u8) << 128) - U256::from(1u8)
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Leaf {
    pub id: B256,
    pub depth: u8,
    pub balance: U256,
    pub next_index: u64,
    pub next_bal: U256,
}

impl Leaf {
    pub fn fields(&self) -> [Fr; 6] {
        let (hi, lo) = halves(&self.id);
        [
            hi,
            lo,
            u(self.depth as u64),
            self.balance,
            u(self.next_index),
            self.next_bal,
        ]
    }
    pub fn hash(&self) -> Fr {
        mimc(&self.fields())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Header {
    pub root: Fr,
    pub next_free: u64,
    pub live_chunks: U256,
    pub last_cut_block: u64,
    pub price_block: u64,
    pub price_outpayment: U256,
    pub price: U256,
}

impl Header {
    /// The state before the first event: an empty tree (leaf 0 is the head of an empty list).
    pub fn genesis() -> Header {
        Header {
            root: zero_hashes()[TREE_DEPTH],
            next_free: 1,
            live_chunks: U256::ZERO,
            last_cut_block: 0,
            price_block: 0,
            price_outpayment: U256::ZERO,
            price: U256::ZERO,
        }
    }

    pub fn is_genesis(&self) -> bool {
        *self == Header::genesis()
    }

    pub fn fields(&self) -> [Fr; 7] {
        [
            self.root,
            u(self.next_free),
            self.live_chunks,
            u(self.last_cut_block),
            u(self.price_block),
            self.price_outpayment,
            self.price,
        ]
    }

    /// `Settlement.postageStateHash`.
    pub fn hash(&self) -> Fr {
        mimc(&self.fields())
    }

    pub fn outpayment_at(&self, block: u64) -> Result<U256, PostageError> {
        let blocks = block
            .checked_sub(self.price_block)
            .ok_or(PostageError::BlockBeforePrice)?;
        Ok(self.price * U256::from(blocks) + self.price_outpayment)
    }
}

/// One entry of the event log of PostageStampZK.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    pub index: u64,
    pub kind: u8,
    pub batch_id: B256,
    pub depth: u8,
    /// New normalisedBalance, or the new price for KIND_PRICE.
    pub value: U256,
    pub block: u64,
}

/// `PostageStampZK._log`: sha256(prev, kind, batchId, depth, value (16 bytes), block (8 bytes)).
pub fn event_hash(prev: B256, e: &Event) -> B256 {
    let mut buf = Vec::with_capacity(90);
    buf.extend_from_slice(prev.as_slice());
    buf.push(e.kind);
    buf.extend_from_slice(e.batch_id.as_slice());
    buf.push(e.depth);
    buf.extend_from_slice(&e.value.to_be_bytes::<32>()[16..]);
    buf.extend_from_slice(&e.block.to_be_bytes());
    super::sha256(&buf)
}

/// One leaf write as the circuit checks it: the leaf before the write and its path.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Write {
    pub index: u64,
    pub leaf: Leaf,
    pub siblings: Vec<Fr>,
}

impl Write {
    pub fn dummy() -> Write {
        Write {
            index: 0,
            leaf: Leaf::default(),
            siblings: vec![U256::ZERO; TREE_DEPTH],
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Witness {
    /// For each event: [unlink (top-up, depth), link (create, top-up, depth), the batch's leaf].
    pub events: Vec<[Write; 3]>,
    /// For each batch that expired: (the head before, the batch's leaf).
    pub expiries: Vec<(Write, Write)>,
    /// The head after the last expiry: its successor has not expired.
    pub final_head: Write,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Input {
    pub header: Header,
    pub prev_event_index: u64,
    pub prev_event_hash: B256,
    pub events: Vec<Event>,
    pub cut_block: u64,
    pub witness: Witness,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Run {
    pub new_header: Header,
    pub event_index: u64,
    pub event_hash: B256,
    pub pot: U256,
    pub valid_chunk_count: U256,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PostageError {
    EventOrder,
    BadCut,
    BlockBeforePrice,
    UnknownBatch,
    UnknownKind,
    /// A value is outside the range the circuit supports.
    Range,
    Overflow,
}

pub fn zero_hashes() -> &'static Vec<Fr> {
    static Z: std::sync::OnceLock<Vec<Fr>> = std::sync::OnceLock::new();
    Z.get_or_init(|| {
        let mut z = vec![Leaf::default().hash()];
        for i in 0..TREE_DEPTH {
            z.push(compress(z[i], z[i]));
        }
        z
    })
}

/// Every leaf and node hash of the batch tree: the prover's side.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Tree {
    #[serde(with = "sparse")]
    leaves: Vec<Leaf>,
    #[serde(skip)]
    levels: Vec<Vec<Fr>>,
    /// (balance, index) of every batch in the list.
    #[serde(skip)]
    by_bal: BTreeSet<(U256, u64)>,
}

mod sparse {
    use super::Leaf;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    #[derive(Serialize, Deserialize)]
    struct Sparse {
        len: u64,
        leaves: Vec<(u64, Leaf)>,
    }

    pub fn serialize<S: Serializer>(v: &[Leaf], s: S) -> Result<S::Ok, S::Error> {
        Sparse {
            len: v.len() as u64,
            leaves: v
                .iter()
                .enumerate()
                .filter(|(_, l)| **l != Leaf::default())
                .map(|(i, l)| (i as u64, l.clone()))
                .collect(),
        }
        .serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Leaf>, D::Error> {
        let sp = Sparse::deserialize(d)?;
        let mut v = vec![Leaf::default(); sp.len as usize];
        for (i, l) in sp.leaves {
            if let Some(slot) = v.get_mut(i as usize) {
                *slot = l;
            }
        }
        Ok(v)
    }
}

impl Tree {
    fn ensure(&mut self) {
        if !self.levels.is_empty() {
            return;
        }
        let z = zero_hashes();
        let mut level: Vec<Fr> = self.leaves.iter().map(Leaf::hash).collect();
        for l in 0..TREE_DEPTH {
            let next = level
                .chunks(2)
                .map(|p| compress(p[0], *p.get(1).unwrap_or(&z[l])))
                .collect();
            self.levels.push(std::mem::replace(&mut level, next));
        }
        self.levels.push(level);
        for (i, leaf) in self.leaves.iter().enumerate() {
            if i != 0 && !leaf.id.is_zero() {
                self.by_bal.insert((leaf.balance, i as u64));
            }
        }
    }

    fn node(&self, level: usize, index: u64) -> Fr {
        self.levels[level]
            .get(index as usize)
            .copied()
            .unwrap_or(zero_hashes()[level])
    }

    pub fn root(&mut self) -> Fr {
        self.ensure();
        self.node(TREE_DEPTH, 0)
    }

    pub fn leaf(&self, index: u64) -> Leaf {
        self.leaves.get(index as usize).cloned().unwrap_or_default()
    }

    pub fn find(&self, id: &B256) -> Option<(u64, Leaf)> {
        self.leaves
            .iter()
            .enumerate()
            .skip(1)
            .find(|(_, l)| l.id == *id)
            .map(|(i, l)| (i as u64, l.clone()))
    }

    pub fn batches(&self) -> Vec<Leaf> {
        self.leaves
            .iter()
            .skip(1)
            .filter(|l| !l.id.is_zero())
            .cloned()
            .collect()
    }

    /// The leaf before `key` in the list (the head if there is none).
    fn pred(&mut self, key: (U256, u64)) -> u64 {
        self.ensure();
        self.by_bal.range(..key).next_back().map_or(0, |k| k.1)
    }

    /// Replace the leaf at `index`. Returns the write as the circuit checks it.
    fn write(&mut self, index: u64, new: Leaf) -> Write {
        self.ensure();
        let w = Write {
            index,
            leaf: self.leaf(index),
            siblings: (0..TREE_DEPTH)
                .map(|l| self.node(l, (index >> l) ^ 1))
                .collect(),
        };
        let i = index as usize;
        if self.leaves.len() <= i {
            self.leaves.resize(i + 1, Leaf::default());
        }
        let mut h = new.hash();
        self.leaves[i] = new;
        let z = zero_hashes();
        for l in 0..=TREE_DEPTH {
            let at = (index >> l) as usize;
            if self.levels[l].len() <= at {
                self.levels[l].resize(at + 1, z[l]);
            }
            self.levels[l][at] = h;
            if l < TREE_DEPTH {
                let s = self.node(l, (index >> l) ^ 1);
                h = if (index >> l) & 1 == 0 {
                    compress(h, s)
                } else {
                    compress(s, h)
                };
            }
        }
        w
    }

    /// Put the leaf at `index` (contents `leaf`, not yet written) after its predecessor. Returns the
    /// write of the predecessor and the leaf's successor.
    fn link(&mut self, index: u64, balance: U256) -> (Write, u64, U256) {
        let q = self.pred((balance, index));
        let ql = self.leaf(q);
        let next = (ql.next_index, ql.next_bal);
        let w = self.write(
            q,
            Leaf {
                next_index: index,
                next_bal: balance,
                ..ql
            },
        );
        self.by_bal.insert((balance, index));
        (w, next.0, next.1)
    }

    /// Take the leaf at `index` out of the list: its predecessor now points to its successor.
    fn unlink(&mut self, index: u64, leaf: &Leaf) -> Write {
        self.by_bal.remove(&(leaf.balance, index));
        let q = self.pred((leaf.balance, index));
        let ql = self.leaf(q);
        self.write(
            q,
            Leaf {
                next_index: leaf.next_index,
                next_bal: leaf.next_bal,
                ..ql
            },
        )
    }
}

fn size(depth: u8) -> Result<U256, PostageError> {
    if depth >= MAX_DEPTH {
        return Err(PostageError::Range);
    }
    Ok(U256::from(1u8) << depth as usize)
}

/// Replay `events`, credit the pot up to `cut_block`, and remove the batches that expired.
pub fn apply(
    t: &mut Tree,
    header: &Header,
    prev_event_index: u64,
    prev_event_hash: B256,
    events: &[Event],
    cut_block: u64,
) -> Result<(Run, Witness), PostageError> {
    let mut h = header.clone();
    let mut wit = Witness::default();
    if cut_block < h.last_cut_block {
        return Err(PostageError::BadCut);
    }
    let mut pot = U256::ZERO;
    let mut live = h.live_chunks;
    let mut paid_to = h.outpayment_at(h.last_cut_block)?;
    let mut hash = prev_event_hash;
    let mut index = prev_event_index;

    for e in events {
        if e.index != index + 1 || e.block > cut_block || e.block < h.last_cut_block {
            return Err(PostageError::EventOrder);
        }
        if e.value > max128() {
            return Err(PostageError::Range);
        }
        let outpayment = h.outpayment_at(e.block)?;
        let delta = outpayment
            .checked_sub(paid_to)
            .ok_or(PostageError::Overflow)?;
        pot += live * delta;
        paid_to = outpayment;

        let mut w = [Write::dummy(), Write::dummy(), Write::dummy()];
        match e.kind {
            KIND_PRICE => {
                if e.value >= U256::from(1u8) << 64 {
                    return Err(PostageError::Range);
                }
                h.price_block = e.block;
                h.price_outpayment = outpayment;
                h.price = e.value;
            }
            KIND_CREATE => {
                if e.batch_id.is_zero() {
                    return Err(PostageError::Range);
                }
                let at = h.next_free;
                let (wb, ni, nb) = t.link(at, e.value);
                w[1] = wb;
                w[2] = t.write(
                    at,
                    Leaf {
                        id: e.batch_id,
                        depth: e.depth,
                        balance: e.value,
                        next_index: ni,
                        next_bal: nb,
                    },
                );
                h.next_free += 1;
                live += size(e.depth)?;
            }
            KIND_TOPUP | KIND_DEPTH => {
                let (at, old) = t.find(&e.batch_id).ok_or(PostageError::UnknownBatch)?;
                w[0] = t.unlink(at, &old);
                let (wb, ni, nb) = t.link(at, e.value);
                w[1] = wb;
                w[2] = t.write(
                    at,
                    Leaf {
                        id: e.batch_id,
                        depth: e.depth,
                        balance: e.value,
                        next_index: ni,
                        next_bal: nb,
                    },
                );
                live = live + size(e.depth)? - size(old.depth)?;
            }
            _ => return Err(PostageError::UnknownKind),
        }
        wit.events.push(w);
        hash = event_hash(hash, e);
        index = e.index;
    }

    let cut = h.outpayment_at(cut_block)?;
    let delta = cut.checked_sub(paid_to).ok_or(PostageError::Overflow)?;
    pot += live * delta;
    loop {
        let head = t.leaf(0);
        if head.next_index == 0 || head.next_bal > cut {
            break;
        }
        let at = head.next_index;
        let gone = t.leaf(at);
        t.by_bal.remove(&(gone.balance, at));
        let wh = t.write(
            0,
            Leaf {
                next_index: gone.next_index,
                next_bal: gone.next_bal,
                ..head
            },
        );
        let wt = t.write(at, Leaf::default());
        wit.expiries.push((wh, wt));
        let s = size(gone.depth)?;
        pot = pot
            .checked_sub(s * (cut - gone.balance))
            .ok_or(PostageError::Overflow)?;
        live -= s;
    }
    // A read of the head: write it back unchanged.
    let head = t.leaf(0);
    wit.final_head = t.write(0, head);

    h.live_chunks = live;
    h.last_cut_block = cut_block;
    h.root = t.root();
    Ok((
        Run {
            new_header: h,
            event_index: index,
            event_hash: hash,
            pot,
            valid_chunk_count: live,
        },
        wit,
    ))
}

/// The postage state the prover keeps between settlements.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct State {
    pub header: Header,
    pub tree: Tree,
}

impl Default for State {
    fn default() -> Self {
        State {
            header: Header::genesis(),
            tree: Tree::default(),
        }
    }
}

impl State {
    /// `Settlement.postageStateHash` of this state.
    pub fn hash(&self) -> B256 {
        super::fr_bytes(self.header.hash())
    }

    /// The live batches.
    pub fn batches(&self) -> Vec<Leaf> {
        self.tree.batches()
    }

    /// Run a settlement on this state in place, and return the circuit input for it.
    pub fn settle(
        &mut self,
        prev_event_index: u64,
        prev_event_hash: B256,
        events: Vec<Event>,
        cut_block: u64,
    ) -> Result<(Run, Input), PostageError> {
        let header = self.header.clone();
        let (run, witness) = apply(
            &mut self.tree,
            &header,
            prev_event_index,
            prev_event_hash,
            &events,
            cut_block,
        )?;
        self.header = run.new_header.clone();
        Ok((
            run,
            Input {
                header,
                prev_event_index,
                prev_event_hash,
                events,
                cut_block,
                witness,
            },
        ))
    }
}

/// The names the prover service uses.
pub type PostageState = State;
pub type PostageEvent = Event;
