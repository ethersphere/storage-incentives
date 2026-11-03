//! The round loop: anchor every round's commit set, then settle every anchored round with a proof.

use crate::{prover, server, store::Store};
use alloy::{
    network::EthereumWallet,
    primitives::{Address, Bytes, B256, U256},
    providers::{DynProvider, Provider, ProviderBuilder},
    rpc::types::Filter,
    signers::local::PrivateKeySigner,
    sol_types::SolEvent,
};
use alloy_sol_types::SolType;
use anyhow::{anyhow, Context, Result};
use std::{path::PathBuf, sync::Arc, time::Duration};
use swarm_prover::{
    offset_of, round_of, seed_block, PostageStamp, PriceOracle, Settlement, StakeRegistry,
    ANCHOR_END, CLAIM_START, COMMIT_END, HISTORY_SERVE_WINDOW, REVEAL_ANCHOR_END,
    REVEAL_ANCHOR_START, REVEAL_END, ROUND_LENGTH, SEED_OFFSET,
};
use swarm_vm::{
    canonical_commits, commits_hash, reveals_hash, ForcedCommit, PublicValues, Reveal, RoundInput,
    StakeRecord,
};
use tokio::sync::Mutex;
use tracing::{error, info, warn};

#[derive(clap::Args, Clone)]
pub struct Config {
    #[arg(long, env = "RPC_URL")]
    pub rpc_url: String,
    /// Key that holds ANCHOR_ROLE and pays gas for anchorRound and settleRound.
    #[arg(long, env = "PROVER_PRIVATE_KEY")]
    pub private_key: String,
    #[arg(long, env = "SETTLEMENT_ADDRESS")]
    pub settlement: Address,
    #[arg(long, env = "LISTEN", default_value = "0.0.0.0:8080")]
    pub listen: String,
    #[arg(long, env = "DATA_DIR", default_value = "data")]
    pub data_dir: PathBuf,
    #[arg(long, env = "POLL_SECS", default_value_t = 3)]
    pub poll_secs: u64,
    /// First block to search for PostageLog entries before the first settlement (the deployment block
    /// of PostageStampZK). Later settlements search from their last cut block.
    #[arg(long, env = "POSTAGE_FROM_BLOCK", default_value_t = 0)]
    pub postage_from_block: u64,
    /// TEST ONLY: act as a censoring prover. Leave the commits of these staking addresses out of the
    /// anchored commit list.
    #[arg(long, env = "CENSOR_COMMITS", value_delimiter = ',')]
    pub censor_commits: Vec<Address>,
    /// TEST ONLY: keep the commits of these staking addresses but leave their reveals out of the
    /// anchored reveal list (the attack anchorReveals exists for).
    #[arg(long, env = "CENSOR_REVEALS", value_delimiter = ',')]
    pub censor_reveals: Vec<Address>,
}

const TX_TIMEOUT: Duration = Duration::from_secs(180);

pub struct Ctx {
    pub provider: DynProvider,
    pub settlement: Address,
    pub chain_id: U256,
    /// The prover key's address, for explicit nonces.
    pub from: Address,
    pub postage_from_block: u64,
    pub censor_commits: Vec<Address>,
    /// Overlays of `Config::censor_reveals`.
    pub censor_reveals: Vec<B256>,
    pub store: Mutex<Store>,
    /// Serialises transactions from the one prover key.
    pub tx_lock: Mutex<()>,
}

pub async fn serve(cfg: Config) -> Result<()> {
    let signer: PrivateKeySigner = cfg.private_key.parse().context("PROVER_PRIVATE_KEY")?;
    let from = signer.address();
    info!("prover address {from}");
    let provider = ProviderBuilder::new()
        .wallet(EthereumWallet::from(signer))
        .connect_http(cfg.rpc_url.parse()?)
        .erased();
    let chain_id = U256::from(provider.get_chain_id().await?);

    let s = Settlement::new(cfg.settlement, &provider);
    let onchain_vkey = s.programVKey().call().await?;
    let local_vkey = tokio::task::spawn_blocking(prover::vkey).await?;
    if format!("{onchain_vkey}") != local_vkey {
        warn!("program vkey differs: contract {onchain_vkey}, local {local_vkey}. Proofs will be rejected unless the contract uses the mock verifier");
    }
    if prover::is_mock() {
        warn!("SP1_PROVER=mock: proofs are empty and only SP1MockVerifier accepts them");
    }

    let mut censor_reveals = vec![];
    if !cfg.censor_commits.is_empty() || !cfg.censor_reveals.is_empty() {
        warn!(commits = ?cfg.censor_commits, reveals = ?cfg.censor_reveals, "TEST MODE: censoring");
        let staking = StakeRegistry::new(s.Stakes().call().await?, &provider);
        for a in &cfg.censor_reveals {
            censor_reveals.push(staking.overlayOfAddress(*a).call().await?);
        }
    }

    let ctx = Arc::new(Ctx {
        provider,
        settlement: cfg.settlement,
        chain_id,
        from,
        postage_from_block: cfg.postage_from_block,
        censor_commits: cfg.censor_commits.clone(),
        censor_reveals,
        store: Mutex::new(Store::open(cfg.data_dir.clone())?),
        tx_lock: Mutex::new(()),
    });

    let poll = Duration::from_secs(cfg.poll_secs);
    tokio::spawn(anchor_loop(ctx.clone(), poll));
    tokio::spawn(settle_loop(ctx.clone(), poll));
    server::run(ctx, &cfg.listen).await
}

