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
use anyhow::{anyhow, Context, Result};
use std::{path::PathBuf, sync::Arc, time::Duration};
use swarm_prover::swarm::{Bee, RoundData, DATA_VERSION};
use swarm_prover::{
    offset_of, round_of, seed_block, PostageStamp, PriceOracle, Settlement, StakeRegistry,
    ANCHOR_END, CLAIM_START, COMMIT_END, HISTORY_SERVE_WINDOW, PENDING_ROUNDS, REVEAL_ANCHOR_END,
    REVEAL_ANCHOR_START, REVEAL_END, ROUND_LENGTH, SEED_OFFSET,
};
use swarm_prover::{GameKeyRegistry, Job, Native};
use swarm_vm::{commits_hash, reveals_hash, ForcedCommit, Reveal, RoundInput, SignedCommit, Stake};
use tokio::sync::Mutex;
use tracing::{error, info, warn};

#[derive(clap::Args, Clone)]
pub struct Config {
    #[arg(long, env = "RPC_URL")]
    pub rpc_url: String,
    /// Key that holds ANCHOR_ROLE and pays gas for anchorCommits and settleRound.
    #[arg(long, env = "PROVER_PRIVATE_KEY")]
    pub private_key: String,
    #[arg(long, env = "SETTLEMENT_ADDRESS")]
    pub settlement: Address,
    #[arg(long, env = "LISTEN", default_value = "0.0.0.0:8080")]
    pub listen: String,
    #[arg(long, env = "DATA_DIR", default_value = "data")]
    pub data_dir: PathBuf,
    /// `snarkd serve`: the Groth16 prover of the settlement circuit (prover/snark).
    #[arg(long, env = "SNARKD_URL", default_value = "http://127.0.0.1:8099")]
    pub snarkd: String,
    #[arg(long, env = "POLL_SECS", default_value_t = 3)]
    pub poll_secs: u64,
    /// TEST ONLY: act as a censoring prover. Leave the commits of these staking addresses out of the
    /// anchored commit list.
    #[arg(long, env = "CENSOR_COMMITS", value_delimiter = ',')]
    pub censor_commits: Vec<Address>,
    /// TEST ONLY: keep the commits of these staking addresses but leave their reveals out of the
    /// anchored reveal list (the attack anchorReveals exists for).
    #[arg(long, env = "CENSOR_REVEALS", value_delimiter = ',')]
    pub censor_reveals: Vec<Address>,
    /// TEST ONLY: never anchor (a prover that stopped anchoring); still settles rounds that others anchored.
    #[arg(long, env = "NO_ANCHOR")]
    pub no_anchor: bool,
    /// TEST ONLY: accept claim witnesses but throw them away (the attack the winner's forceClaim
    /// backstop exists for).
    #[arg(long, env = "WITHHOLD_CLAIMS")]
    pub withhold_claims: bool,
    /// Bee API of the prover's own Swarm node (for example http://localhost:1633). Without it, nothing is
    /// uploaded and `dataRef` is the keccak256 of the document.
    #[arg(long, env = "SWARM_API")]
    pub swarm_api: Option<String>,
    /// Mutable postage batch for the uploads (`swarm-prover stamp buy`). Without it, nothing is uploaded.
    #[arg(long, env = "SWARM_BATCH_ID")]
    pub swarm_batch: Option<String>,
    /// Warn (or top up, see SWARM_TOPUP_DAYS) when the batch has less than this many days left.
    #[arg(long, env = "SWARM_MIN_TTL_DAYS", default_value_t = 7.0)]
    pub swarm_min_ttl_days: f64,
    /// Days of storage to add when the batch runs low. 0: only warn.
    #[arg(long, env = "SWARM_TOPUP_DAYS", default_value_t = 0.0)]
    pub swarm_topup_days: f64,
    /// Block time of the chain of the Swarm postage contract (5 on Gnosis, 12 on Ethereum).
    #[arg(long, env = "SWARM_BLOCK_SECONDS", default_value_t = 5.0)]
    pub swarm_block_secs: f64,
}

const TX_TIMEOUT: Duration = Duration::from_secs(180);

