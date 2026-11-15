//! One round of the game as the circuit proves it (docs/SNARK-SETTLEMENT.md).
//!
//! The rules are those of `crate::run`, with the differences of section 4 of the document. The claim
//! witness is not here: `Settlement` checks it on chain.

use super::{
    addr, base, compress, fr_bytes, halves, list_root, mimc, u, verify, Fr, Point, Sig, P,
};
use crate::{in_proximity, minimum_depth, ForcedCommit, Reveal, ROUND_LENGTH};
use alloy_primitives::{Address, B256, U256};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The size of the game circuit: `p` slots for commits and `p` for reveals. Anchored entries come first,
/// then forced entries, so any mix fits as long as anchored + forced <= p.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Caps {
    pub p: usize,
}

/// Bits of a random draw.
pub const DRAW_BITS: usize = 80;
/// A stake amount must be below 2^96, and `depth - height` of a reveal at most 64.
pub const STAKE_BITS: usize = 96;
pub const MAX_RESPONSIBILITY: u8 = 64;
pub const MAX_HEIGHT: u8 = 63;

/// "SwarmCommit" as a number: the first element of the signed commit message.
pub fn commit_domain() -> Fr {
    U256::from_be_slice(b"SwarmCommit")
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedCommit {
    pub owner: Address,
    /// MiMC(overlay, depth, hash, nonce): a field element.
    pub obf: Fr,
    pub sig: Sig,
}

/// A node's StakeRegistry record and its game key, as `GameKeyRegistry` commits to them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stake {
    pub owner: Address,
    pub overlay: B256,
    pub committed_stake: U256,
    pub potential_stake: U256,
    pub height: u8,
    pub last_updated: u64,
    pub key: Point,
    /// The record was last changed by a freeze of Settlement (`Settlement.frozenUntil` equals
    /// `last_updated`). A frozen node's commit then only does not count, as on master.
    #[serde(default)]
    pub frozen: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoundInput {
    pub chain_id: u64,
    pub settlement: Address,
    pub round: u64,
    pub round_anchor: B256,
    pub selection_seed: B256,
    /// Anchored commits, sorted by owner.
    pub commits: Vec<SignedCommit>,
    pub forced_commits: Vec<ForcedCommit>,
    pub reveals: Vec<Reveal>,
    pub forced_reveals: Vec<Reveal>,
    /// One record for each anchored commit, then one for each forced commit, in list order.
    pub stakes: Vec<Stake>,
    pub stake_price: u32,
    pub last_claim_round: u64,
    pub last_winner_depth: u8,
    pub penalty_multiplier_disagreement: u8,
    pub penalty_multiplier_non_revealed: u8,
    pub penalty_random_factor: u8,
    pub stake_age_rounds: u8,
    pub fee_recipient: Address,
}

/// What the proof commits to, with the inputs that `Settlement` compares with the chain.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicValues {
    pub chain_id: u64,
    pub settlement: Address,
    pub round: u64,
    pub round_anchor: B256,
    pub selection_seed: B256,
    pub commits_root: Fr,
    pub commit_count: u32,
    pub reveals_root: Fr,
    pub reveal_count: u32,
    pub forced_commits_hash: Fr,
    pub forced_commit_count: u32,
    pub forced_reveals_hash: Fr,
    pub forced_reveal_count: u32,
    pub last_claim_round: u64,
    pub last_winner_depth: u8,
    pub penalty_multiplier_disagreement: u8,
    pub penalty_multiplier_non_revealed: u8,
    pub penalty_random_factor: u8,
    pub stake_age_rounds: u8,
    pub stake_price: u32,
    pub has_reveals: bool,
    pub truth_hash: B256,
    pub truth_depth: u8,
    pub winner: Address,
    pub redundancy: u16,
    pub fee_recipient: Address,
    /// Owners of the anchored commits, then of the forced commits.
    pub owners: Vec<Address>,
    pub stake_commitments: Vec<Fr>,
    /// For each owner: 0 no freeze, 1 disagreement, 2 no reveal or the stake changed in the round.
    pub freeze: Vec<u8>,
    /// For each owner: its stake record was last changed by a freeze of Settlement.
    pub frozen: Vec<bool>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SnarkError {
    CommitsNotSorted,
    StakesMismatch,
    /// More entries than the circuit has room for.
    Capacity,
    /// A value outside the range the circuit supports.
    Range,
    /// A signature the circuit cannot take (see `super::verify`).
    BadSignature,
}

pub fn reveal_hash(r: &Reveal) -> Fr {
    let (oh, ol) = halves(&r.overlay);
    let (hh, hl) = halves(&r.hash);
    let (nh, nl) = halves(&r.nonce);
    mimc(&[oh, ol, u(r.depth as u64), hh, hl, nh, nl])
}

/// The message a node signs with its game key for a commit.
pub fn commit_message(chain_id: u64, settlement: &Address, round: u64, obf: Fr) -> Fr {
    mimc(&[commit_domain(), u(chain_id), addr(settlement), u(round), obf])
}

pub fn commit_leaf(c: &SignedCommit) -> Fr {
    mimc(&[addr(&c.owner), c.obf, c.sig.r.x, c.sig.r.y, c.sig.s])
}

/// The hash chain of `Settlement.forceCommit`.
pub fn forced_commits_hash(forced: &[ForcedCommit]) -> Fr {
    forced.iter().fold(U256::ZERO, |acc, c| {
        compress(
            acc,
            compress(addr(&c.owner), U256::from_be_bytes(c.obfuscated_hash.0)),
        )
    })
}

/// The hash chain of `Settlement.forceReveal`.
pub fn forced_reveals_hash(forced: &[Reveal]) -> Fr {
    forced
        .iter()
        .fold(U256::ZERO, |acc, r| compress(acc, reveal_hash(r)))
}

/// `GameKeyRegistry.commitmentOf`. The element that a freeze changes is the last one, so the contract
/// computes only one compression again after a freeze.
pub fn stake_commitment(s: &Stake) -> Fr {
    let (oh, ol) = halves(&s.overlay);
    mimc(&[
        addr(&s.owner),
        oh,
        ol,
        s.key.x,
        s.key.y,
        (s.committed_stake << STAKE_BITS) | s.potential_stake,
        (U256::from(s.height) << 64) | U256::from(s.last_updated),
    ])
}

fn low_bits(x: Fr, n: usize) -> U256 {
    x & ((U256::from(1u8) << n) - U256::from(1u8))
}

/// The selection seed as a field element: its low 253 bits.
pub fn seed_field(seed: &B256) -> Fr {
    low_bits(U256::from_be_bytes(seed.0), 253)
}

/// The top 64 bits of the round anchor: what the proximity check of the circuit reads.
pub fn anchor64(anchor: &B256) -> Fr {
    U256::from_be_bytes(anchor.0) >> 192
}

fn draw(seed: &B256, tag: u64, n: u64) -> U256 {
    low_bits(mimc(&[seed_field(seed), u(tag), u(n)]), DRAW_BITS)
}

fn picked(random: U256, sum: U256, density: U256) -> bool {
    random * sum < (density << DRAW_BITS)
}

fn is_eligible(s: &Stake, round: u64, age_rounds: u8) -> bool {
    let round_start = round * ROUND_LENGTH;
    let cutoff = age_rounds as u64 * ROUND_LENGTH;
    s.last_updated != 0 && round_start >= cutoff && s.last_updated < round_start - cutoff
}

fn valid_reveal(
    input: &RoundInput,
    s: &Stake,
    obf: Fr,
    r: &Reveal,
    min_depth: u8,
) -> Option<(u8, B256, U256)> {
    if r.depth < min_depth || r.depth < s.height || s.height > MAX_HEIGHT {
        return None;
    }
    let responsibility = r.depth - s.height;
    if responsibility > MAX_RESPONSIBILITY || reveal_hash(r) != obf {
        return None;
    }
    if !in_proximity(s.overlay, input.round_anchor, responsibility) {
        return None;
    }
    let committed =
        (U256::from(1u8) << s.height as usize) * s.committed_stake * U256::from(input.stake_price);
    let density = committed.min(s.potential_stake) << responsibility as usize;
    Some((r.depth, r.hash, density))
}

struct Entry {
    slot: usize,
    revealed: Option<(u8, B256, U256)>,
}

/// Run one round.
pub fn run(input: &RoundInput) -> Result<PublicValues, SnarkError> {
    let (nc, nf) = (input.commits.len(), input.forced_commits.len());
    for w in input.commits.windows(2) {
        if w[0].owner >= w[1].owner {
            return Err(SnarkError::CommitsNotSorted);
        }
    }
    let owners: Vec<Address> = input
        .commits
        .iter()
        .map(|c| c.owner)
        .chain(input.forced_commits.iter().map(|c| c.owner))
        .collect();
    if input.stakes.len() != nc + nf || input.stakes.iter().zip(&owners).any(|(s, o)| s.owner != *o)
    {
        return Err(SnarkError::StakesMismatch);
    }
    let max_stake = U256::from(1u8) << STAKE_BITS;
    for s in &input.stakes {
        if s.committed_stake >= max_stake || s.potential_stake >= max_stake {
            return Err(SnarkError::Range);
        }
    }

    // Which entries play: an anchored commit with a good signature; a forced commit whose owner does
    // not play already.
    let mut active = vec![false; nc + nf];
    let mut obfs = vec![U256::ZERO; nc + nf];
    for (i, c) in input.commits.iter().enumerate() {
        let key = input.stakes[i].key;
        let msg = commit_message(input.chain_id, &input.settlement, input.round, c.obf);
        active[i] = if key.is_zero() {
            // No game key: the circuit checks the signature with the base point as the key.
            verify(&base(), msg, &c.sig).ok_or(SnarkError::BadSignature)?;
            false
        } else {
            verify(&key, msg, &c.sig).ok_or(SnarkError::BadSignature)?
        };
        if c.obf >= P {
            return Err(SnarkError::Range);
        }
        obfs[i] = c.obf;
    }
    for (j, f) in input.forced_commits.iter().enumerate() {
        let k = nc + j;
        active[k] = !(0..k).any(|q| active[q] && owners[q] == f.owner);
        obfs[k] = U256::from_be_bytes(f.obfuscated_hash.0);
        if obfs[k] >= P {
            return Err(SnarkError::Range);
        }
    }

    let min_depth = minimum_depth(input.round, input.last_claim_round, input.last_winner_depth);
    let round_start = input.round * ROUND_LENGTH;
    let mut entries: Vec<Entry> = Vec::new();
    let mut freeze = vec![0u8; nc + nf];
    let mut left: Vec<usize> = Vec::new();
    for k in 0..nc + nf {
        if !active[k] {
            continue;
        }
        let s = &input.stakes[k];
        if !is_eligible(s, input.round, input.stake_age_rounds) {
            if s.last_updated >= round_start && !s.frozen {
                left.push(k);
            }
            continue;
        }
        let revealed = input
            .reveals
            .iter()
            .chain(&input.forced_reveals)
            .filter(|r| r.overlay == s.overlay)
            .find_map(|r| valid_reveal(input, s, obfs[k], r, min_depth));
        entries.push(Entry { slot: k, revealed });
    }

    let mut pv = PublicValues {
        chain_id: input.chain_id,
        settlement: input.settlement,
        round: input.round,
        round_anchor: input.round_anchor,
        selection_seed: input.selection_seed,
        commits_root: list_root(&input.commits.iter().map(commit_leaf).collect::<Vec<_>>()),
        commit_count: nc as u32,
        reveals_root: list_root(&input.reveals.iter().map(reveal_hash).collect::<Vec<_>>()),
        reveal_count: input.reveals.len() as u32,
        forced_commits_hash: forced_commits_hash(&input.forced_commits),
        forced_commit_count: nf as u32,
        forced_reveals_hash: forced_reveals_hash(&input.forced_reveals),
        forced_reveal_count: input.forced_reveals.len() as u32,
        last_claim_round: input.last_claim_round,
        last_winner_depth: input.last_winner_depth,
        penalty_multiplier_disagreement: input.penalty_multiplier_disagreement,
        penalty_multiplier_non_revealed: input.penalty_multiplier_non_revealed,
        penalty_random_factor: input.penalty_random_factor,
        stake_age_rounds: input.stake_age_rounds,
        stake_price: input.stake_price,
        has_reveals: false,
        truth_hash: B256::ZERO,
        truth_depth: 0,
        winner: Address::ZERO,
        redundancy: 0,
        fee_recipient: input.fee_recipient,
        owners,
        stake_commitments: input.stakes.iter().map(stake_commitment).collect(),
        frozen: input.stakes.iter().map(|s| s.frozen).collect(),
        freeze: vec![0u8; nc + nf],
    };
    if entries.iter().all(|e| e.revealed.is_none()) {
        return Ok(pv);
    }
    pv.has_reveals = true;

    // getCurrentTruth
    let seed = &input.selection_seed;
    let mut sum = U256::ZERO;
    let (mut truth_hash, mut truth_depth) = (B256::ZERO, 0u8);
    for (i, e) in entries.iter().enumerate() {
        if let Some((depth, hash, density)) = e.revealed {
            sum += density;
            if picked(draw(seed, 0, i as u64), sum, density) {
                truth_hash = hash;
                truth_depth = depth;
            }
        }
    }

    // winnerSelection
    let lottery = low_bits(mimc(&[seed_field(seed), u(2)]), 64) % U256::from(100u8)
        < U256::from(input.penalty_random_factor);
    let mut sum = U256::ZERO;
    let mut redundancy: u64 = 0;
    for e in &entries {
        match e.revealed {
            Some((depth, hash, density)) if hash == truth_hash && depth == truth_depth => {
                sum += density;
                if picked(draw(seed, 1, redundancy), sum, density) {
                    pv.winner = pv.owners[e.slot];
                }
                redundancy += 1;
            }
            Some(_) => {
                if lottery {
                    freeze[e.slot] = 1;
                }
            }
            None => freeze[e.slot] = 2,
        }
    }
    for k in left {
        freeze[k] = 2;
    }
    pv.truth_hash = truth_hash;
    pv.truth_depth = truth_depth;
    pv.redundancy = redundancy as u16;
    pv.freeze = freeze;
    Ok(pv)
}

impl PublicValues {
    /// The public inputs of the game circuit, as `Settlement._gameInputs` builds them (see
    /// `GameCircuit` in prover/snark/circuit/game.go).
    pub fn game_inputs(&self, caps: &Caps) -> Vec<Fr> {
        let (nc, nf) = (self.commit_count as usize, self.forced_commit_count as usize);
        let sh = |x: U256, n: usize| x << n;
        let mut v = vec![
            sh(u(self.chain_id), 160) | addr(&self.settlement),
            sh(u(self.round), 160)
                | sh(u(self.last_claim_round), 96)
                | sh(u(self.commit_count as u64), 80)
                | sh(u(self.reveal_count as u64), 64)
                | sh(u(self.forced_commit_count as u64), 48)
                | sh(u(self.forced_reveal_count as u64), 32)
                | u(self.stake_price as u64),
            sh(u(self.last_winner_depth as u64), 217)
                | sh(u(self.penalty_multiplier_disagreement as u64), 209)
                | sh(u(self.penalty_multiplier_non_revealed as u64), 201)
                | sh(u(self.penalty_random_factor as u64), 193)
                | sh(u(self.stake_age_rounds as u64), 185)
                | sh(u(self.has_reveals as u64), 184)
                | sh(u(self.truth_depth as u64), 176)
                | sh(u(self.redundancy as u64), 160)
                | addr(&self.winner),
            seed_field(&self.selection_seed),
            sh(anchor64(&self.round_anchor), 160) | addr(&self.fee_recipient),
            self.commits_root,
            self.reveals_root,
            self.forced_commits_hash,
            self.forced_reveals_hash,
        ];
        let (th, tl) = halves(&self.truth_hash);
        v.push(th);
        v.push(tl);
        // Slot k of the circuit holds entry k: the anchored commits, then the forced commits.
        let slot = |k: usize| (k < nc + nf).then_some(k);
        let mut freeze = U256::ZERO;
        for k in 0..caps.p {
            if let Some(i) = slot(k) {
                freeze |= sh(u(self.freeze[i] as u64), 2 * k);
                if self.frozen[i] {
                    freeze |= sh(u(1), 128 + k);
                }
            }
        }
        v.push(freeze);
        for k in 0..caps.p {
            v.push(slot(k).map_or(U256::ZERO, |i| self.stake_commitments[i]));
        }
        v
    }
}

// ---------------------------------------------------------------------------------------------------
// The circuit witness, as JSON for `snarkd prove`
// ---------------------------------------------------------------------------------------------------

fn d(x: Fr) -> Value {
    Value::String(x.to_string())
}

fn reveal_json(r: Option<&Reveal>) -> Value {
    match r {
        Some(r) => {
            let (oh, ol) = halves(&r.overlay);
            let (hh, hl) = halves(&r.hash);
            let (nh, nl) = halves(&r.nonce);
            json!([d(oh), d(ol), d(u(r.depth as u64)), d(hh), d(hl), d(nh), d(nl)])
        }
        None => json!(["0", "0", "0", "0", "0", "0", "0"]),
    }
}

/// The inputs of the game circuit for this round, padded to `caps`.
pub fn game_witness_json(input: &RoundInput, pv: &PublicValues, caps: &Caps) -> Result<Value, SnarkError> {
    let (nc, nf) = (input.commits.len(), input.forced_commits.len());
    let (rc, frc) = (input.reveals.len(), input.forced_reveals.len());
    if nc + nf > caps.p || rc + frc > caps.p {
        return Err(SnarkError::Capacity);
    }
    let g: Vec<Value> = [
        u(input.chain_id),
        addr(&input.settlement),
        u(input.round),
        u(nc as u64),
        u(input.reveals.len() as u64),
        u(nf as u64),
        u(input.forced_reveals.len() as u64),
        u(input.last_claim_round),
        u(input.last_winner_depth as u64),
        u(input.penalty_multiplier_disagreement as u64),
        u(input.penalty_multiplier_non_revealed as u64),
        u(input.penalty_random_factor as u64),
        u(input.stake_age_rounds as u64),
        u(input.stake_price as u64),
        addr(&input.fee_recipient),
    ]
    .iter()
    .map(|x| d(*x))
    .collect();

    // Slots: the anchored commits, then the forced commits (with the padding signature, which the
    // circuit does not use for them), then empty slots.
    let pad = || json!(["0", "0", d(base().x), d(base().y), "1"]);
    let commits: Vec<Value> = (0..caps.p)
        .map(|i| {
            if let Some(c) = input.commits.get(i) {
                json!([d(addr(&c.owner)), d(c.obf), d(c.sig.r.x), d(c.sig.r.y), d(c.sig.s)])
            } else if let Some(c) = i.checked_sub(nc).and_then(|j| input.forced_commits.get(j)) {
                json!([d(addr(&c.owner)), d(U256::from_be_bytes(c.obfuscated_hash.0)), d(base().x), d(base().y), "1"])
            } else {
                pad()
            }
        })
        .collect();
    let stake = |k: Option<usize>| match k {
        Some(k) => {
            let s = &input.stakes[k];
            let (oh, ol) = halves(&s.overlay);
            json!([
                d(oh),
                d(ol),
                d(s.committed_stake),
                d(s.potential_stake),
                d(u(s.height as u64)),
                d(u(s.last_updated)),
                d(s.key.x),
                d(s.key.y)
            ])
        }
        None => json!(["0", "0", "0", "0", "0", "0", "0", "0"]),
    };
    let stakes: Vec<Value> = (0..caps.p).map(|i| stake((i < nc + nf).then_some(i))).collect();
    let frozen_of = |k: Option<usize>| d(u(k.is_some_and(|k| input.stakes[k].frozen) as u64));
    let frozen: Vec<Value> = (0..caps.p).map(|i| frozen_of((i < nc + nf).then_some(i))).collect();
    let reveals: Vec<Value> = (0..caps.p)
        .map(|i| reveal_json(input.reveals.get(i).or_else(|| i.checked_sub(rc).and_then(|j| input.forced_reveals.get(j)))))
        .collect();

    Ok(json!({
        "kind": "game",
        "caps": {"p": caps.p},
        "public": pv.game_inputs(caps).iter().map(|x| d(*x)).collect::<Vec<_>>(),
        "g": g,
        "seed": d(seed_field(&input.selection_seed)),
        "anchor64": d(anchor64(&input.round_anchor)),
        "commits": commits,
        "stakes": stakes,
        "frozen": frozen,
        "reveals": reveals,
    }))
}

/// Obfuscated hash of a reveal as the 32 bytes that `forceCommit` takes.
pub fn obfuscated_bytes(r: &Reveal) -> B256 {
    fr_bytes(reveal_hash(r))
}