async fn anchor_loop(ctx: Arc<Ctx>, poll: Duration) {
    loop {
        if let Err(e) = anchor_tick(&ctx).await {
            error!("anchor: {e:#}");
        }
        tokio::time::sleep(poll).await;
    }
}

async fn anchor_tick(ctx: &Ctx) -> Result<()> {
    let block = ctx.provider.get_block_number().await?;
    let (round, offset) = (round_of(block), offset_of(block));
    if (COMMIT_END..ANCHOR_END).contains(&offset) {
        anchor_commits(ctx, round).await
    } else if (REVEAL_ANCHOR_START..REVEAL_ANCHOR_END).contains(&offset) {
        anchor_reveals(ctx, round).await
    } else {
        Ok(())
    }
}

/// Fix the round's off-chain commit list on chain (anchorRound).
async fn anchor_commits(ctx: &Ctx, round: u64) -> Result<()> {    if ctx.store.lock().await.get_mut(round).anchored.is_some() {
        return Ok(());
    }

    let s = Settlement::new(ctx.settlement, &ctx.provider);
    if s.rounds(round).call().await?.anchored {
        warn!("round {round} was anchored by someone else; this prover will not settle it");
        ctx.store.lock().await.get_mut(round).anchored = Some(vec![]);
        return Ok(());
    }

    let list: Vec<_> = {
        let mut store = ctx.store.lock().await;
        let r = store.get_mut(round);
        let list: Vec<_> = r
            .commits
            .values()
            .filter(|c| !ctx.censor_commits.contains(&c.owner))
            .cloned()
            .collect();
        r.anchored = Some(list.clone());
        store.save(round)?;
        list
    };
    let hash = commits_hash(list.iter().map(|c| (&c.owner, &c.obfuscated_hash)));
    // Stand-in for a Swarm reference to the published list.
    let data_ref = alloy::primitives::keccak256(serde_json::to_vec(&list)?);

    let _g = ctx.tx_lock.lock().await;
    let nonce = ctx
        .provider
        .get_transaction_count(ctx.from)
        .pending()
        .await?;
    let receipt = s
        .anchorRound(round, hash, list.len() as u32, data_ref)
        .nonce(nonce)
        .send()
        .await?
        .with_timeout(Some(TX_TIMEOUT))
        .get_receipt()
        .await?;
    info!(round, commits = list.len(), tx = %receipt.transaction_hash, "anchored");
    Ok(())
}

/// Fix the round's off-chain reveal list on chain (anchorReveals), so a node left out can still call
/// forceReveal. Only for rounds this prover anchored.
async fn anchor_reveals(ctx: &Ctx, round: u64) -> Result<()> {
    let list: Vec<Reveal> = {
        let mut store = ctx.store.lock().await;
        let r = store.get_mut(round);
        if r.reveals_anchored.is_some() || r.anchored.as_ref().map_or(true, |a| a.is_empty()) {
            return Ok(());
        }
        let mut list: Vec<Reveal> = r
            .reveals
            .iter()
            .filter(|v| !ctx.censor_reveals.contains(&v.overlay))
            .cloned()
            .collect();
        list.sort_by(|a, b| a.overlay.cmp(&b.overlay));
        r.reveals_anchored = Some(list.clone());
        store.save(round)?;
        list
    };
    let s = Settlement::new(ctx.settlement, &ctx.provider);
    if s.rounds(round).call().await?.revealsAnchored {
        return Ok(());
    }
    let hash = reveals_hash(&list);
    let data_ref = alloy::primitives::keccak256(serde_json::to_vec(&list)?);

    let _g = ctx.tx_lock.lock().await;
    let nonce = ctx
        .provider
        .get_transaction_count(ctx.from)
        .pending()
        .await?;
    let receipt = s
        .anchorReveals(round, hash, list.len() as u32, data_ref)
        .nonce(nonce)
        .send()
        .await?
        .with_timeout(Some(TX_TIMEOUT))
        .get_receipt()
        .await?;
    info!(round, reveals = list.len(), tx = %receipt.transaction_hash, "reveals anchored");
    Ok(())
}