pub struct Ctx {
    /// Limits the HTTP requests that build a round input (dozens of RPC calls and a VM run each), so
    /// that a flood of them cannot starve anchoring and settling.
    pub heavy: tokio::sync::Semaphore,
    /// The last /outcome answer for each round, and when it was computed.
    pub outcomes:
        Mutex<std::collections::HashMap<u64, (std::time::Instant, swarm_prover::OutcomeMsg)>>,
    pub provider: DynProvider,
    pub settlement: Address,
    pub chain_id: U256,
    pub snarkd: String,
    /// The game circuits in use: (slot in Settlement.gameCircuits, number of entry slots).
    pub games: Vec<(u8, usize)>,
    /// The prover key's address, for explicit nonces.
    pub from: Address,
    pub censor_commits: Vec<Address>,
    /// Overlays of `Config::censor_reveals`.
    pub censor_reveals: Vec<B256>,
    pub withhold_claims: bool,
    pub no_anchor: bool,
    /// The prover's Bee node, if configured.
    pub bee: Option<Bee>,
    pub store: Mutex<Store>,
    /// Serialises transactions from the one prover key.
    pub tx_lock: Mutex<()>,
    /// The earlier anchored round that blocked the last settlement attempt (logged once, not each poll).
    pub pending: Mutex<Option<u64>>,
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
    // The game circuits that both the contract and snarkd have, smallest first.
    let have = prover::caps(&cfg.snarkd)
        .await
        .with_context(|| format!("snarkd at {} (start `snarkd serve`)", cfg.snarkd))?;
    let mut games = vec![];
    for slot in 0..2u8 {
        let g = s.gameCircuits(U256::from(slot)).call().await?;
        if !g.verifier.is_zero() && have.contains(&(g.capacity as usize)) {
            games.push((slot, g.capacity as usize));
        }
    }
    games.sort_by_key(|g| g.1);
    if games.is_empty() {
        anyhow::bail!("snarkd has keys for the game circuits {have:?}; the contract has none of them");
    }
    info!(?games, "game circuit sizes");
    let mut censor_reveals = vec![];
    if cfg.withhold_claims {
        warn!("TEST MODE: claim witnesses are thrown away");
    }
    if !cfg.censor_commits.is_empty() || !cfg.censor_reveals.is_empty() {
        warn!(commits = ?cfg.censor_commits, reveals = ?cfg.censor_reveals, "TEST MODE: censoring");
        let staking = StakeRegistry::new(s.Stakes().call().await?, &provider);
        for a in &cfg.censor_reveals {
            censor_reveals.push(staking.overlayOfAddress(*a).call().await?);
        }
    }

    let ctx = Arc::new(Ctx {
        heavy: tokio::sync::Semaphore::new(2),
        outcomes: Mutex::new(Default::default()),
        provider,
        settlement: cfg.settlement,
        chain_id,
        snarkd: cfg.snarkd.clone(),
        games,
        from,
        censor_commits: cfg.censor_commits.clone(),
        censor_reveals,
        withhold_claims: cfg.withhold_claims,
        no_anchor: cfg.no_anchor,
        bee: cfg
            .swarm_api
            .as_deref()
            .map(|api| Bee::new(api, cfg.swarm_batch.clone())),
        store: Mutex::new(Store::open(cfg.data_dir.clone())?),
        tx_lock: Mutex::new(()),
        pending: Mutex::new(None),
    });
    match ctx.bee.as_ref().map(|b| b.batch().is_some()) {
        Some(true) => {
            info!("Swarm uploads on: anchored commit and reveal lists")
        }
        Some(false) => warn!("SWARM_API set without SWARM_BATCH_ID: nothing is uploaded"),
        None => info!("Swarm uploads off: dataRef is the keccak256 of each document"),
    }

    let poll = Duration::from_secs(cfg.poll_secs);
    tokio::spawn(anchor_loop(ctx.clone(), poll));
    tokio::spawn(settle_loop(ctx.clone(), poll));
    if let Some(bee) = ctx.bee.clone().filter(|b| b.batch().is_some()) {
        tokio::spawn(stamp_loop(bee, cfg.clone()));
    }
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
    if offset >= ANCHOR_END {
        note_empty_anchor(ctx, round).await?;
    }
    // A prover that was down until the end of a round did not see its empty anchor in the round itself.
    if round > 0 {
        note_empty_anchor(ctx, round - 1).await?;
    }
    if ctx.no_anchor {
        return Ok(());
    }
    if (COMMIT_END..ANCHOR_END).contains(&offset) {
        anchor_commits(ctx, round).await
    } else if (REVEAL_ANCHOR_START..REVEAL_ANCHOR_END).contains(&offset) {
        anchor_reveals(ctx, round).await
    } else {
        Ok(())
    }
}

