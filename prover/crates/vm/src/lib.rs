//! Swarm Redistribution VM.
//!
//! The storage incentives Schelling game of `src/Redistribution.sol` (master) as a pure function:
//! `run(RoundInput) -> PublicValues`. The same code runs natively in the prover service and inside the
//! SP1 zkVM (`program/`), and `src/settlement/Settlement.sol` executes its output.
//!
//! Rules are ported one to one from Redistribution.sol. Where the venue forces a difference (no
//! transactions, so no `msg.sender` and no transaction order) the replacement rule is documented on the
//! function and in docs/ZK-SETTLEMENT.md, section "Rule differences".
//!
//! `claim`'s storage evidence (chunk inclusion proofs, postage stamps, SOC signatures, reserve size
//! estimate) is checked in `claim.rs`. A round with a truth but no valid witness is "unclaimed": like a
//! reverted `claim`, it pays nothing, freezes nobody and leaves the price alone.

pub mod bmt;
pub mod claim;
pub mod postage;
pub mod sample;
mod types;

pub use types::*;

use alloy_primitives::{keccak256, Address, Signature, B256, U256};

/// Blocks in a round. 64 x 12 s (Ethereum) is about the 760 s of the Gnosis round (152 x 5 s).
pub const ROUND_LENGTH: u64 = 64;
/// The seed block of a round, from its start (Settlement.SEED_OFFSET).
pub const SEED_OFFSET: u64 = 48;

/// `MAX_H` of Redistribution.sol: the low 128 bits.
const MAX_H_PLUS_ONE: U256 = U256::from_limbs([0, 0, 1, 0]);

#[derive(Debug, PartialEq, Eq)]
pub enum VmError {
    /// Anchored commits are not sorted by owner or contain a duplicate owner.
    CommitsNotSorted,
    /// `stakes` does not list exactly the participants, in canonical order.
    StakesMismatch,
    /// Arithmetic overflow where Solidity would have reverted.
    Overflow,
    /// Postage event replay failed.
    Postage(postage::PostageError),
}

/// keccak256("SwarmSettlementCommit(uint256 chainId,address settlement,uint64 round,bytes32 obfuscatedHash)")
pub fn commit_typehash() -> B256 {
    keccak256(b"SwarmSettlementCommit(uint256 chainId,address settlement,uint64 round,bytes32 obfuscatedHash)")
}

/// `Settlement.commitDigest`: abi.encode(TYPEHASH, chainId, settlement, round, obfuscatedHash).
pub fn commit_digest(
    chain_id: U256,
    settlement: Address,
    round: u64,
    obfuscated_hash: B256,
) -> B256 {
    let mut buf = [0u8; 160];
    buf[0..32].copy_from_slice(commit_typehash().as_slice());
    buf[32..64].copy_from_slice(&chain_id.to_be_bytes::<32>());
    buf[76..96].copy_from_slice(settlement.as_slice());
    buf[120..128].copy_from_slice(&round.to_be_bytes());
    buf[128..160].copy_from_slice(obfuscated_hash.as_slice());
    keccak256(buf)
}

/// EIP-191 personal_sign hash of a 32-byte digest.
pub fn eth_signed_message_hash(digest: B256) -> B256 {
    let mut buf = [0u8; 60];
    buf[..28].copy_from_slice(b"\x19Ethereum Signed Message:\n32");
    buf[28..].copy_from_slice(digest.as_slice());
    keccak256(buf)
}

/// `Redistribution.wrapCommit`: keccak256(abi.encodePacked(overlay, depth, hash, nonce)).
pub fn wrap_commit(overlay: B256, depth: u8, hash: B256, nonce: B256) -> B256 {
    let mut buf = [0u8; 97];
    buf[0..32].copy_from_slice(overlay.as_slice());
    buf[32] = depth;
    buf[33..65].copy_from_slice(hash.as_slice());
    buf[65..97].copy_from_slice(nonce.as_slice());
    keccak256(buf)
}

/// `Redistribution.inProximity`.
pub fn in_proximity(a: B256, b: B256, minimum: u8) -> bool {
    if minimum == 0 {
        return true;
    }
    let x = U256::from_be_bytes((a ^ b).0);
    x < (U256::from(1u8) << (256 - minimum as usize))
}

