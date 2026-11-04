//! node-sim: plays the Bee side of the off-chain game for a set of staked keys.
//!
//! Each round, for every node: check neighbourhood eligibility against the round anchor (from prevrandao
//! of the block before the round, read from its header), commit
//! (signed message to the prover, or forceCommit on chain), then reveal (to the prover, or forceReveal).
//! Behaviours per node index let you exercise the paths that matter:
//!
//!   --silent 3      node 3 commits and never reveals          -> frozen for non-reveal
//!   --liar 4        node 4 commits to a different reserve hash -> frozen for disagreement (if it loses)
//!   --forced 2      node 2 uses forceCommit / forceReveal / forceClaim -> the escape hatches
//!   --no-claim 1    node 1 never sends the claim witness       -> the round settles unclaimed if it wins
//!
//! Every other node uses the prover, then checks it was not censored, as a Bee node must: after the
//! anchor phase it compares the anchored commit list with Settlement.rounds and calls forceCommit if its
//! commit is missing; after the reveal anchor phase it does the same for its reveal with forceReveal
//! (also when the prover anchored no reveals at all). Start the prover with CENSOR_COMMITS or
//! CENSOR_REVEALS to see this work.
//!
//! Honest nodes share one simulated reserve: `--reserve` chunks of 32 bytes, all stamped by one postage
//! batch whose owner key is `--batch-owner-key`. Each round they compute the real reserve sample (the 16
//! chunks with the smallest anchor-keyed transformed addresses) and commit to its hash. After the seed
//! block, the honest winner builds the three claim proofs (BMT inclusion, transformed BMT, postage stamp)
//! and sends them to the prover, or posts them with forceClaim.
//!
//! The reserve must be large enough that the 16th smallest transformed address passes Redistribution's
//! reserve size estimate (sampleMaxValue): about 1.5M chunks at depth 0, twice that for each extra depth.
//!
//! Staking itself is done once, with scripts/zk/setup-nodes.ts.

use alloy::{
    network::EthereumWallet,
    primitives::{keccak256, Address, Bytes, B256, U256},
    providers::{DynProvider, Provider, ProviderBuilder},
    signers::{local::PrivateKeySigner, SignerSync},
};
use anyhow::{bail, Context, Result};
use clap::Parser;
use rand::RngCore;
use rayon::prelude::*;
use std::sync::Arc;
use std::{collections::HashMap, time::Duration};
use swarm_prover::{
    offset_of, round_of, ClaimMsg, CommitMsg, OutcomeMsg, PostageStamp, RevealMsg, Settlement,
    StakeRegistry, ANCHOR_END, CLAIM_START, COMMIT_END, REVEAL_ANCHOR_END, REVEAL_ANCHOR_START,
    REVEAL_END, REVEAL_START, ROUND_LENGTH,
};
use swarm_vm::{
    claim::{address_to_bucket, PostageProof},
    commit_digest, in_proximity,
    sample::{FastHasher, Sample, SampleEntry, SAMPLE_SIZE},
    wrap_commit,
};
use tracing::{info, warn};

#[derive(Parser)]
#[command(about)]
struct Args {
    #[arg(long, env = "RPC_URL")]
    rpc_url: String,
    #[arg(long, env = "SETTLEMENT_ADDRESS")]
    settlement: Address,
    #[arg(long, env = "PROVER_URL", default_value = "http://127.0.0.1:8080")]
    prover_url: String,
    /// Comma-separated private keys of staked nodes.
    #[arg(long, env = "NODE_KEYS", value_delimiter = ',')]
    keys: Vec<String>,
    /// Storage depth every node reports.
    #[arg(long, default_value_t = 1)]
    depth: u8,
    #[arg(long, value_delimiter = ',')]
    silent: Vec<usize>,
    #[arg(long, value_delimiter = ',')]
    liar: Vec<usize>,
    #[arg(long, value_delimiter = ',')]
    forced: Vec<usize>,
    #[arg(long, value_delimiter = ',')]
    no_claim: Vec<usize>,
    /// Chunks in the shared simulated reserve.
    #[arg(long, default_value_t = 3_000_000)]
    reserve: u64,
    /// Owner key of the postage batch that stamps the reserve (the deployer on zklocal).
    #[arg(long, env = "BATCH_OWNER_KEY")]
    batch_owner_key: String,
    /// Batch id. Defaults to the batch deploy/zk/002_roles_and_pot.ts creates.
    #[arg(long, env = "BATCH_ID")]
    batch_id: Option<B256>,
    /// Do not call forceClaim when the round is not settled by block 58 (to test a withholding prover).
    #[arg(long)]
    no_claim_backstop: bool,
    /// Stop after this many rounds (0 = run forever).
    #[arg(long, default_value_t = 0)]
    rounds: u64,
}