/// A round this prover did not anchor, but somebody anchored with an empty list (`anchorEmptyCommits`, the
/// liveness fallback): settle it too. Its inputs are all on chain (forced entries).
async fn note_empty_anchor(ctx: &Ctx, round: u64) -> Result<()> {
    if ctx.store.lock().await.get_mut(round).anchored.is_some() {
        return Ok(());
    }
    let ri = Settlement::new(ctx.settlement, &ctx.provider)
        .rounds(round)
        .call()
        .await?;
    if ri.anchored && ri.commitCount == 0 {
        info!(
            round,
            "round anchored with an empty list by somebody else; settling it from forced entries"
        );
        let mut store = ctx.store.lock().await;
        store.get_mut(round).anchored = Some(vec![]);
        store.save(round)?;
    }
    Ok(())
}

/// A round that another prover anchored: take its anchored lists, so this prover can settle the round when
/// the other one stops (else the round blocks every later round until its seed is gone). A list comes from
/// the messages this prover received itself, or else from the `dataRef` document on Swarm, and is used
/// only if it matches the hash on chain. Returns true when the stored lists now match the chain.
async fn adopt_anchor(ctx: &Ctx, round: u64) -> Result<bool> {
    let ri = Settlement::new(ctx.settlement, &ctx.provider)
        .rounds(round)
        .call()
        .await?;
    if !ri.anchored {
        return Ok(false);
    }
    let commits_ok = |l: &[SignedCommit]| {
        l.len() as u32 == ri.commitCount
            && commits_hash(&l) == ri.commitsHash
    };
    let reveals_ok =
        |l: &[Reveal]| l.len() as u32 == ri.revealCount && reveals_hash(l) == ri.revealsHash;

    let (anchored, reveals_anchored, own_commits, own_reveals) = {
        let mut store = ctx.store.lock().await;
        let m = store.get_mut(round);
        let mut own_reveals = m.reveals.clone();
        own_reveals.sort_by(|a, b| a.overlay.cmp(&b.overlay));
        (
            m.anchored.clone(),
            m.reveals_anchored.clone(),
            m.commits.values().cloned().collect::<Vec<_>>(),
            own_reveals,
        )
    };

    // An empty list (anchorEmptyCommits, when no prover anchored the round) matches even when this prover holds
    // commits that it never anchored: the round then settles from the forced entries.
    let commits = match anchored {
        Some(l) if commits_ok(&l) => Some(l),
        _ if commits_ok(&own_commits) => Some(own_commits),
        _ if commits_ok(&[]) => Some(vec![]),
        _ => anchored_doc(ctx, round, false)
            .await
            .and_then(|d| d.commits)
            .filter(|l| commits_ok(l)),
    };
    let reveals = if !ri.revealsAnchored {
        reveals_anchored
    } else {
        match reveals_anchored {
            Some(l) if reveals_ok(&l) => Some(l),
            _ if reveals_ok(&own_reveals) => Some(own_reveals),
            _ if reveals_ok(&[]) => Some(vec![]),
            _ => anchored_doc(ctx, round, true)
                .await
                .and_then(|d| d.reveals)
                .filter(|l| reveals_ok(l)),
        }
    };

    let ok = commits.is_some() && (!ri.revealsAnchored || reveals.is_some());
    let mut store = ctx.store.lock().await;
    let m = store.get_mut(round);
    if let Some(l) = commits {
        m.anchored = Some(l);
    }
    if ri.revealsAnchored && reveals.is_some() {
        m.reveals_anchored = reveals;
    }
    store.save(round)?;
    Ok(ok)
}