/// keccak256(abi.encodePacked(owner, obfuscatedHash, ...)) over the anchored list, as passed to
/// `Settlement.anchorRound`.
pub fn commits_hash<'a>(commits: impl IntoIterator<Item = (&'a Address, &'a B256)>) -> B256 {
    let mut buf = Vec::new();
    for (owner, obf) in commits {
        buf.extend_from_slice(owner.as_slice());
        buf.extend_from_slice(obf.as_slice());
    }
    keccak256(buf)
}

/// keccak256(abi.encodePacked(overlay, depth, hash, nonce, ...)) over the anchored reveal list, as passed
/// to `Settlement.anchorReveals`. Zero for an empty list, which is also what Settlement holds when the
/// prover did not anchor reveals.
pub fn reveals_hash(reveals: &[Reveal]) -> B256 {
    if reveals.is_empty() {
        return B256::ZERO;
    }
    let mut buf = Vec::with_capacity(reveals.len() * 97);
    for r in reveals {
        buf.extend_from_slice(r.overlay.as_slice());
        buf.push(r.depth);
        buf.extend_from_slice(r.hash.as_slice());
        buf.extend_from_slice(r.nonce.as_slice());
    }
    keccak256(buf)
}

/// The hash chain `Settlement.forceCommit` keeps.
pub fn forced_commits_hash(forced: &[ForcedCommit]) -> B256 {
    forced.iter().fold(B256::ZERO, |acc, c| {
        let mut buf = [0u8; 84];
        buf[..32].copy_from_slice(acc.as_slice());
        buf[32..52].copy_from_slice(c.owner.as_slice());
        buf[52..].copy_from_slice(c.obfuscated_hash.as_slice());
        keccak256(buf)
    })
}

/// The hash chain `Settlement.forceReveal` keeps.
pub fn forced_reveals_hash(forced: &[Reveal]) -> B256 {
    forced.iter().fold(B256::ZERO, |acc, r| {
        let mut buf = [0u8; 129];
        buf[..32].copy_from_slice(acc.as_slice());
        buf[32..64].copy_from_slice(r.overlay.as_slice());
        buf[64] = r.depth;
        buf[65..97].copy_from_slice(r.hash.as_slice());
        buf[97..].copy_from_slice(r.nonce.as_slice());
        keccak256(buf)
    })
}

/// The hash chain `Settlement.stakeDigest` computes from StakeRegistry.stakes.
pub fn stake_digest(stakes: &[StakeRecord]) -> B256 {
    stakes.iter().fold(B256::ZERO, |acc, s| {
        let mut buf = [0u8; 32 + 20 + 32 + 32 + 32 + 1 + 32];
        buf[..32].copy_from_slice(acc.as_slice());
        buf[32..52].copy_from_slice(s.owner.as_slice());
        buf[52..84].copy_from_slice(s.overlay.as_slice());
        buf[84..116].copy_from_slice(&s.committed_stake.to_be_bytes::<32>());
        buf[116..148].copy_from_slice(&s.potential_stake.to_be_bytes::<32>());
        buf[148] = s.height;
        buf[149..].copy_from_slice(&s.last_updated.to_be_bytes::<32>());
        keccak256(buf)
    })
}

/// `StakeRegistry.calculateEffectiveStake`: min(2^height * committedStake * price, potentialStake).
/// `None` where Solidity would overflow and revert.
pub fn effective_stake(s: &StakeRecord, price: u32) -> Option<U256> {
    let committed_bzz = (U256::from(1u8) << s.height as usize)
        .checked_mul(s.committed_stake)?
        .checked_mul(U256::from(price))?;
    Some(committed_bzz.min(s.potential_stake))
}

/// Recover the signer of an off-chain commit. `None` on a malformed signature.
pub fn recover_commit_signer(input: &RoundInput, c: &SignedCommit) -> Option<Address> {
    let sig = Signature::try_from(c.signature.as_ref()).ok()?;
    let digest = commit_digest(
        input.chain_id,
        input.settlement,
        input.round,
        c.obfuscated_hash,
    );
    sig.recover_address_from_prehash(&eth_signed_message_hash(digest))
        .ok()
}

