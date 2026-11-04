//! gnosis-postage: replay the real Gnosis Chain postage history through the proof's postage accounting.
//!
//! 1. Fetch BatchCreated, BatchTopUp, BatchDepthIncrease and PriceUpdate of the Gnosis PostageStamp
//!    (cached in `<out>/logs.json`).
//! 2. Convert them to the PostageLog entries PostageStampZK would have written: the same fields, with
//!    the total outpayment at each block computed as `currentTotalOutPayment` does.
//! 3. Replay them natively, one settlement per `--settle-every` blocks (152 = one Gnosis round), up to
//!    the last settlement before `--to-block`.
//! 4. Write the last settlement as a round input (no game, only postage) to `<out>/input.json`. Run it
//!    with `swarm-prover execute <out>/input.json` for the cycle count of one steady-state settlement,
//!    or add `--prove`.
//!
//!   GNOSIS_RPC_URL=... ./target/release/gnosis-postage --out data/gnosis

use alloy::{
    primitives::{address, Address, B256, U256},
    providers::{Provider, ProviderBuilder},
    rpc::types::Filter,
    sol,
    sol_types::SolEvent,
};
use anyhow::{bail, Context, Result};
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf};
use swarm_vm::postage::{
    event_hash, verify, PostageEvent, PostageState, KIND_CREATE, KIND_DEPTH, KIND_PRICE, KIND_TOPUP,
};
use swarm_vm::{RoundInput, ROUND_LENGTH, SEED_OFFSET};

sol! {
    event BatchCreated(bytes32 indexed batchId, uint256 totalAmount, uint256 normalisedBalance, address owner, uint8 depth, uint8 bucketDepth, bool immutableFlag);
    event BatchTopUp(bytes32 indexed batchId, uint256 topupAmount, uint256 normalisedBalance);
    event BatchDepthIncrease(bytes32 indexed batchId, uint8 newDepth, uint256 normalisedBalance);
    event PriceUpdate(uint256 price);
}

const GNOSIS_POSTAGE: Address = address!("45a1502382541Cd610CC9068e88727426b696293");

#[derive(Parser)]
struct Args {
    #[arg(long, env = "GNOSIS_RPC_URL")]
    rpc_url: String,
    /// Deployment block of the Gnosis PostageStamp.
    #[arg(long, default_value_t = 31_305_656)]
    from_block: u64,
    /// Last block to replay (default: latest).
    #[arg(long)]
    to_block: Option<u64>,
    /// Blocks per eth_getLogs request.
    #[arg(long, default_value_t = 100_000)]
    chunk: u64,
    /// Blocks between two simulated settlements.
    #[arg(long, default_value_t = 152)]
    settle_every: u64,
    #[arg(long, default_value = "data/gnosis")]
    out: PathBuf,
}

/// A master event, decoded, in chain order.
#[derive(Clone, Serialize, Deserialize)]
struct Raw {
    block: u64,
    log_index: u64,
    kind: u8,
    batch_id: B256,
    owner: Address,
    depth: u8,
    bucket_depth: u8,
    /// normalisedBalance, or the price for a price update.
    value: U256,
}

#[derive(Serialize, Deserialize)]
struct Cache {
    from_block: u64,
    to_block: u64,
    events: Vec<Raw>,
}