/// The `dataRef` document of the round's `CommitsAnchored` (or `RevealsAnchored`) event, from Swarm.
async fn anchored_doc(ctx: &Ctx, round: u64, reveals: bool) -> Option<RoundData> {
    let bee = ctx.bee.as_ref()?;
    let start = round * ROUND_LENGTH;
    let sig = if reveals {
        Settlement::RevealsAnchored::SIGNATURE_HASH
    } else {
        Settlement::CommitsAnchored::SIGNATURE_HASH
    };
    let logs = logs_in(ctx, ctx.settlement, sig, start, start + ROUND_LENGTH - 1)
        .await
        .ok()?;
    for log in logs {
        let (r, data_ref) = if reveals {
            let e = log
                .log_decode::<Settlement::RevealsAnchored>()
                .ok()?
                .inner
                .data;
            (e.round, e.dataRef)
        } else {
            let e = log
                .log_decode::<Settlement::CommitsAnchored>()
                .ok()?
                .inner
                .data;
            (e.round, e.dataRef)
        };
        if r != round {
            continue;
        }
        match bee.fetch::<RoundData>(data_ref).await {
            Ok(doc) if doc.round == round && doc.settlement == ctx.settlement => return Some(doc),
            Ok(_) => warn!(round, %data_ref, "dataRef document is for another round"),
            Err(e) => warn!(round, %data_ref, "dataRef document not found on Swarm: {e:#}"),
        }
    }
    None
}