async fn settle_loop(ctx: Arc<Ctx>, poll: Duration) {
    loop {
        if let Err(e) = settle_tick(&ctx).await {
            error!("settle: {e:#}");
        }
        tokio::time::sleep(poll).await;
    }
}

async fn settle_tick(ctx: &Ctx) -> Result<()> {
    let block = ctx.provider.get_block_number().await?;
    let s = Settlement::new(ctx.settlement, &ctx.provider);
    let last = s.lastSettledRound().call().await?;

    let candidates: Vec<u64> = {
        let store = ctx.store.lock().await;
        store
            .rounds
            .iter()
            .filter(|(r, m)| {
                **r > last && m.anchored.is_some() && m.settle_tx.is_none() && m.failed.is_none()
            })
            .map(|(r, _)| *r)
            .collect()
    };

    for round in candidates {
        let sb = seed_block(round);
        if block <= sb {
            break; // later rounds are not ready either
        }
        if block - sb > HISTORY_SERVE_WINDOW {
            mark_failed(ctx, round, "seed expired").await?;
            continue;
        }
        let ri = s.rounds(round).call().await?;
        if !ri.anchored {
            mark_failed(ctx, round, "anchor transaction never landed").await?;
            continue;
        }
        if ri.settled {
            ctx.store.lock().await.get_mut(round).settle_tx =
                Some("settled by another prover".into());
            continue;
        }
        // An error here can be temporary (RPC, a missing postage state file that an operator can restore):
        // retry next tick, and do not settle later rounds first, since they build on this one's state.
        let input = match build_input(ctx, round, block, None).await {
            Ok(i) => i,
            Err(e) => {
                warn!(round, "cannot build the round input yet: {e:#}");
                break;
            }
        };
        // A truth without a valid witness can only settle once the claim window is closed: the winner
        // (or any truth-teller) can still send it, or call forceClaim.
        let native = swarm_vm::run(&input).map_err(|e| anyhow!("vm: {e:?}"))?;
        if native.outcome.unclaimed && block < (round + 1) * ROUND_LENGTH {
            break;
        }
        settle(ctx, round, input).await?;
        // One round per tick: state (lastClaimRound, lastWinnerDepth) changes with each settlement.
        break;
    }
    Ok(())
}

async fn mark_failed(ctx: &Ctx, round: u64, why: &str) -> Result<()> {
    warn!(round, "cannot settle: {why}");
    let mut store = ctx.store.lock().await;
    store.get_mut(round).failed = Some(why.to_string());
    store.save(round)
}