async fn fetch(args: &Args, to: u64) -> Result<Vec<Raw>> {
    let path = args.out.join("logs.json");
    if let Ok(bytes) = std::fs::read(&path) {
        let c: Cache = serde_json::from_slice(&bytes)?;
        if c.from_block == args.from_block && c.to_block == to {
            eprintln!("using cached logs: {} events", c.events.len());
            return Ok(c.events);
        }
    }
    let provider = ProviderBuilder::new().connect_http(args.rpc_url.parse()?);
    let mut out = vec![];
    let mut start = args.from_block;
    while start <= to {
        let end = (start + args.chunk - 1).min(to);
        let filter = Filter::new()
            .address(GNOSIS_POSTAGE)
            .from_block(start)
            .to_block(end)
            .event_signature(vec![
                BatchCreated::SIGNATURE_HASH,
                BatchTopUp::SIGNATURE_HASH,
                BatchDepthIncrease::SIGNATURE_HASH,
                PriceUpdate::SIGNATURE_HASH,
            ]);
        let logs = provider
            .get_logs(&filter)
            .await
            .with_context(|| format!("logs {start}-{end}"))?;
        for log in logs {
            let block = log.block_number.context("block number")?;
            let log_index = log.log_index.context("log index")?;
            let t0 = log.topic0().copied().unwrap_or_default();
            let raw = if t0 == BatchCreated::SIGNATURE_HASH {
                let e = log.log_decode::<BatchCreated>()?.inner.data;
                Raw {
                    block,
                    log_index,
                    kind: KIND_CREATE,
                    batch_id: e.batchId,
                    owner: e.owner,
                    depth: e.depth,
                    bucket_depth: e.bucketDepth,
                    value: e.normalisedBalance,
                }
            } else if t0 == BatchTopUp::SIGNATURE_HASH {
                let e = log.log_decode::<BatchTopUp>()?.inner.data;
                Raw {
                    block,
                    log_index,
                    kind: KIND_TOPUP,
                    batch_id: e.batchId,
                    owner: Address::ZERO,
                    depth: 0,
                    bucket_depth: 0,
                    value: e.normalisedBalance,
                }
            } else if t0 == BatchDepthIncrease::SIGNATURE_HASH {
                let e = log.log_decode::<BatchDepthIncrease>()?.inner.data;
                Raw {
                    block,
                    log_index,
                    kind: KIND_DEPTH,
                    batch_id: e.batchId,
                    owner: Address::ZERO,
                    depth: e.newDepth,
                    bucket_depth: 0,
                    value: e.normalisedBalance,
                }
            } else {
                let e = log.log_decode::<PriceUpdate>()?.inner.data;
                Raw {
                    block,
                    log_index,
                    kind: KIND_PRICE,
                    batch_id: B256::ZERO,
                    owner: Address::ZERO,
                    depth: 0,
                    bucket_depth: 0,
                    value: e.price,
                }
            };
            out.push(raw);
        }
        eprintln!("blocks {start}-{end}: {} events so far", out.len());
        start = end + 1;
    }
    out.sort_by_key(|r| (r.block, r.log_index));
    std::fs::create_dir_all(&args.out)?;
    std::fs::write(
        &path,
        serde_json::to_vec(&Cache {
            from_block: args.from_block,
            to_block: to,
            events: out.clone(),
        })?,
    )?;
    Ok(out)
}