struct Node {
    idx: usize,
    signer: PrivateKeySigner,
    provider: DynProvider,
    overlay: B256,
    height: u8,
}

#[derive(Clone)]
struct Played {
    depth: u8,
    hash: B256,
    nonce: B256,
    obfuscated: B256,
    revealed: bool,
    claimed: bool,
    /// The commit is on chain (forced) or was found in the anchored list.
    commit_safe: bool,
    /// The reveal is on chain (forced) or was found in the anchored list.
    reveal_safe: bool,
    /// forceCommit / forceReveal sent but not yet confirmed. A failed one is sent again while its
    /// window is open.
    commit_tx: Option<B256>,
    reveal_tx: Option<B256>,
}

/// Gas limit of forceCommit and forceReveal. Not estimated: an estimate made against the pending
/// state can assume an earlier forced entry of the round has already written the round's slots. When
/// the block builder orders that entry later, the cheaper estimate runs out of gas (seen on Sepolia,
/// where a first write costs about 240k and a later one about 48k).
const FORCE_GAS: u64 = 600_000;
/// forceClaim: the same, plus the calldata of a witness of up to 16 KB.
const FORCE_CLAIM_GAS: u64 = 1_500_000;

/// The shared simulated reserve: chunk i is the 32-byte payload with i in its first 8 bytes.
struct Reserve {
    /// Plain chunk address of each payload; independent of the round.
    originals: Vec<B256>,
}

fn payload(i: u64) -> B256 {
    let mut p = B256::ZERO;
    p[..8].copy_from_slice(&i.to_be_bytes());
    p
}

impl Reserve {
    fn new(n: u64) -> Self {
        let fast = FastHasher::new(B256::ZERO);
        Reserve {
            originals: (0..n)
                .into_par_iter()
                .map(|i| fast.original(payload(i)))
                .collect(),
        }
    }

    /// The round's reserve sample: the 16 chunks in the neighbourhood with the smallest transformed
    /// addresses, as a Bee node computes it.
    fn sample(&self, anchor: B256, depth: u8) -> Sample {
        let fast = FastHasher::new(anchor);
        let mut found: Vec<(B256, u64)> = self
            .originals
            .par_iter()
            .enumerate()
            .filter(|(_, o)| in_proximity(**o, anchor, depth))
            .map(|(i, _)| (fast.transformed(payload(i as u64)), i as u64))
            .collect();
        found.sort_unstable();
        let entries: Vec<SampleEntry> = found[..SAMPLE_SIZE]
            .iter()
            .map(|(t, i)| {
                let e = SampleEntry::new(payload(*i).to_vec(), &anchor);
                debug_assert_eq!(e.transformed, *t);
                e
            })
            .collect();
        Sample::new(entries)
    }
}

struct Batch {
    id: B256,
    bucket_depth: u8,
    owner: PrivateKeySigner,
}