/// Everything the VM needs, from the local message store and the chain. `claim` replaces the stored
/// claim witness (used to check a witness before accepting it).
pub async fn build_input(
    ctx: &Ctx,
    round: u64,
    block: u64,
    claim: Option<Bytes>,
) -> Result<RoundInput> {
    let s = Settlement::new(ctx.settlement, &ctx.provider);
    let ri = s.rounds(round).call().await?;

    let (commits, reveals, stored_claim) = {
        let store = ctx.store.lock().await;
        let m = store
            .rounds
            .get(&round)
            .ok_or_else(|| anyhow!("no local data"))?;
        // Before the reveal anchor (the outcome endpoint can ask early) use what was received.
        let reveals = if ri.revealsAnchored {
            m.reveals_anchored.clone().unwrap_or_default()
        } else if block < round * ROUND_LENGTH + REVEAL_ANCHOR_END {
            m.reveals.clone()
        } else {
            vec![]
        };
        (
            m.anchored.clone().unwrap_or_default(),
            reveals,
            m.claim.clone(),
        )
    };
    if commits_hash(commits.iter().map(|c| (&c.owner, &c.obfuscated_hash))) != ri.commitsHash
        || commits.len() as u32 != ri.commitCount
    {
        anyhow::bail!("local commit list does not match the anchored commitsHash");
    }
    if ri.revealsAnchored
        && (reveals_hash(&reveals) != ri.revealsHash || reveals.len() as u32 != ri.revealCount)
    {
        anyhow::bail!("local reveal list does not match the anchored revealsHash");
    }

    let (forced_commits, forced_reveals) = forced_inputs(ctx, round).await?;
    if swarm_vm::forced_commits_hash(&forced_commits) != ri.forcedCommitsHash
        || swarm_vm::forced_reveals_hash(&forced_reveals) != ri.forcedRevealsHash
    {
        anyhow::bail!("forced events do not match the on-chain hash chains (RPC log gap?)");
    }
    let forced_claims = forced_claims(ctx, round, block).await?;
    if swarm_vm::claim::forced_claims_hash(&forced_claims) != ri.forcedClaimsHash {
        anyhow::bail!("ClaimForced events do not match the on-chain hash chain (RPC log gap?)");
    }

    let mut input = RoundInput {
        chain_id: ctx.chain_id,
        settlement: ctx.settlement,
        round,
        round_anchor: ri.roundAnchor,
        selection_seed: s.selectionSeed(round).call().await?,
        commits,
        forced_commits,
        reveals,
        forced_reveals,
        stakes: vec![],
        stake_price: PriceOracle::new(s.OracleContract().call().await?, &ctx.provider)
            .currentPrice()
            .call()
            .await?,
        last_claim_round: s.lastClaimRound().call().await?,
        last_winner_depth: s.lastWinnerDepth().call().await?,
        penalty_multiplier_disagreement: s.penaltyMultiplierDisagreement().call().await?,
        penalty_multiplier_non_revealed: s.penaltyMultiplierNonRevealed().call().await?,
        penalty_random_factor: s.penaltyRandomFactor().call().await?,
        stake_age_rounds: s.stakeAgeRounds().call().await?,
        claim: claim.or(stored_claim),
        forced_claims,
        sample_max_value: s.sampleMaxValue().call().await?,
        postage: postage_input(ctx, block).await?,
    };

    // Raw stake records exactly as Settlement.stakeDigest will read them.
    let staking = StakeRegistry::new(s.Stakes().call().await?, &ctx.provider);
    for (owner, _) in canonical_commits(&input).map_err(|e| anyhow!("{e:?}"))? {
        let r = staking.stakes(owner).call().await?;
        input.stakes.push(StakeRecord {
            owner,
            overlay: r.overlay,
            committed_stake: r.committedStake,
            potential_stake: r.potentialStake,
            height: r.height,
            last_updated: r.lastUpdatedBlockNumber,
        });
    }
    Ok(input)
}

/// The postage part of a round input: the state of the last settlement, and the PostageLog entries after
/// it up to `cut` (the current block).
async fn postage_input(ctx: &Ctx, cut: u64) -> Result<swarm_vm::postage::PostageInput> {
    let s = Settlement::new(ctx.settlement, &ctx.provider);
    let prev_hash = s.postageStateHash().call().await?;
    let prev_event_index = s.postageEventIndex().call().await?;
    let prev_event_hash = s.postageEventHash().call().await?;
    let state = ctx.store.lock().await.load_postage(prev_hash)?;

    let postage = PostageStamp::new(s.PostageContract().call().await?, &ctx.provider);
    let from = if state.last_cut_block == 0 {
        ctx.postage_from_block
    } else {
        state.last_cut_block
    };
    let filter = Filter::new()
        .address(*postage.address())
        .from_block(from)
        .to_block(cut)
        .event_signature(PostageStamp::PostageLog::SIGNATURE_HASH);
    let mut events: Vec<swarm_vm::postage::PostageEvent> = vec![];
    for log in ctx.provider.get_logs(&filter).await? {
        let e = log.log_decode::<PostageStamp::PostageLog>()?.inner.data;
        if e.index <= prev_event_index {
            continue;
        }
        events.push(swarm_vm::postage::PostageEvent {
            index: e.index,
            kind: e.kind,
            batch_id: e.batchId,
            owner: e.owner,
            depth: e.depth,
            bucket_depth: e.bucketDepth,
            value: e.value,
            outpayment: e.outpayment,
            block: e.blockNumber,
        });
    }
    events.sort_by_key(|e| e.index);
    for (i, e) in events.iter().enumerate() {
        if e.index != prev_event_index + 1 + i as u64 {
            anyhow::bail!(
                "PostageLog gap at index {} (RPC log range?)",
                prev_event_index + 1 + i as u64
            );
        }
    }
    Ok(swarm_vm::postage::PostageInput {
        state,
        prev_event_index,
        prev_event_hash,
        events,
        cut_block: cut,
    })
}