/// The canonical commit list of a round: anchored commits with a valid signature (sorted by owner),
/// then forced commits in chain order whose owner is not already present.
///
/// Replaces transaction order in Redistribution.sol, where `currentCommits` is in inclusion order.
/// An anchored commit with a bad signature is dropped rather than failing the round, so a prover that
/// anchored garbage cannot make the round unprovable.
pub fn canonical_commits(input: &RoundInput) -> Result<Vec<(Address, B256)>, VmError> {
    for w in input.commits.windows(2) {
        if w[0].owner >= w[1].owner {
            return Err(VmError::CommitsNotSorted);
        }
    }
    let mut out: Vec<(Address, B256)> = Vec::new();
    for c in &input.commits {
        if recover_commit_signer(input, c) == Some(c.owner) {
            out.push((c.owner, c.obfuscated_hash));
        }
    }
    for f in &input.forced_commits {
        if !out.iter().any(|(o, _)| *o == f.owner) {
            out.push((f.owner, f.obfuscated_hash));
        }
    }
    Ok(out)
}

/// `Redistribution.currentMinimumDepth`, with currentCommitRound = round and currentClaimRound =
/// lastClaimRound.
pub fn minimum_depth(round: u64, last_claim_round: u64, last_winner_depth: u8) -> u8 {
    let difference = round.saturating_sub(last_claim_round);
    let skipped = (if difference > 254 {
        254
    } else {
        difference as u8
    }) + 1;
    if skipped >= last_winner_depth {
        0
    } else {
        last_winner_depth - skipped
    }
}

/// Redistribution.sol's `commit` rejects a node whose stake changed in the last two rounds. Here the
/// check is against the round start, and against the record read at settlement time, so a stake change
/// (or a freeze, which moves lastUpdated into the future) after the round started also disqualifies.
/// `age_rounds` is Settlement.stakeAgeRounds (2 as on master; 0 on test networks: the stake must only
/// exist before the round starts).
pub fn is_eligible(stake: &StakeRecord, round: u64, age_rounds: u8) -> bool {
    let round_start = round * ROUND_LENGTH;
    let cutoff = age_rounds as u64 * ROUND_LENGTH;
    !stake.last_updated.is_zero()
        && round_start >= cutoff
        && stake.last_updated < U256::from(round_start - cutoff)
}

/// keccak256(abi.encodePacked(seed, tag, n)): the random numbers of getCurrentTruth ("0") and
/// winnerSelection ("1").
fn draw(seed: B256, tag: u8, n: u64) -> U256 {
    let mut buf = [0u8; 65];
    buf[..32].copy_from_slice(seed.as_slice());
    buf[32] = tag;
    buf[33..].copy_from_slice(&U256::from(n).to_be_bytes::<32>());
    let r = U256::from_be_bytes(keccak256(buf).0);
    r & (MAX_H_PLUS_ONE - U256::from(1u8))
}

/// `randomNumberTrunc * sum < stakeDensity * (MAX_H + 1)`, with Solidity's checked arithmetic.
fn picked(random: U256, sum: U256, density: U256) -> Result<bool, VmError> {
    let lhs = random.checked_mul(sum).ok_or(VmError::Overflow)?;
    let rhs = density
        .checked_mul(MAX_H_PLUS_ONE)
        .ok_or(VmError::Overflow)?;
    Ok(lhs < rhs)
}

struct Entry {
    owner: Address,
    overlay: B256,
    revealed: Option<(u8, B256, U256)>, // depth, hash, stakeDensity
}