impl Batch {
    /// A Bee postage stamp: index = bucket << 32 | 0, signed by the batch owner.
    fn stamp(&self, addr: B256) -> PostageProof {
        let index = (address_to_bucket(addr, self.bucket_depth) as u64) << 32;
        let ts = 1_700_000_000u64;
        let mut msg = Vec::with_capacity(80);
        msg.extend_from_slice(addr.as_slice());
        msg.extend_from_slice(self.id.as_slice());
        msg.extend_from_slice(&index.to_be_bytes());
        msg.extend_from_slice(&ts.to_be_bytes());
        let sig = self
            .owner
            .sign_message_sync(keccak256(msg).as_slice())
            .expect("sign");
        PostageProof {
            signature: Bytes::from(sig.as_bytes().to_vec()),
            postageId: self.id,
            index,
            timeStamp: ts,
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenv::dotenv().ok();
    tracing_subscriber::fmt().with_env_filter("info").init();
    let args = Args::parse();
    if args.keys.is_empty() {
        bail!("no --keys / NODE_KEYS");
    }

    let read = ProviderBuilder::new()
        .connect_http(args.rpc_url.parse()?)
        .erased();
    let chain_id = U256::from(read.get_chain_id().await?);
    let settlement = Settlement::new(args.settlement, &read);
    let staking = StakeRegistry::new(settlement.Stakes().call().await?, &read);

    // The Rust commit digest must match the contract's, or every off-chain commit is dropped.
    let probe = keccak256(b"probe");
    if settlement.commitDigest(1, probe).call().await?
        != commit_digest(chain_id, args.settlement, 1, probe)
    {
        bail!("commit digest mismatch between swarm-vm and Settlement.commitDigest");
    }

    let mut nodes = vec![];
    for (idx, key) in args.keys.iter().enumerate() {
        let signer: PrivateKeySigner = key.trim().parse().with_context(|| format!("key {idx}"))?;
        let owner = signer.address();
        let overlay = staking.overlayOfAddress(owner).call().await?;
        if overlay.is_zero() {
            bail!("node {idx} ({owner}) is not staked; run scripts/zk/setup-nodes.ts first");
        }
        let height = staking.heightOfAddress(owner).call().await?;
        let provider = ProviderBuilder::new()
            .wallet(EthereumWallet::from(signer.clone()))
            .connect_http(args.rpc_url.parse()?)
            .erased();
        info!(idx, %owner, %overlay, height, "node");
        nodes.push(Node {
            idx,
            signer,
            provider,
            overlay,
            height,
        });
    }

    // Postage batch that stamps the reserve.
    let owner: PrivateKeySigner = args
        .batch_owner_key
        .trim()
        .parse()
        .context("--batch-owner-key")?;
    let batch_id = args.batch_id.unwrap_or_else(|| {
        let nonce = keccak256(b"zk-settlement-pot");
        let mut buf = [0u8; 64];
        buf[12..32].copy_from_slice(owner.address().as_slice());
        buf[32..].copy_from_slice(nonce.as_slice());
        keccak256(buf)
    });
    let postage = PostageStamp::new(settlement.PostageContract().call().await?, &read);
    let b = postage.batches(batch_id).call().await?;
    if b.owner != owner.address() {
        bail!(
            "batch {batch_id} is owned by {}, not by the --batch-owner-key",
            b.owner
        );
    }
    let batch = Arc::new(Batch {
        id: batch_id,
        bucket_depth: b.bucketDepth,
        owner,
    });
    let sample_max = settlement.sampleMaxValue().call().await?;

    let started = std::time::Instant::now();
    let reserve = Arc::new(
        tokio::task::spawn_blocking({
            let n = args.reserve;
            move || Reserve::new(n)
        })
        .await?,
    );
    info!(chunks = args.reserve, batch = %batch_id, elapsed = ?started.elapsed(), "reserve ready");

    // A prover can stall its answers to eat a 4-block window: never wait long. No answer means force.
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()?;
    let mut played: HashMap<(u64, usize), Played> = HashMap::new();
    let mut samples: HashMap<u64, Arc<Sample>> = HashMap::new();
    let mut first_round = None;
    let mut backstop_done: std::collections::HashSet<u64> = Default::default();

    loop {
        let block = read.get_block_number().await?;
        let (round, offset) = (round_of(block), offset_of(block));
        let first = *first_round.get_or_insert(round);
        // Run until the claim phase of the last round is over.
        if args.rounds > 0 && round > first + args.rounds {
            info!("done");
            return Ok(());
        }

        // Commit phase. Leave two blocks of margin so the message or tx lands in time.
        if offset + 2 < COMMIT_END && (args.rounds == 0 || round < first + args.rounds) {
            let (anchor, _) = swarm_prover::round_anchor(&read, round).await?;
            if !samples.contains_key(&round) {
                let started = std::time::Instant::now();
                let (r, depth) = (reserve.clone(), args.depth);
                let s = tokio::task::spawn_blocking(move || r.sample(anchor, depth)).await?;
                let last = U256::from_be_bytes(s.entries[SAMPLE_SIZE - 1].transformed.0);
                if last >= sample_max {
                    warn!(
                        round,
                        "reserve too small: the sample fails the size estimate; raise --reserve"
                    );
                }
                info!(round, hash = %s.hash(), elapsed = ?started.elapsed(), "reserve sample");
                samples.insert(round, Arc::new(s));
            }
            let honest_hash = samples[&round].hash();
            for n in &nodes {
                if played.contains_key(&(round, n.idx)) {
                    continue;
                }
                let depth = args.depth;
                if depth < n.height || !in_proximity(n.overlay, anchor, depth - n.height) {
                    info!(round, node = n.idx, "not in the round's neighbourhood");
                    played.insert(
                        (round, n.idx),
                        Played {
                            depth,
                            hash: B256::ZERO,
                            nonce: B256::ZERO,
                            obfuscated: B256::ZERO,
                            revealed: true,
                            claimed: true,
                            commit_safe: true,
                            reveal_safe: true,
                            commit_tx: None,
                            reveal_tx: None,
                        },
                    );
                    continue;
                }
                // Honest nodes in the neighbourhood agree on the reserve commitment.
                let hash = if args.liar.contains(&n.idx) {
                    keccak256([b"lie".as_slice(), n.overlay.as_slice()].concat())
                } else {
                    honest_hash
                };
                let mut nonce = B256::ZERO;
                rand::thread_rng().fill_bytes(nonce.as_mut_slice());
                let obf = wrap_commit(n.overlay, depth, hash, nonce);

                let res = if args.forced.contains(&n.idx) {
                    Settlement::new(args.settlement, &n.provider)
                        .forceCommit(round, obf)
                        .gas(FORCE_GAS)
                        .send()
                        .await
                        .map(|tx| ("forceCommit tx".to_string(), Some(*tx.tx_hash())))
                        .map_err(anyhow::Error::from)
                } else {
                    let digest = commit_digest(chain_id, args.settlement, round, obf);
                    let sig = n.signer.sign_message_sync(digest.as_slice())?;
                    let msg = CommitMsg {
                        round,
                        owner: n.signer.address(),
                        obfuscated_hash: obf,
                        signature: Bytes::from(sig.as_bytes().to_vec()),
                    };
                    post(&http, &format!("{}/v1/commit", args.prover_url), &msg)
                        .await
                        .map(|_| ("to prover".into(), None))
                };
                match res {
                    Ok((how, tx)) => {
                        info!(round, node = n.idx, how, "committed");
                        played.insert(
                            (round, n.idx),
                            Played {
                                depth,
                                hash,
                                nonce,
                                obfuscated: obf,
                                revealed: false,
                                claimed: false,
                                commit_safe: args.forced.contains(&n.idx),
                                reveal_safe: false,
                                commit_tx: tx,
                                reveal_tx: None,
                            },
                        );
                    }
                    Err(e) => warn!(round, node = n.idx, "commit failed: {e:#}"),
                }
            }
        }

        confirm_forced(&read, round, &mut played).await;

        // Commit check: the anchor phase is over, forceCommit is still open.
        if (ANCHOR_END..REVEAL_START - 1).contains(&offset) {
            check_commits(&args, &nodes, &http, &settlement, round, &mut played).await;
        }

        // Reveal phase: off-chain reveals until the reveal anchor phase, forceReveal until its end.
        if (REVEAL_START..REVEAL_END - 2).contains(&offset) {
            for n in &nodes {
                let Some(p) = played.get(&(round, n.idx)).cloned() else {
                    continue;
                };
                if p.revealed || args.silent.contains(&n.idx) {
                    continue;
                }
                let forced = args.forced.contains(&n.idx);
                if !forced && offset >= REVEAL_ANCHOR_START - 2 {
                    continue;
                }
                let res = if forced {
                    Settlement::new(args.settlement, &n.provider)
                        .forceReveal(round, n.overlay, p.depth, p.hash, p.nonce)
                        .gas(FORCE_GAS)
                        .send()
                        .await
                        .map(|tx| ("forceReveal tx".to_string(), Some(*tx.tx_hash())))
                        .map_err(anyhow::Error::from)
                } else {
                    let msg = RevealMsg {
                        round,
                        overlay: n.overlay,
                        depth: p.depth,
                        hash: p.hash,
                        nonce: p.nonce,
                    };
                    post(&http, &format!("{}/v1/reveal", args.prover_url), &msg)
                        .await
                        .map(|_| ("to prover".into(), None))
                };
                match res {
                    Ok((how, tx)) => {
                        info!(round, node = n.idx, how, "revealed");
                        let p = played.get_mut(&(round, n.idx)).unwrap();
                        p.revealed = true;
                        p.reveal_safe = forced;
                        p.reveal_tx = tx;
                    }
                    Err(e) => warn!(round, node = n.idx, "reveal failed: {e:#}"),
                }
            }
        }

        // Reveal check: the reveal anchor phase is over, forceReveal is still open.
        if (REVEAL_ANCHOR_END..REVEAL_END - 1).contains(&offset) {
            check_reveals(&args, &nodes, &http, &settlement, round, &mut played).await;
        }

        // Claim phase: the honest winner proves storage for the truth's sample.
        if offset >= CLAIM_START {
            claim_phase(&args, &nodes, &http, round, &mut played, &samples, &batch).await;
        }
        // Claim backstop: the prover may withhold the claim witness or lie in /outcome.
        if (CLAIM_BACKSTOP..ROUND_LENGTH - 1).contains(&offset) && !args.no_claim_backstop {
            claim_backstop(
                &args,
                &nodes,
                &settlement,
                round,
                &samples,
                &batch,
                &mut backstop_done,
            )
            .await;
        }

        played.retain(|(r, _), _| *r + 2 > round);
        samples.retain(|r, _| *r + 2 > round);
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// Check the receipts of forced transactions. A failed one clears the node's state so that it is sent
/// again while its window is open (by the commit check, the reveal loop or the reveal check).
async fn confirm_forced(
    read: &DynProvider,
    round: u64,
    played: &mut HashMap<(u64, usize), Played>,
) {
    for ((r, idx), p) in played.iter_mut().filter(|((r, _), _)| *r == round) {
        for (what, tx) in [("forceCommit", p.commit_tx), ("forceReveal", p.reveal_tx)] {
            let Some(hash) = tx else { continue };
            let Ok(Some(receipt)) = read.get_transaction_receipt(hash).await else {
                continue; // not mined yet
            };
            if receipt.status() {
                info!(round = r, node = idx, %hash, gas = receipt.gas_used, "{what} confirmed");
            } else {
                warn!(round = r, node = idx, %hash, "{what} failed on chain, sending it again");
                if what == "forceCommit" {
                    p.commit_safe = false;
                } else {
                    p.reveal_safe = false;
                    p.revealed = false;
                }
            }
            if what == "forceCommit" {
                p.commit_tx = None;
            } else {
                p.reveal_tx = None;
            }
        }
    }
}

/// From this block of a round, a node that revealed the honest sample calls forceClaim itself if the
/// round is not settled yet and nobody else did. An unclaimed round cannot settle before the round ends,
/// so "settled" here means settled with a winner.
const CLAIM_BACKSTOP: u64 = 58;

async fn claim_backstop(
    args: &Args,
    nodes: &[Node],
    settlement: &Settlement::SettlementInstance<&DynProvider>,
    round: u64,
    samples: &HashMap<u64, Arc<Sample>>,
    batch: &Batch,
    done: &mut std::collections::HashSet<u64>,
) {
    if done.contains(&round) {
        return;
    }
    let Some(sample) = samples.get(&round) else {
        return;
    };
    let ri = match settlement.rounds(round).call().await {
        Ok(ri) => ri,
        Err(e) => return warn!(round, "rounds: {e:#}"),
    };
    if !ri.anchored || ri.settled || ri.forcedClaimCount > 0 {
        done.insert(round);
        return;
    }
    let Ok((rnd, _, _)) = swarm_prover::round_randomness(settlement.provider(), round).await else {
        return;
    };
    let (anchor, seed) = (rnd.round_anchor, rnd.selection_seed);
    // Any honest node in the neighbourhood holds the same sample; the payout goes to the proven winner.
    let Some(n) = nodes.iter().find(|n| {
        !args.liar.contains(&n.idx)
            && !args.silent.contains(&n.idx)
            && !args.no_claim.contains(&n.idx)
    }) else {
        return;
    };
    let witness = Bytes::from(sample.witness(&anchor, seed, |a| batch.stamp(a)).encode());
    warn!(
        round,
        node = n.idx,
        "round not settled by block {CLAIM_BACKSTOP}: forceClaim as a backstop"
    );
    match Settlement::new(args.settlement, &n.provider)
        .forceClaim(round, witness)
        .gas(FORCE_CLAIM_GAS)
        .send()
        .await
    {
        Ok(_) => {
            info!(round, node = n.idx, "forceClaim tx (backstop)");
            done.insert(round);
        }
        Err(e) => warn!(round, node = n.idx, "forceClaim failed: {e:#}"),
    }
}

/// A Merkle proof from the prover that an entry is in an anchored list: (index, sibling hashes).
async fn inclusion_proof(http: &reqwest::Client, url: String) -> Option<(usize, Vec<B256>)> {
    let r = http.get(url).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    let v: serde_json::Value = r.json().await.ok()?;
    let index = v["index"].as_u64()? as usize;
    let proof = serde_json::from_value(v["proof"].clone()).ok()?;
    Some((index, proof))
}

/// After the anchor phase: a node checks that its commit is in the anchored list with a Merkle proof from
/// the prover against the root and count on chain. No proof, or a proof that does not check: forceCommit.
async fn check_commits(
    args: &Args,
    nodes: &[Node],
    http: &reqwest::Client,
    settlement: &Settlement::SettlementInstance<&DynProvider>,
    round: u64,
    played: &mut HashMap<(u64, usize), Played>,
) {
    let pending: Vec<usize> = nodes
        .iter()
        .filter(|n| played.get(&(round, n.idx)).is_some_and(|p| !p.commit_safe))
        .map(|n| n.idx)
        .collect();
    if pending.is_empty() {
        return;
    }
    let ri = match settlement.rounds(round).call().await {
        Ok(ri) => ri,
        Err(e) => return warn!(round, "rounds: {e:#}"),
    };
    if !ri.anchored {
        // No prover anchored the round: anchor it with an empty list (anchorEmpty, open to anybody from
        // block 20), then every node forces its commit below.
        let n = &nodes[pending[0]];
        match Settlement::new(args.settlement, &n.provider)
            .anchorEmpty(round)
            .gas(FORCE_GAS)
            .send()
            .await
        {
            Ok(tx) => match tx.get_receipt().await {
                Ok(r) if r.status() => warn!(
                    round,
                    node = n.idx,
                    "round not anchored by a prover: anchorEmpty"
                ),
                _ => return warn!(round, "anchorEmpty failed (another node may have done it)"),
            },
            Err(e) => return warn!(round, "anchorEmpty: {e:#}"),
        }
    }
    for idx in pending {
        let n = &nodes[idx];
        let p = played.get_mut(&(round, idx)).unwrap();
        let url = format!(
            "{}/v1/rounds/{round}/commit-proof/{}",
            args.prover_url,
            n.signer.address()
        );
        let leaf = swarm_vm::commit_leaf(&n.signer.address(), &p.obfuscated);
        let included = inclusion_proof(http, url).await.is_some_and(|(i, proof)| {
            swarm_vm::list_verify(ri.commitsHash, ri.commitCount, i, leaf, &proof)
        });
        if included {
            p.commit_safe = true;
            continue;
        }
        warn!(
            round,
            node = idx,
            "commit missing from the anchored list, forcing it"
        );
        match Settlement::new(args.settlement, &n.provider)
            .forceCommit(round, p.obfuscated)
            .gas(FORCE_GAS)
            .send()
            .await
        {
            Ok(tx) => {
                info!(round, node = idx, "forceCommit tx");
                p.commit_safe = true;
                p.commit_tx = Some(*tx.tx_hash());
            }
            Err(e) => warn!(round, node = idx, "forceCommit failed: {e:#}"),
        }
    }
}

/// After the reveal anchor phase: the same check for the reveal (Merkle proof against the anchored root
/// and count). No anchored reveals, no proof, or a bad proof: forceReveal.
async fn check_reveals(
    args: &Args,
    nodes: &[Node],
    http: &reqwest::Client,
    settlement: &Settlement::SettlementInstance<&DynProvider>,
    round: u64,
    played: &mut HashMap<(u64, usize), Played>,
) {
    let pending: Vec<usize> = nodes
        .iter()
        // Also nodes whose off-chain reveal failed: the prover may have refused it.
        .filter(|n| {
            !args.silent.contains(&n.idx)
                && played
                    .get(&(round, n.idx))
                    .is_some_and(|p| !p.reveal_safe && p.obfuscated != B256::ZERO)
        })
        .map(|n| n.idx)
        .collect();
    if pending.is_empty() {
        return;
    }
    let ri = match settlement.rounds(round).call().await {
        Ok(ri) => ri,
        Err(e) => return warn!(round, "rounds: {e:#}"),
    };
    for idx in pending {
        let n = &nodes[idx];
        let p = played.get_mut(&(round, idx)).unwrap();
        let mine = swarm_vm::Reveal {
            overlay: n.overlay,
            depth: p.depth,
            hash: p.hash,
            nonce: p.nonce,
        };
        let url = format!(
            "{}/v1/rounds/{round}/reveal-proof/{}",
            args.prover_url, n.overlay
        );
        let included = ri.revealsAnchored
            && inclusion_proof(http, url).await.is_some_and(|(i, proof)| {
                let leaf = swarm_vm::reveal_leaf(&mine);
                swarm_vm::list_verify(ri.revealsHash, ri.revealCount, i, leaf, &proof)
            });
        if included {
            p.reveal_safe = true;
            continue;
        }
        warn!(
            round,
            node = idx,
            reveals_anchored = ri.revealsAnchored,
            "reveal missing from the anchored list, forcing it"
        );
        match Settlement::new(args.settlement, &n.provider)
            .forceReveal(round, n.overlay, p.depth, p.hash, p.nonce)
            .gas(FORCE_GAS)
            .send()
            .await
        {
            Ok(tx) => {
                info!(round, node = idx, "forceReveal tx");
                p.revealed = true;
                p.reveal_safe = true;
                p.reveal_tx = Some(*tx.tx_hash());
            }
            Err(e) => warn!(round, node = idx, "forceReveal failed: {e:#}"),
        }
    }
}

async fn post<T: serde::Serialize>(http: &reqwest::Client, url: &str, body: &T) -> Result<()> {
    let r = http.post(url).json(body).send().await?;
    if !r.status().is_success() {
        bail!("{} {}", r.status(), r.text().await.unwrap_or_default());
    }
    Ok(())
}

async fn claim_phase(
    args: &Args,
    nodes: &[Node],
    http: &reqwest::Client,
    round: u64,
    played: &mut HashMap<(u64, usize), Played>,
    samples: &HashMap<u64, Arc<Sample>>,
    batch: &Batch,
) {
    let Some(sample) = samples.get(&round) else {
        return;
    };
    let pending: Vec<usize> = nodes
        .iter()
        .filter(|n| {
            played
                .get(&(round, n.idx))
                .is_some_and(|p| p.revealed && !p.claimed && p.hash == sample.hash())
        })
        .map(|n| n.idx)
        .collect();
    if pending.is_empty() {
        return;
    }

    let url = format!("{}/v1/rounds/{round}/outcome", args.prover_url);
    let outcome: OutcomeMsg = match http.get(&url).send().await {
        Ok(r) if r.status().is_success() => match r.json().await {
            Ok(o) => o,
            Err(e) => return warn!(round, "outcome: {e:#}"),
        },
        Ok(r) => return warn!(round, "outcome: {}", r.status()),
        Err(e) => return warn!(round, "outcome: {e:#}"),
    };

    for idx in pending {
        let n = &nodes[idx];
        let p = played.get_mut(&(round, idx)).unwrap();
        if !outcome.has_truth || outcome.truth_hash != sample.hash() || outcome.claimed {
            p.claimed = true; // nothing to do for this node
            continue;
        }
        if outcome.winner != n.signer.address() {
            continue; // the winner sends it
        }
        p.claimed = true;
        if args.no_claim.contains(&idx) {
            info!(
                round,
                node = idx,
                "winner, withholding the claim witness (--no-claim)"
            );
            continue;
        }
        let witness = Bytes::from(
            sample
                .witness(&outcome.round_anchor, outcome.selection_seed, |a| {
                    batch.stamp(a)
                })
                .encode(),
        );
        let res = if args.forced.contains(&idx) {
            Settlement::new(args.settlement, &n.provider)
                .forceClaim(round, witness)
                .gas(FORCE_CLAIM_GAS)
                .send()
                .await
                .map(|_| "forceClaim tx".to_string())
                .map_err(anyhow::Error::from)
        } else {
            let msg = ClaimMsg { round, witness };
            post(http, &format!("{}/v1/claim", args.prover_url), &msg)
                .await
                .map(|_| "to prover".into())
        };
        match res {
            Ok(how) => info!(round, node = idx, how, "claim witness sent"),
            Err(e) => warn!(round, node = idx, "claim failed: {e:#}"),
        }
    }
}