/// ClaimForced events of a round, in chain order. forceClaim is open from CLAIM_START to the round end.
async fn forced_claims(ctx: &Ctx, round: u64, block: u64) -> Result<Vec<Bytes>> {
    let start = round * ROUND_LENGTH;
    let to = (start + ROUND_LENGTH - 1).min(block);
    if to < start + CLAIM_START {
        return Ok(vec![]);
    }
    let filter = Filter::new()
        .address(ctx.settlement)
        .from_block(start + CLAIM_START)
        .to_block(to)
        .topic1(B256::from(U256::from(round)))
        .event_signature(Settlement::ClaimForced::SIGNATURE_HASH);
    let mut out = vec![];
    for log in ctx.provider.get_logs(&filter).await? {
        out.push(
            log.log_decode::<Settlement::ClaimForced>()?
                .inner
                .data
                .witness,
        );
    }
    Ok(out)
}

/// CommitForced events of a round, in chain order.
pub async fn forced_commits(ctx: &Ctx, round: u64) -> Result<Vec<ForcedCommit>> {
    Ok(forced_inputs(ctx, round).await?.0)
}

/// CommitForced and RevealForced events of a round, in chain order.
async fn forced_inputs(ctx: &Ctx, round: u64) -> Result<(Vec<ForcedCommit>, Vec<Reveal>)> {
    let start = round * ROUND_LENGTH;
    let filter = Filter::new()
        .address(ctx.settlement)
        .from_block(start)
        .to_block(start + REVEAL_END)
        .topic1(B256::from(U256::from(round)));

    let mut commits = vec![];
    for log in ctx
        .provider
        .get_logs(
            &filter
                .clone()
                .event_signature(Settlement::CommitForced::SIGNATURE_HASH),
        )
        .await?
    {
        let e = log.log_decode::<Settlement::CommitForced>()?.inner.data;
        commits.push(ForcedCommit {
            owner: e.owner,
            obfuscated_hash: e.obfuscatedHash,
        });
    }
    let mut reveals = vec![];
    for log in ctx
        .provider
        .get_logs(&filter.event_signature(Settlement::RevealForced::SIGNATURE_HASH))
        .await?
    {
        let e = log.log_decode::<Settlement::RevealForced>()?.inner.data;
        reveals.push(Reveal {
            overlay: e.overlay,
            depth: e.depth,
            hash: e.hash,
            nonce: e.nonce,
        });
    }
    Ok((commits, reveals))
}

async fn settle(ctx: &Ctx, round: u64, input: RoundInput) -> Result<()> {
    {
        // Keep the postage state this settlement produces: the next one starts from it.
        let pg = swarm_vm::postage::apply(&input.postage, round * ROUND_LENGTH + SEED_OFFSET)
            .map_err(|e| anyhow!("postage: {e:?}"))?;
        let store = ctx.store.lock().await;
        store.save_postage(&pg.new_state)?;
        store.write_file(round, "input.json", &serde_json::to_vec_pretty(&input)?)?;
    }
    let native = swarm_vm::run(&input).map_err(|e| anyhow!("vm: {e:?}"))?;
    info!(
        round,
        participants = native.inputs.participants.len(),
        has_truth = native.outcome.hasTruth,
        winner = %native.outcome.winner,
        redundancy = native.outcome.redundancy,
        freezes = native.outcome.freezeOwners.len(),
        "round computed, proving"
    );

    let started = std::time::Instant::now();
    let p = tokio::task::spawn_blocking(move || prover::prove(&input)).await??;
    info!(round, cycles = p.cycles, elapsed = ?started.elapsed(), proof_bytes = p.proof.len(), "proved");
    debug_assert_eq!(p.public_values, PublicValues::abi_encode(&native));
    {
        let store = ctx.store.lock().await;
        store.write_file(
            round,
            "proof.json",
            &serde_json::to_vec_pretty(&serde_json::json!({
                "publicValues": Bytes::from(p.public_values.clone()),
                "proof": Bytes::from(p.proof.clone()),
                "cycles": p.cycles,
                "proveSeconds": started.elapsed().as_secs(),
            }))?,
        )?;
    }

    let s = Settlement::new(ctx.settlement, &ctx.provider);
    let _g = ctx.tx_lock.lock().await;
    let nonce = ctx
        .provider
        .get_transaction_count(ctx.from)
        .pending()
        .await?;
    let receipt = s
        .settleRound(p.public_values.into(), p.proof.into())
        .nonce(nonce)
        .send()
        .await?
        .with_timeout(Some(TX_TIMEOUT))
        .get_receipt()
        .await?;
    if !receipt.status() {
        anyhow::bail!("settleRound reverted: {}", receipt.transaction_hash);
    }
    info!(round, tx = %receipt.transaction_hash, gas = receipt.gas_used, "settled");
    let mut store = ctx.store.lock().await;
    store.get_mut(round).settle_tx = Some(receipt.transaction_hash.to_string());
    store.save(round)
}
