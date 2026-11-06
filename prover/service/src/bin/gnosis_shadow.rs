//! gnosis-shadow: replay real Gnosis Chain Redistribution rounds through the VM and compare the outcome
//! with what Redistribution.sol did (phase 2 of the migration, "shadow mode").
//!
//! For each round:
//! 1. Commits (`Committed` events and the `commit` calldata, in chain order) become forced commits, and
//!    reveals (`Revealed` events and the `reveal` calldata) become forced reveals. Forced commits keep
//!    chain order, so the VM sees Redistribution's commit order.
//! 2. The stake of each node is the effective stake Redistribution took at `commit` (the `Revealed`
//!    event), so the VM computes the same stake densities.
//! 3. Redistribution's randomness replaces the VM's (`swarm_vm::shadow`): the round anchor
//!    (`CurrentRevealAnchor`), the seed after the first reveal (`keccak256(abi.encode(seed, prevrandao))`,
//!    from the header of the first-reveal block), the freeze lottery (`prevrandao % 100` of the claim
//!    block) and whether `claim` succeeded. The claim's storage proofs are not checked here.
//! 4. Compare the truth, the winner and the freezes with `TruthSelected`, `WinnerSelected` and
//!    `StakeFrozen` of the claim transaction. Freeze durations are compared in rounds (Gnosis rounds
//!    are 152 blocks, the VM's 64).
//!
//!   GNOSIS_RPC_URL=https://rpc.gnosischain.com ./target/release/gnosis-shadow --rounds 200

use alloy::{
    eips::BlockNumberOrTag,
    primitives::{address, keccak256, Address, B256, U256},
    providers::{DynProvider, Provider, ProviderBuilder},
    rpc::types::{Filter, Log},
    sol,
    sol_types::{SolCall, SolEvent, SolValue},
};
use anyhow::{bail, Context, Result};
use clap::Parser;
use std::collections::{BTreeMap, HashMap};
use swarm_vm::{
    postage::PostageState, randomness, shadow, ForcedCommit, Reveal, RoundInput, StakeRecord,
    ROUND_LENGTH, SEED_OFFSET,
};

sol! {
    struct GReveal { bytes32 overlay; address owner; uint8 depth; uint256 stake; uint256 stakeDensity; bytes32 hash; }
    event Committed(uint256 roundNumber, bytes32 overlay, uint8 height);
    event Revealed(uint256 roundNumber, bytes32 overlay, uint256 stake, uint256 stakeDensity, bytes32 reserveCommitment, uint8 depth);
    event CurrentRevealAnchor(uint256 roundNumber, bytes32 anchor);
    event TruthSelected(bytes32 hash, uint8 depth);
    event WinnerSelected(GReveal winner);
    event StakeFrozen(address frozen, bytes32 overlay, uint256 time);
    function commit(bytes32 _obfuscatedHash, uint64 _roundNumber);
    function reveal(uint8 _depth, bytes32 _hash, bytes32 _revealNonce);
}

const REDISTRIBUTION: Address = address!("5069cdfB3D9E56d23B1cAeE83CE6109A7E4fd62d");
const STAKE_REGISTRY: Address = address!("da2a16EE889E7F04980A8d597b48c8D51B9518F4");
/// Redistribution.sol's ROUND_LENGTH on Gnosis.
const G_ROUND: u64 = 152;
/// Rounds to look back for the last claim before the range (minimum depth state).
const LOOKBACK_ROUNDS: u64 = 600;

#[derive(Parser)]
struct Args {
    #[arg(long, env = "GNOSIS_RPC_URL")]
    rpc_url: String,
    /// Rounds to replay, ending with the last finished round.
    #[arg(long, default_value_t = 100)]
    rounds: u64,
    /// Last round to replay (default: the last finished round).
    #[arg(long)]
    to_round: Option<u64>,
    /// Blocks per eth_getLogs request.
    #[arg(long, default_value_t = 10_000)]
    chunk: u64,
    /// Negative control: give the VM a wrong selection seed. The truth or the winner must then differ in
    /// rounds where more than one node could be picked.
    #[arg(long)]
    wrong_seed: bool,
}

#[derive(Default)]
struct GRound {
    commits: Vec<Log>,
    reveals: Vec<Log>,
    anchor: Option<Log>,
    truth: Option<Log>,
    winner: Option<Log>,
    frozen: Vec<Log>,
}

