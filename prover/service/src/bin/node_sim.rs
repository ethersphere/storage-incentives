//! node-sim: plays the Bee side of the off-chain game for a set of staked keys.
//!
//! Each round, for every node: check neighbourhood eligibility against Settlement.roundAnchor, commit
//! (signed message to the prover, or forceCommit on chain), then reveal (to the prover, or forceReveal).
//! Behaviours per node index let you exercise the paths that matter:
//!
//!   --silent 3      node 3 commits and never reveals          -> frozen for non-reveal
//!   --liar 4        node 4 commits to a different reserve hash -> frozen for disagreement (if it loses)
//!   --forced 2      node 2 uses forceCommit / forceReveal / forceClaim -> the escape hatches
//!   --no-claim 1    node 1 never sends the claim witness       -> the round settles unclaimed if it wins
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
use std::{collections::HashMap, time::Duration};
use rayon::prelude::*;
use std::sync::Arc;
use swarm_prover::{
    offset_of, round_of, ClaimMsg, CommitMsg, OutcomeMsg, PostageStamp, RevealMsg, Settlement,
    StakeRegistry, ANCHOR_END, CLAIM_START, COMMIT_END, REVEAL_END,
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
    revealed: bool,
    claimed: bool,
}

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
        Reserve { originals: (0..n).into_par_iter().map(|i| fast.original(payload(i))).collect() }
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
        let sig = self.owner.sign_message_sync(keccak256(msg).as_slice()).expect("sign");
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
    let owner: PrivateKeySigner = args.batch_owner_key.trim().parse().context("--batch-owner-key")?;
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
        bail!("batch {batch_id} is owned by {}, not by the --batch-owner-key", b.owner);
    }
    let batch = Arc::new(Batch { id: batch_id, bucket_depth: b.bucketDepth, owner });
    let sample_max = settlement.sampleMaxValue().call().await?;

    let started = std::time::Instant::now();
    let reserve = Arc::new(tokio::task::spawn_blocking({
        let n = args.reserve;
        move || Reserve::new(n)
    })
    .await?);
    info!(chunks = args.reserve, batch = %batch_id, elapsed = ?started.elapsed(), "reserve ready");

    let http = reqwest::Client::new();
    let mut played: HashMap<(u64, usize), Played> = HashMap::new();
    let mut samples: HashMap<u64, Arc<Sample>> = HashMap::new();
    let mut first_round = None;

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
            let anchor = settlement.roundAnchor(round).call().await?;
            if !samples.contains_key(&round) {
                let started = std::time::Instant::now();
                let (r, depth) = (reserve.clone(), args.depth);
                let s = tokio::task::spawn_blocking(move || r.sample(anchor, depth)).await?;
                let last = U256::from_be_bytes(s.entries[SAMPLE_SIZE - 1].transformed.0);
                if last >= sample_max {
                    warn!(round, "reserve too small: the sample fails the size estimate; raise --reserve");
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
                            revealed: true,
                            claimed: true,
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
                        .send()
                        .await
                        .map(|_| "forceCommit tx".to_string())
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
                        .map(|_| "to prover".into())
                };
                match res {
                    Ok(how) => {
                        info!(round, node = n.idx, how, "committed");
                        played.insert(
                            (round, n.idx),
                            Played {
                                depth,
                                hash,
                                nonce,
                                revealed: false,
                                claimed: false,
                            },
                        );
                    }
                    Err(e) => warn!(round, node = n.idx, "commit failed: {e:#}"),
                }
            }
        }

        // Reveal phase.
        if (ANCHOR_END..REVEAL_END - 2).contains(&offset) {
            for n in &nodes {
                let Some(p) = played.get(&(round, n.idx)).cloned() else {
                    continue;
                };
                if p.revealed || args.silent.contains(&n.idx) {
                    continue;
                }
                let res = if args.forced.contains(&n.idx) {
                    Settlement::new(args.settlement, &n.provider)
                        .forceReveal(round, n.overlay, p.depth, p.hash, p.nonce)
                        .send()
                        .await
                        .map(|_| "forceReveal tx".to_string())
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
                        .map(|_| "to prover".into())
                };
                match res {
                    Ok(how) => {
                        info!(round, node = n.idx, how, "revealed");
                        played.get_mut(&(round, n.idx)).unwrap().revealed = true;
                    }
                    Err(e) => warn!(round, node = n.idx, "reveal failed: {e:#}"),
                }
            }
        }

        // Claim phase: the honest winner proves storage for the truth's sample.
        if offset >= CLAIM_START {
            claim_phase(&args, &nodes, &http, round, &mut played, &samples, &batch).await;
        }

        played.retain(|(r, _), _| *r + 2 > round);
        samples.retain(|r, _| *r + 2 > round);
        tokio::time::sleep(Duration::from_secs(2)).await;
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
    let Some(sample) = samples.get(&round) else { return };
    let pending: Vec<usize> = nodes
        .iter()
        .filter(|n| played.get(&(round, n.idx)).is_some_and(|p| p.revealed && !p.claimed && p.hash == sample.hash()))
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
            info!(round, node = idx, "winner, withholding the claim witness (--no-claim)");
            continue;
        }
        let witness = Bytes::from(
            sample
                .witness(&outcome.round_anchor, outcome.selection_seed, |a| batch.stamp(a))
                .encode(),
        );
        let res = if args.forced.contains(&idx) {
            Settlement::new(args.settlement, &n.provider)
                .forceClaim(round, witness)
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