/// Fix the round's off-chain commit list on chain (anchorCommits).
async fn anchor_commits(ctx: &Ctx, round: u64) -> Result<()> {
    if ctx.store.lock().await.get_mut(round).anchored.is_some() {
        return Ok(());
    }

    let s = Settlement::new(ctx.settlement, &ctx.provider);
    if s.rounds(round).call().await?.anchored {
        if adopt_anchor(ctx, round).await? {
            info!(round, "anchored by another prover; this prover has the anchored list, so it can settle the round too");
        } else {
            // Wait: settle_tick tries again to get the list.
            warn!(
                round,
                "anchored by another prover with a list this prover does not have"
            );
            ctx.store
                .lock()
                .await
                .get_mut(round)
                .anchored
                .get_or_insert_with(Vec::new);
        }
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
    let hash = commits_hash(&list);
    let doc = RoundData {
        version: DATA_VERSION,
        chain_id: ctx.chain_id,
        settlement: ctx.settlement,
        round,
        commits: Some(list.clone()),
        reveals: None,
    };
    let (data_ref, uploaded, bytes) = Bee::publish(ctx.bee.as_ref(), &doc).await;
    ctx.store
        .lock()
        .await
        .write_file(round, "commits-data.json", &bytes)?;

    let _g = ctx.tx_lock.lock().await;
    let nonce = ctx
        .provider
        .get_transaction_count(ctx.from)
        .pending()
        .await?;
    let receipt = s
        .anchorCommits(round, hash, list.len() as u32, data_ref)
        .nonce(nonce)
        .send()
        .await?
        .with_timeout(Some(TX_TIMEOUT))
        .get_receipt()
        .await?;
    if !receipt.status() {
        // Another prover anchored first (AlreadyAnchored), in the same block or the one before.
        let tx = receipt.transaction_hash;
        if adopt_anchor(ctx, round).await? {
            warn!(round, %tx, "anchorCommits reverted: another prover anchored the same list");
        } else {
            warn!(round, %tx, "anchorCommits reverted: another prover anchored a list this prover does not have");
        }
        return Ok(());
    }
    info!(round, commits = list.len(), %data_ref, uploaded, tx = %receipt.transaction_hash, "anchored");
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
    let doc = RoundData {
        version: DATA_VERSION,
        chain_id: ctx.chain_id,
        settlement: ctx.settlement,
        round,
        commits: None,
        reveals: Some(list.clone()),
    };
    let (data_ref, uploaded, bytes) = Bee::publish(ctx.bee.as_ref(), &doc).await;
    ctx.store
        .lock()
        .await
        .write_file(round, "reveals-data.json", &bytes)?;

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
    if !receipt.status() {
        // Another prover anchored the reveals first; settle_tick takes its list (adopt_anchor).
        warn!(round, tx = %receipt.transaction_hash, "anchorReveals reverted: another prover anchored the reveals");
        return Ok(());
    }
    info!(round, reveals = list.len(), %data_ref, uploaded, tx = %receipt.transaction_hash, "reveals anchored");
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
        // The seed must still be readable on chain (EIP-2935 window; 256 blocks where the history contract
        // is missing, for example on anvil). If not, the round can never settle, and Settlement lets
        // later rounds pass it.
        let seed_gone = match s.seedBlockHash(round).call().await {
            // SeedNotAvailable(): only this revert, not an RPC error, means the seed is gone.
            Err(e) => format!("{e:?}").contains("52d1ee1c"),
            Ok(_) => false,
        };
        if block - sb > HISTORY_SERVE_WINDOW || seed_gone {
            mark_failed(ctx, round, "seed no longer available").await?;
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
                // Another prover may have anchored lists that differ from the stored ones.
                if adopt_anchor(ctx, round).await.unwrap_or(false) {
                    info!(round, "took the anchored lists of another prover");
                } else if block >= (round + 1 + PENDING_ROUNDS) * ROUND_LENGTH {
                    // Settlement lets later rounds pass this one now (PENDING_ROUNDS).
                    mark_failed(
                        ctx,
                        round,
                        &format!("no round input after {PENDING_ROUNDS} rounds: {e:#}"),
                    )
                    .await?;
                    continue;
                } else {
                    warn!(round, "cannot build the round input yet: {e:#}");
                }
                break;
            }
        };
        // A truth without a valid witness can only settle once the claim window is closed: the winner
        // (or any truth-teller) can still send it, or call forceClaim.
        let native = input.run()?;
        if native.unclaimed() && block < (round + 1) * ROUND_LENGTH {
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
) -> Result<Job> {
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
    if commits_hash(&commits) != ri.commitsHash
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

    // Randomness from prevrandao in the two headers (checked against their block hashes).
    let (rnd, anchor_header, seed_header) =
        swarm_prover::round_randomness(&ctx.provider, round).await?;

    // The stake record and the game key of each entry, as GameKeyRegistry.commitmentOf will read them:
    // one for each anchored commit, then one for each forced commit.
    let staking = StakeRegistry::new(s.Stakes().call().await?, &ctx.provider);
    let keys = GameKeyRegistry::new(s.GameKeys().call().await?, &ctx.provider);
    let mut stakes = vec![];
    for owner in commits
        .iter()
        .map(|c| c.owner)
        .chain(forced_commits.iter().map(|c| c.owner))
    {
        let r = staking.stakes(owner).call().await?;
        let k = keys.keys(owner).call().await?;
        stakes.push(Stake {
            owner,
            overlay: r.overlay,
            committed_stake: r.committedStake,
            potential_stake: r.potentialStake,
            height: r.height,
            last_updated: r.lastUpdatedBlockNumber.saturating_to::<u64>(),
            key: swarm_vm::Point { x: k.x, y: k.y },
            // As Settlement._stakeInputs decides it.
            frozen: !r.lastUpdatedBlockNumber.is_zero()
                && s.frozenUntil(owner).call().await? == r.lastUpdatedBlockNumber,
        });
    }

    let input = RoundInput {
        chain_id: ctx.chain_id.to::<u64>(),
        settlement: ctx.settlement,
        round,
        round_anchor: rnd.round_anchor,
        selection_seed: rnd.selection_seed,
        commits,
        forced_commits,
        reveals,
        forced_reveals,
        stakes,
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
        fee_recipient: ctx.from,
    };

    // The batches of the candidate witnesses, as ClaimVerifier reads them on chain.
    let claim = claim.or(stored_claim);
    let stamps = PostageStamp::new(s.PostageContract().call().await?, &ctx.provider);
    let out_payment = stamps.currentTotalOutPayment().call().await?;
    let mut batches: Vec<swarm_vm::claim::BatchRecord> = vec![];
    for w in claim
        .iter()
        .chain(&forced_claims)
        .filter_map(|b| swarm_vm::claim::ClaimWitness::decode(b))
    {
        for id in w.batch_ids() {
            if batches.iter().any(|b| b.batch_id == id) {
                continue;
            }
            let b = stamps.batches(id).call().await?;
            let alive = b.owner != Address::ZERO && b.normalisedBalance > out_payment;
            batches.push(swarm_vm::claim::BatchRecord {
                batch_id: id,
                owner: if alive { b.owner } else { Address::ZERO },
                depth: b.depth,
                bucket_depth: b.bucketDepth,
            });
        }
    }
    Ok(Job {
        input,
        anchor_header,
        seed_header,
        claim,
        forced_claims,
        sample_max_value: s.sampleMaxValue().call().await?,
        batches,
    })
}


const LOG_CHUNK: u64 = 10_000;

/// Logs of one event of one contract in [from, to], in chunks of LOG_CHUNK blocks.
async fn logs_in(
    ctx: &Ctx,
    address: Address,
    signature: B256,
    from: u64,
    to: u64,
) -> Result<Vec<alloy::rpc::types::Log>> {
    let mut out = vec![];
    let mut start = from;
    while start <= to {
        let end = (start + LOG_CHUNK - 1).min(to);
        let filter = Filter::new()
            .address(address)
            .from_block(start)
            .to_block(end)
            .event_signature(signature);
        out.extend(ctx.provider.get_logs(&filter).await?);
        start = end + 1;
    }
    Ok(out)
}

/// Watch the upload batch: warn, or top up, when it has less than SWARM_MIN_TTL_DAYS left.
async fn stamp_loop(bee: Bee, cfg: Config) {
    let batch = bee.batch().unwrap_or_default().to_string();
    loop {
        match bee.stamp(&batch).await {
            Ok(st) => {
                let days = st.ttl_secs as f64 / 86_400.0;
                if !st.usable {
                    warn!(%batch, "postage batch not usable yet");
                } else if days < cfg.swarm_min_ttl_days {
                    if cfg.swarm_topup_days > 0.0 {
                        let r = async {
                            let price = bee.chainstate().await?.current_price;
                            let amount = swarm_prover::swarm::amount_for_days(
                                price,
                                cfg.swarm_topup_days,
                                cfg.swarm_block_secs,
                            );
                            bee.topup(&batch, amount).await?;
                            anyhow::Ok(amount)
                        }
                        .await;
                        match r {
                            Ok(amount) => info!(%batch, days, %amount, "postage batch topped up"),
                            Err(e) => warn!(%batch, days, "postage batch top-up failed: {e:#}"),
                        }
                    } else {
                        warn!(%batch, days, "postage batch runs low: top it up (swarm-prover stamp topup)");
                    }
                } else {
                    info!(%batch, days = days as u64, utilization = st.utilization, "postage batch");
                }
            }
            Err(e) => warn!(%batch, "postage batch status: {e:#}"),
        }
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
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
    // Not past the head: some RPC providers reject a range that ends in the future.
    let head = ctx.provider.get_block_number().await?;
    let filter = Filter::new()
        .address(ctx.settlement)
        .from_block(start)
        .to_block((start + REVEAL_END).min(head))
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

/// The arguments of `Settlement.settleRound` for this round.
fn settlement_args(
    job: &Job,
    native: &Native,
    slot: u8,
    proof: Bytes,
) -> (Settlement::Outcome, Settlement::Evidence) {
    let pv = &native.pv;
    (
        Settlement::Outcome {
            round: pv.round,
            hasReveals: pv.has_reveals,
            truthHash: pv.truth_hash,
            truthDepth: pv.truth_depth,
            winner: pv.winner,
            redundancy: pv.redundancy,
            feeRecipient: pv.fee_recipient,
            owners: pv.owners.clone(),
            freeze: pv.freeze.clone().into(),
        },
        Settlement::Evidence {
            gameCircuit: slot,
            proof,
            anchorHeader: job.anchor_header.clone(),
            seedHeader: job.seed_header.clone(),
            claimWitness: native.witness.clone().unwrap_or_default(),
            // "Unclaimed" must show that every forced claim fails.
            forcedClaims: if native.unclaimed() {
                job.forced_claims.clone()
            } else {
                vec![]
            },
        },
    )
}

async fn settle(ctx: &Ctx, round: u64, job: Job) -> Result<()> {
    ctx.store
        .lock()
        .await
        .write_file(round, "input.json", &serde_json::to_vec_pretty(&job)?)?;
    let native = job.run()?;
    // The smallest game circuit that holds the round: fewer public inputs cost less gas.
    let i = &job.input;
    let need = (i.commits.len() + i.forced_commits.len()).max(i.reveals.len() + i.forced_reveals.len());
    let (slot, p) = *ctx
        .games
        .iter()
        .find(|(_, p)| need <= *p)
        .ok_or_else(|| anyhow!("the round has {need} entries, more than the largest game circuit holds"))?;
    let caps = swarm_vm::Caps { p };
    // Identifies the statement that the proof is for.
    let digest = alloy::primitives::keccak256(
        native
            .pv
            .game_inputs(&caps)
            .iter()
            .flat_map(|x| x.to_be_bytes::<32>())
            .collect::<Vec<u8>>(),
    )
    .to_string();

    // A free check before a proof: simulate settleRound with an empty proof. Only the verifier may
    // revert. Any Settlement error means the round cannot settle now (wrong inputs, or an earlier round
    // is pending).
    let (out, ev) = settlement_args(&job, &native, slot, Bytes::new());
    if let Err(e) = Settlement::new(ctx.settlement, &ctx.provider)
        .settleRound(out, ev)
        .from(ctx.from)
        .call()
        .await
    {
        if let Some(err) = e.as_decoded_interface_error::<Settlement::SettlementErrors>() {
            // ProofInvalid is the expected result for the empty proof: every check before the verifier
            // passed.
            if matches!(err, Settlement::SettlementErrors::ProofInvalid(_)) {
                // go on and prove
            } else if let Settlement::SettlementErrors::RoundPending(p) = &err {
                if ctx.pending.lock().await.replace(p.round) != Some(p.round) {
                    warn!(
                        round,
                        pending = p.round,
                        "not proving: an earlier anchored round can still settle and blocks this one"
                    );
                }
                if adopt_anchor(ctx, p.round).await.unwrap_or(false) {
                    info!(
                        round = p.round,
                        "took the anchored lists of the pending round"
                    );
                }
                return Ok(());
            } else {
                anyhow::bail!("not proving: settleRound would revert with {err:?}");
            }
        }
    }

    // A proof of the same public values from an earlier attempt (for example a settleRound that failed
    // to land): use it again.
    let cached = {
        let store = ctx.store.lock().await;
        std::fs::read(store.round_dir(round).join("proof.json")).ok()
    }
    .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
    .and_then(|v| {
        let proof: Bytes = v["proof"].as_str()?.parse().ok()?;
        (v["digest"].as_str()? == digest).then_some(proof)
    });
    let proof = match cached {
        Some(p) => {
            info!(round, "reusing the stored proof of this round");
            p
        }
        None => {
            info!(
                round,
                entries = native.pv.owners.len(),
                has_reveals = native.pv.has_reveals,
                claimed = native.claimed(),
                winner = %native.pv.winner,
                redundancy = native.pv.redundancy,
                freezes = native.pv.freeze.iter().filter(|f| **f != 0).count(),
                "round computed, proving"
            );
            let witness = swarm_vm::game_witness_json(&job.input, &native.pv, &caps)
                .map_err(|e| anyhow!("witness: {e:?}"))?;
            let g = prover::prove(&ctx.snarkd, &witness).await?;
            info!(
                round,
                prove_ms = g.prove_ms,
                constraints = g.constraints,
                commits = p,
                "game proof"
            );
            let store = ctx.store.lock().await;
            store.write_file(
                round,
                "proof.json",
                &serde_json::to_vec_pretty(&serde_json::json!({
                    "digest": digest,
                    "proof": Bytes::from(g.proof.clone()),
                    "proveMs": g.prove_ms,
                    "constraints": g.constraints,
                }))?,
            )?;
            Bytes::from(g.proof)
        }
    };
    let (out, ev) = settlement_args(&job, &native, slot, proof);
    send_settlement(ctx, round, out, ev).await
}

async fn send_settlement(
    ctx: &Ctx,
    round: u64,
    out: Settlement::Outcome,
    ev: Settlement::Evidence,
) -> Result<()> {
    let s = Settlement::new(ctx.settlement, &ctx.provider);
    // One transaction at a time from this key (see anchor_commits).
    let _g = ctx.tx_lock.lock().await;
    let nonce = ctx
        .provider
        .get_transaction_count(ctx.from)
        .pending()
        .await?;
    // A margin on the gas estimate: the gas can be higher in the block that includes the transaction
    // than in the estimate. The pot accounting inside settleRound stores a
    // cut after a seed block and closes the buckets that the outpayment passed.
    let call = s.settleRound(out, ev).nonce(nonce);
    let gas = call.estimate_gas().await? * 13 / 10 + 100_000;
    let receipt = call
        .gas(gas)
        .send()
        .await?
        .with_timeout(Some(TX_TIMEOUT))
        .get_receipt()
        .await?;
    if !receipt.status() {
        anyhow::bail!("settleRound reverted: {}", receipt.transaction_hash);
    }
    info!(round, tx = %receipt.transaction_hash, gas = receipt.gas_used, "settled");
    {
        let mut store = ctx.store.lock().await;
        store.get_mut(round).settle_tx = Some(receipt.transaction_hash.to_string());
        store.save(round)?;
    }
    Ok(())
}