#[derive(Default)]
struct Tally {
    compared: u64,
    equal: u64,
    no_claim: u64,
    skipped: u64,
    differ: Vec<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    // Public RPCs answer 429 when asked too fast: retry with backoff.
    let client = alloy::rpc::client::ClientBuilder::default()
        .layer(alloy::transports::layers::RetryBackoffLayer::new(
            20, 1000, 300,
        ))
        .http(args.rpc_url.parse()?);
    let p: DynProvider = ProviderBuilder::new().connect_client(client).erased();
    let head = p.get_block_number().await?;
    let to_round = args.to_round.unwrap_or(head / G_ROUND - 1);
    let from_round = to_round + 1 - args.rounds;

    // The penalty parameters are private: slot 8, bytes 24, 25 and 26 (deployment storage layout).
    let slot8 = p.get_storage_at(REDISTRIBUTION, U256::from(8u8)).await?;
    let byte = |k: usize| ((slot8 >> (8 * k)) & U256::from(0xffu8)).to::<u8>();
    let (pm_dis, pm_non, prf) = (byte(24), byte(25), byte(26));
    eprintln!(
        "rounds {from_round}..={to_round}; penalties: disagreement {pm_dis}, non-revealed {pm_non}, random factor {prf}"
    );

    // The last claim before the range: Redistribution's currentClaimRound and winner.depth.
    let mut last_claim_round = 0u64;
    let mut last_winner_depth = 0u8;
    let back = logs(
        &p,
        REDISTRIBUTION,
        vec![WinnerSelected::SIGNATURE_HASH],
        from_round.saturating_sub(LOOKBACK_ROUNDS) * G_ROUND,
        from_round * G_ROUND - 1,
        args.chunk,
    )
    .await?;
    if let Some(l) = back.last() {
        last_claim_round = l.block_number.unwrap() / G_ROUND;
        last_winner_depth = l.log_decode::<WinnerSelected>()?.inner.data.winner.depth;
    }
    eprintln!(
        "last claim before the range: round {last_claim_round}, winner depth {last_winner_depth}"
    );

    let mut rounds: BTreeMap<u64, GRound> = BTreeMap::new();
    let all = logs(
        &p,
        REDISTRIBUTION,
        vec![
            Committed::SIGNATURE_HASH,
            Revealed::SIGNATURE_HASH,
            CurrentRevealAnchor::SIGNATURE_HASH,
            TruthSelected::SIGNATURE_HASH,
            WinnerSelected::SIGNATURE_HASH,
        ],
        from_round * G_ROUND,
        (to_round + 1) * G_ROUND - 1,
        args.chunk,
    )
    .await?;
    let frozen = logs(
        &p,
        STAKE_REGISTRY,
        vec![StakeFrozen::SIGNATURE_HASH],
        from_round * G_ROUND,
        (to_round + 1) * G_ROUND - 1,
        args.chunk,
    )
    .await?;
    for l in all {
        let r = rounds.entry(l.block_number.unwrap() / G_ROUND).or_default();
        match *l.topic0().unwrap() {
            Committed::SIGNATURE_HASH => r.commits.push(l),
            Revealed::SIGNATURE_HASH => r.reveals.push(l),
            CurrentRevealAnchor::SIGNATURE_HASH => r.anchor = Some(l),
            TruthSelected::SIGNATURE_HASH => r.truth = Some(l),
            _ => r.winner = Some(l),
        }
    }
    let mut frozen_by_tx: HashMap<B256, Vec<Log>> = HashMap::new();
    for l in frozen {
        frozen_by_tx
            .entry(l.transaction_hash.unwrap())
            .or_default()
            .push(l);
    }
    for r in rounds.values_mut() {
        if let Some(t) = &r.truth {
            r.frozen = frozen_by_tx
                .remove(&t.transaction_hash.unwrap())
                .unwrap_or_default();
        }
    }