/// The PostageLog entries PostageStampZK would write for the same calls.
fn to_log(raw: &[Raw]) -> Result<Vec<PostageEvent>> {
    let (mut price, mut price_block, mut price_outpayment) = (U256::ZERO, 0u64, U256::ZERO);
    let mut batches: HashMap<B256, (Address, u8, u8)> = HashMap::new();
    let mut out = Vec::with_capacity(raw.len());
    for (i, r) in raw.iter().enumerate() {
        // currentTotalOutPayment at this block.
        let outpayment = price_outpayment + price * U256::from(r.block - price_block);
        let (owner, depth, bucket_depth) = match r.kind {
            KIND_CREATE => {
                batches.insert(r.batch_id, (r.owner, r.depth, r.bucket_depth));
                (r.owner, r.depth, r.bucket_depth)
            }
            KIND_TOPUP | KIND_DEPTH => {
                let b = batches
                    .get_mut(&r.batch_id)
                    .with_context(|| format!("unknown batch {}", r.batch_id))?;
                if r.kind == KIND_DEPTH {
                    b.1 = r.depth;
                }
                *b
            }
            _ => {
                (price, price_block, price_outpayment) = (r.value, r.block, outpayment);
                (Address::ZERO, 0, 0)
            }
        };
        out.push(PostageEvent {
            index: i as u64 + 1,
            kind: r.kind,
            batch_id: r.batch_id,
            owner,
            depth,
            bucket_depth,
            value: r.value,
            outpayment,
            block: r.block,
        });
    }
    Ok(out)
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenv::dotenv().ok();
    let args = Args::parse();
    let to = match args.to_block {
        Some(b) => b,
        None => {
            ProviderBuilder::new()
                .connect_http(args.rpc_url.parse()?)
                .get_block_number()
                .await?
        }
    };
    let raw = fetch(&args, to).await?;
    let log = to_log(&raw)?;
    let count = |k| log.iter().filter(|e| e.kind == k).count();
    println!(
        "Gnosis PostageStamp {GNOSIS_POSTAGE}, blocks {}-{to}: {} events ({} create, {} top-up, {} depth, {} price)",
        args.from_block,
        log.len(),
        count(KIND_CREATE),
        count(KIND_TOPUP),
        count(KIND_DEPTH),
        count(KIND_PRICE)
    );

    // Settle every `settle_every` blocks from the first event, as the proof would. The last cut is the
    // newest settlement point at or before `to`; the one before it is the state the last proof starts from.
    let first = log.first().context("no events")?.block;
    let last_cut = first + (to - first) / args.settle_every * args.settle_every;
    let prev_cut = last_cut - args.settle_every;
    let mut state = PostageState::default();
    let (mut idx, mut hash) = (0u64, B256::ZERO);
    let mut next = 0usize;
    let mut total_pot = U256::ZERO;
    let mut max_live = 0usize;
    let mut live = 0usize;
    let mut cut = first;
    let started = std::time::Instant::now();
    while cut <= prev_cut {
        let end = log[next..]
            .iter()
            .position(|e| e.block > cut)
            .map_or(log.len(), |p| next + p);
        let creates = log[next..end]
            .iter()
            .filter(|e| e.kind == KIND_CREATE)
            .count();
        let (r, _) = state
            .settle(idx, hash, log[next..end].to_vec(), cut, cut, &[], false)
            .map_err(|e| anyhow::anyhow!("cut {cut}: {e:?}"))?;
        total_pot += r.pot;
        (idx, hash, next) = (r.event_index, r.event_hash, end);
        // Live batches: count leaves only when it can have changed.
        if creates > 0 || r.pot > U256::ZERO {
            live = state.batches().len();
            max_live = max_live.max(live);
        }
        cut += args.settle_every;
    }
    let replay_time = started.elapsed();
    if hash != log[..next].iter().fold(B256::ZERO, |h, e| event_hash(h, e)) {
        bail!("event hash chain mismatch");
    }

    // The last settlement, as a round input with no game, with the zkVM witness.
    let round = (last_cut - SEED_OFFSET - 1) / ROUND_LENGTH;
    let before = state.batches().len();
    let events: Vec<PostageEvent> = log[next..]
        .iter()
        .filter(|e| e.block <= last_cut)
        .cloned()
        .collect();
    let n_events = events.len();
    let probe = round * ROUND_LENGTH + SEED_OFFSET;
    let (last, postage) = state
        .settle(idx, hash, events, last_cut, probe, &[], true)
        .map_err(|e| anyhow::anyhow!("last settlement: {e:?}"))?;
    let postage = postage.expect("recorded");
    total_pot += last.pot;
    let guest = verify(&postage, probe, &[]).map_err(|e| anyhow::anyhow!("zkVM side: {e:?}"))?;
    if guest.new_header != last.new_header || guest.pot != last.pot {
        bail!("zkVM side differs from the prover side");
    }

    println!(
        "replay on the batch tree: {} settlements in {replay_time:?}; most live batches at a cut: {max_live} (now {live})",
        (prev_cut - first) / args.settle_every + 1
    );
    println!(
        "last settlement (cut {last_cut}): {before} live batches before, {} after, {n_events} new events, pot {} (BZZ {:.4}), validChunkCount {}",
        state.batches().len(),
        last.pot,
        f64::from(last.pot) / 1e16,
        last.valid_chunk_count
    );
    println!(
        "witness of the last settlement: {} leaf proofs, {} hints",
        postage.witness.proofs.len(),
        postage.witness.hints.len()
    );
    println!(
        "pot over the whole history: {total_pot} (BZZ {:.2})",
        f64::from(total_pot) / 1e16
    );

    let input = RoundInput {
        chain_id: U256::from(100u8),
        settlement: Address::ZERO,
        round,
        round_anchor: B256::ZERO,
        selection_seed: B256::ZERO,
        commits: vec![],
        forced_commits: vec![],
        reveals: vec![],
        forced_reveals: vec![],
        stakes: vec![],
        stake_price: 0,
        last_claim_round: 0,
        last_winner_depth: 0,
        penalty_multiplier_disagreement: 1,
        penalty_multiplier_non_revealed: 2,
        penalty_random_factor: 100,
        stake_age_rounds: 2,
        claim: None,
        forced_claims: vec![],
        sample_max_value: U256::MAX,
        postage,
    };
    std::fs::create_dir_all(&args.out)?;
    let path = args.out.join("input.json");
    std::fs::write(&path, serde_json::to_vec(&input)?)?;
    println!("wrote {}", path.display());
    Ok(())
}