/// Run one round.
pub fn run(input: &RoundInput) -> Result<PublicValues, VmError> {
    let commits = canonical_commits(input)?;

    if input.stakes.len() != commits.len()
        || input
            .stakes
            .iter()
            .zip(&commits)
            .any(|(s, (o, _))| s.owner != *o)
    {
        return Err(VmError::StakesMismatch);
    }

    let min_depth = minimum_depth(input.round, input.last_claim_round, input.last_winner_depth);

    // Postage accounting since the previous settlement: replay the event log, credit the pot, expire.
    let seed_block = input.round * ROUND_LENGTH + SEED_OFFSET;
    let pg = postage::apply(&input.postage, seed_block).map_err(VmError::Postage)?;

    // Commit + reveal phases. Ineligible nodes are dropped like a reverted `commit`.
    let mut entries: Vec<Entry> = Vec::new();
    for ((owner, obf), stake) in commits.iter().zip(&input.stakes) {
        if !is_eligible(stake, input.round, input.stake_age_rounds) {
            continue;
        }
        let revealed = input
            .reveals
            .iter()
            .chain(&input.forced_reveals)
            .filter(|r| r.overlay == stake.overlay)
            .find_map(|r| valid_reveal(input, stake, *obf, r, min_depth));
        entries.push(Entry {
            owner: *owner,
            overlay: stake.overlay,
            revealed,
        });
    }

    let inputs = PublicInputs {
        chainId: input.chain_id,
        settlement: input.settlement,
        round: input.round,
        roundAnchor: input.round_anchor,
        selectionSeed: input.selection_seed,
        commitsHash: commits_hash(input.commits.iter().map(|c| (&c.owner, &c.obfuscated_hash))),
        commitCount: input.commits.len() as u32,
        revealsHash: reveals_hash(&input.reveals),
        revealCount: input.reveals.len() as u32,
        forcedCommitsHash: forced_commits_hash(&input.forced_commits),
        forcedRevealsHash: forced_reveals_hash(&input.forced_reveals),
        lastClaimRound: input.last_claim_round,
        lastWinnerDepth: input.last_winner_depth,
        penaltyMultiplierDisagreement: input.penalty_multiplier_disagreement,
        penaltyMultiplierNonRevealed: input.penalty_multiplier_non_revealed,
        penaltyRandomFactor: input.penalty_random_factor,
        stakeAgeRounds: input.stake_age_rounds,
        participants: commits.iter().map(|(o, _)| *o).collect(),
        stakeDigest: stake_digest(&input.stakes),
        stakePrice: input.stake_price,
        forcedClaimsHash: claim::forced_claims_hash(&input.forced_claims),
        sampleMaxValue: input.sample_max_value,
        postage: PostageInputs {
            prevStateHash: input.postage.state.hash(),
            prevEventIndex: input.postage.prev_event_index,
            prevEventHash: input.postage.prev_event_hash,
            eventIndex: pg.event_index,
            eventHash: pg.event_hash,
            cutBlock: input.postage.cut_block,
        },
    };
    let mut out = Outcome {
        hasTruth: false,
        truthHash: B256::ZERO,
        truthDepth: 0,
        winner: Address::ZERO,
        winnerOverlay: B256::ZERO,
        winnerStakeDensity: U256::ZERO,
        redundancy: 0,
        freezeOwners: vec![],
        freezeDurations: vec![],
        unclaimed: false,
        postage: PostageOutcome {
            newStateHash: pg.new_state.hash(),
            potAmount: pg.pot,
            validChunkCount: pg.valid_chunk_count,
        },
    };

    // Redistribution.sol cannot be claimed without reveals; nothing happens.
    if entries.iter().all(|e| e.revealed.is_none()) {
        return Ok(PublicValues {
            inputs,
            outcome: out,
        });
    }

    // getCurrentTruth.
    let seed = input.selection_seed;
    let mut sum = U256::ZERO;
    let (mut truth_hash, mut truth_depth) = (B256::ZERO, 0u8);
    for (i, e) in entries.iter().enumerate() {
        if let Some((depth, hash, density)) = e.revealed {
            sum = sum.checked_add(density).ok_or(VmError::Overflow)?;
            if picked(draw(seed, b'0', i as u64), sum, density)? {
                truth_hash = hash;
                truth_depth = depth;
            }
        }
    }

    // winnerSelection.
    let freeze_unit = U256::from(ROUND_LENGTH)
        .checked_mul(
            U256::from(1u8)
                .checked_shl(truth_depth as usize)
                .ok_or(VmError::Overflow)?,
        )
        .ok_or(VmError::Overflow)?;
    let freeze_disagreement = U256::from(input.penalty_multiplier_disagreement)
        .checked_mul(freeze_unit)
        .ok_or(VmError::Overflow)?;
    let freeze_non_revealed = U256::from(input.penalty_multiplier_non_revealed)
        .checked_mul(freeze_unit)
        .ok_or(VmError::Overflow)?;
    let freeze_lottery = freeze_random(seed) < U256::from(input.penalty_random_factor);

    let mut sum = U256::ZERO;
    let mut redundancy: u64 = 0;
    for e in &entries {
        match e.revealed {
            Some((depth, hash, density)) if hash == truth_hash && depth == truth_depth => {
                sum = sum.checked_add(density).ok_or(VmError::Overflow)?;
                if picked(draw(seed, b'1', redundancy), sum, density)? {
                    out.winner = e.owner;
                    out.winnerOverlay = e.overlay;
                    out.winnerStakeDensity = density;
                }
                redundancy += 1;
            }
            Some(_) => {
                if freeze_lottery {
                    out.freezeOwners.push(e.owner);
                    out.freezeDurations.push(freeze_disagreement);
                }
            }
            None => {
                out.freezeOwners.push(e.owner);
                out.freezeDurations.push(freeze_non_revealed);
            }
        }
    }

    out.truthHash = truth_hash;
    out.truthDepth = truth_depth;
    out.redundancy = redundancy as u16; // uint16(redundancyCount), truncating like Solidity

    // claim: the storage evidence for the truth's sample. Like a reverted claim, a round without a valid
    // witness changes nothing on chain. Batches come from the replayed postage state: a batch is alive
    // when its normalisedBalance is above the outpayment at the seed block.
    let batches = claim_batches(input, &pg);
    let ctx = claim::ClaimContext {
        anchor: input.round_anchor,
        seed,
        sample_hash: truth_hash,
        depth: truth_depth,
        batches: &batches,
        sample_max_value: input.sample_max_value,
    };
    if claim_candidates(input).any(|w| claim::verify_claim(&w, &ctx).is_ok()) {
        out.hasTruth = true;
    } else {
        out.unclaimed = true;
        out.freezeOwners.clear();
        out.freezeDurations.clear();
    }
    Ok(PublicValues {
        inputs,
        outcome: out,
    })
}