    // Redistribution's `seed` after the last round with reveals, and that round.
    let mut seed: Option<(u64, B256)> = None;
    let mut t = Tally::default();
    for (&round, g) in &rounds {
        let Some(anchor_log) = &g.anchor else {
            continue; // no reveals: nothing happens, the seed does not change
        };
        let anchor = anchor_log
            .log_decode::<CurrentRevealAnchor>()?
            .inner
            .data
            .anchor;
        // The seed before this round's first reveal. currentSeed() is the seed itself after a round with
        // reveals, else keccak256(abi.encodePacked(seed, difference)).
        let seed_before = match seed {
            Some((sr, s)) if sr + 1 == round => {
                if s != anchor {
                    bail!("round {round}: anchor {anchor} is not the seed {s} after round {sr}");
                }
                s
            }
            Some((sr, s)) => {
                let diff = U256::from(round - sr - 1);
                if keccak256((s, diff).abi_encode_packed()) != anchor {
                    bail!("round {round}: anchor does not follow from the seed after round {sr}");
                }
                s
            }
            // After a round with reveals, the anchor is the seed itself.
            None if rounds.get(&(round - 1)).is_some_and(|g| g.anchor.is_some()) => anchor,
            // The first round of the range: after a gap the anchor is keccak(seed, difference), and the
            // seed itself is unknown.
            None => {
                t.skipped += 1;
                eprintln!("round {round}: skipped (the seed before it is unknown)");
                continue;
            }
        };
        let seed_after = next_seed(&p, seed_before, anchor_log).await?;
        seed = Some((round, seed_after));

        let Some(truth_log) = &g.truth else {
            t.no_claim += 1;
            continue; // nobody claimed on Gnosis: no outcome to compare
        };
        let selection = if args.wrong_seed {
            keccak256(seed_after)
        } else {
            seed_after
        };
        let input = build_input(
            &p,
            round,
            g,
            anchor,
            selection,
            last_claim_round,
            last_winner_depth,
            (pm_dis, pm_non, prf),
        )
        .await
        .with_context(|| format!("round {round}"))?;
        let claim_block = p
            .get_block_by_number(BlockNumberOrTag::Number(truth_log.block_number.unwrap()))
            .await?
            .context("claim block")?;
        let freeze_random =
            (U256::from_be_bytes(claim_block.header.mix_hash.0) % U256::from(100u8)).to::<u8>();
        let pv = shadow::run(
            &input,
            shadow::Overrides {
                round_anchor: anchor,
                selection_seed: selection,
                freeze_random,
                claim_ok: true,
            },
        )
        .map_err(|e| anyhow::anyhow!("round {round}: vm: {e:?}"))?;
        let out = pv.outcome;

        let truth = truth_log.log_decode::<TruthSelected>()?.inner.data;
        let winner = g
            .winner
            .as_ref()
            .context("TruthSelected without WinnerSelected")?
            .log_decode::<WinnerSelected>()?
            .inner
            .data
            .winner;
        let mut g_frozen: Vec<(Address, u64)> = g
            .frozen
            .iter()
            .map(|l| {
                let e = l.log_decode::<StakeFrozen>().unwrap().inner.data;
                (e.frozen, (e.time / U256::from(G_ROUND)).to::<u64>())
            })
            .collect();
        let mut v_frozen: Vec<(Address, u64)> = out
            .freezeOwners
            .iter()
            .zip(&out.freezeDurations)
            .map(|(o, d)| (*o, (d / U256::from(ROUND_LENGTH)).to::<u64>()))
            .collect();
        g_frozen.sort();
        v_frozen.sort();

        let mut diffs = vec![];
        if (out.truthHash, out.truthDepth) != (truth.hash, truth.depth) {
            diffs.push(format!(
                "truth vm {}@{} gnosis {}@{}",
                out.truthHash, out.truthDepth, truth.hash, truth.depth
            ));
        }
        if out.winner != winner.owner || out.winnerStakeDensity != winner.stakeDensity {
            diffs.push(format!(
                "winner vm {} ({}) gnosis {} ({})",
                out.winner, out.winnerStakeDensity, winner.owner, winner.stakeDensity
            ));
        }
        if v_frozen != g_frozen {
            diffs.push(format!("freezes vm {v_frozen:?} gnosis {g_frozen:?}"));
        }
        t.compared += 1;
        if diffs.is_empty() {
            t.equal += 1;
            println!(
                "round {round}: equal (commits {}, reveals {}, redundancy {}, freezes {}, depth {})",
                g.commits.len(),
                g.reveals.len(),
                out.redundancy,
                v_frozen.len(),
                truth.depth
            );
        } else {
            let line = format!("round {round}: DIFFERS: {}", diffs.join("; "));
            println!("{line}");
            t.differ.push(line);
        }
        last_claim_round = round;
        last_winner_depth = winner.depth;
    }

    println!(
        "\n{} rounds compared: {} equal, {} differ; {} rounds with reveals but no claim on Gnosis; {} skipped",
        t.compared,
        t.equal,
        t.differ.len(),
        t.no_claim,
        t.skipped
    );
    if !t.differ.is_empty() {
        bail!("{} rounds differ", t.differ.len());
    }
    Ok(())
}

/// updateRandomness at the first reveal: keccak256(abi.encode(seed, block.prevrandao)).
async fn next_seed(p: &DynProvider, seed: B256, first_reveal: &Log) -> Result<B256> {
    let b = p
        .get_block_by_number(BlockNumberOrTag::Number(first_reveal.block_number.unwrap()))
        .await?
        .context("first reveal block")?;
    Ok(keccak256(
        (seed, U256::from_be_bytes(b.header.mix_hash.0)).abi_encode(),
    ))
}