/// Claim witnesses in the order they are tried: the off-chain one, then forced ones in chain order.
/// Bytes that do not decode are skipped. The payout always goes to the selected winner, so any node
/// that holds the truth's sample can supply the witness.
pub fn claim_candidates(input: &RoundInput) -> impl Iterator<Item = claim::ClaimWitness> + '_ {
    input
        .claim
        .iter()
        .chain(&input.forced_claims)
        .filter_map(|b| claim::ClaimWitness::decode(b))
}

/// `claim_batches` for callers outside `run` (the prover explains why a witness was rejected).
pub fn claim_batch_records(input: &RoundInput) -> Result<Vec<claim::BatchRecord>, VmError> {
    let pg = postage::apply(&input.postage, input.round * ROUND_LENGTH + SEED_OFFSET)
        .map_err(VmError::Postage)?;
    Ok(claim_batches(input, &pg))
}

/// The batches the candidate witnesses reference, as the claim checks see them: from the postage state
/// after this settlement's events, with owner zero for an expired batch (Redistribution's "batch does
/// not exist or expired"). The prover cannot hide a batch: the state is bound by its hash.
fn claim_batches(input: &RoundInput, pg: &postage::PostageRun) -> Vec<claim::BatchRecord> {
    let mut out: Vec<claim::BatchRecord> = Vec::new();
    for w in claim_candidates(input) {
        for id in w.batch_ids() {
            if out.iter().any(|b| b.batch_id == id) {
                continue;
            }
            if let Some(b) = pg.before_cut.batch(&id) {
                let alive = b.normalised_balance > pg.outpayment_at_probe;
                out.push(claim::BatchRecord {
                    batch_id: id,
                    owner: if alive { b.owner } else { Address::ZERO },
                    depth: b.depth,
                    bucket_depth: b.bucket_depth,
                });
            }
        }
    }
    out
}

/// Checks of `Redistribution.reveal`. Returns (depth, hash, stakeDensity) when the reveal opens the
/// commit and the node is in proximity of the round anchor.
fn valid_reveal(
    input: &RoundInput,
    stake: &StakeRecord,
    obf: B256,
    r: &Reveal,
    min_depth: u8,
) -> Option<(u8, B256, U256)> {
    if r.depth < min_depth || r.depth < stake.height {
        return None;
    }
    if wrap_commit(stake.overlay, r.depth, r.hash, r.nonce) != obf {
        return None;
    }
    let responsibility = r.depth - stake.height;
    if !in_proximity(stake.overlay, input.round_anchor, responsibility) {
        return None;
    }
    // Eligible nodes are not frozen at round start, so this is nodeEffectiveStake as of the round.
    let density = effective_stake(stake, input.stake_price)?
        .checked_mul(U256::from(1u8) << responsibility as usize)?;
    Some((r.depth, r.hash, density))
}

/// Replaces `block.prevrandao % 100` of the disagreement freeze: keccak256(seed, "2") % 100.
fn freeze_random(seed: B256) -> U256 {
    let mut buf = [0u8; 33];
    buf[..32].copy_from_slice(seed.as_slice());
    buf[32] = b'2';
    U256::from_be_bytes(keccak256(buf).0) % U256::from(100u8)
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod postage_tests;