#[allow(clippy::too_many_arguments)]
async fn build_input(
    p: &DynProvider,
    round: u64,
    g: &GRound,
    anchor: B256,
    seed: B256,
    last_claim_round: u64,
    last_winner_depth: u8,
    (pm_dis, pm_non, prf): (u8, u8, u8),
) -> Result<RoundInput> {
    let mut forced_commits = vec![];
    let mut stakes = vec![];
    // Effective stake as Redistribution took it at commit, from the Revealed events.
    let mut stake_of: HashMap<B256, U256> = HashMap::new();
    let mut forced_reveals = vec![];
    for l in &g.reveals {
        let e = l.log_decode::<Revealed>()?.inner.data;
        stake_of.insert(e.overlay, e.stake);
        let tx = tx_input(p, l).await?;
        let c = revealCall::abi_decode(&tx)?;
        if c._hash != e.reserveCommitment || c._depth != e.depth {
            bail!("reveal calldata does not match its event");
        }
        forced_reveals.push(Reveal {
            overlay: e.overlay,
            depth: c._depth,
            hash: c._hash,
            nonce: c._revealNonce,
        });
    }
    for l in &g.commits {
        let e = l.log_decode::<Committed>()?.inner.data;
        let tx = p
            .get_transaction_by_hash(l.transaction_hash.unwrap())
            .await?
            .context("commit tx")?;
        let c = commitCall::abi_decode(alloy::consensus::Transaction::input(&tx))?;
        if c._roundNumber != round {
            bail!("commit for round {} in round {round}", c._roundNumber);
        }
        let owner = tx.inner.signer();
        forced_commits.push(ForcedCommit {
            owner,
            obfuscated_hash: c._obfuscatedHash,
        });
        // A node that did not reveal: its stake changes nothing but its freeze.
        let stake = stake_of.get(&e.overlay).copied().unwrap_or(U256::from(1u8));
        stakes.push(StakeRecord {
            owner,
            overlay: e.overlay,
            committed_stake: stake,
            potential_stake: stake,
            height: e.height,
            last_updated: U256::from(1u8),
        });
    }

    // The VM's own block numbers for the round (64-block rounds): headers with those numbers, and an
    // empty postage state settled at the seed block.
    let start = round * ROUND_LENGTH;
    let seed_block = start + SEED_OFFSET;
    let mut state = PostageState::from_batches(
        seed_block - ROUND_LENGTH,
        1,
        U256::ZERO,
        U256::from(24000u32),
        &[],
    )
    .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let (_, postage) = state
        .settle(0, B256::ZERO, vec![], seed_block + 1, seed_block, &[], true)
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;

    Ok(RoundInput {
        chain_id: U256::from(100u8),
        settlement: REDISTRIBUTION,
        round,
        round_anchor: anchor,
        selection_seed: seed,
        anchor_header: randomness::synthetic_header(start - 1, B256::ZERO),
        seed_header: randomness::synthetic_header(seed_block, B256::ZERO),
        commits: vec![],
        forced_commits,
        reveals: vec![],
        forced_reveals,
        stakes,
        stake_price: 1,
        last_claim_round,
        last_winner_depth,
        penalty_multiplier_disagreement: pm_dis,
        penalty_multiplier_non_revealed: pm_non,
        penalty_random_factor: prf,
        stake_age_rounds: 0,
        claim: None,
        forced_claims: vec![],
        sample_max_value: U256::ZERO,
        fee_recipient: Address::ZERO,
        postage: postage.context("postage input")?,
    })
}

async fn tx_input(p: &DynProvider, l: &Log) -> Result<Vec<u8>> {
    let tx = p
        .get_transaction_by_hash(l.transaction_hash.unwrap())
        .await?
        .context("tx")?;
    Ok(alloy::consensus::Transaction::input(&tx).to_vec())
}

async fn logs(
    p: &DynProvider,
    address: Address,
    sigs: Vec<B256>,
    from: u64,
    to: u64,
    chunk: u64,
) -> Result<Vec<Log>> {
    let mut out = vec![];
    let mut start = from;
    while start <= to {
        let end = (start + chunk - 1).min(to);
        let f = Filter::new()
            .address(address)
            .event_signature(sigs.clone())
            .from_block(start)
            .to_block(end);
        out.extend(
            p.get_logs(&f)
                .await
                .with_context(|| format!("logs {start}-{end}"))?,
        );
        start = end + 1;
    }
    out.sort_by_key(|l| (l.block_number, l.log_index));
    Ok(out)
}
