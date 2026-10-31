//! node-sim: plays the Bee side of the off-chain game for a set of staked keys.
//!
//! Each round, for every node: check neighbourhood eligibility against Settlement.roundAnchor, commit
//! (signed message to the prover, or forceCommit on chain), then reveal (to the prover, or forceReveal).
//! Behaviours per node index let you exercise the paths that matter:
//!
//!   --silent 3      node 3 commits and never reveals          -> frozen for non-reveal
//!   --liar 4        node 4 commits to a different reserve hash -> frozen for disagreement (if it loses)
//!   --forced 2      node 2 uses forceCommit / forceReveal      -> included through the escape hatch
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
use swarm_prover::{
    offset_of, round_of, CommitMsg, RevealMsg, Settlement, StakeRegistry, ANCHOR_END, COMMIT_END,
    REVEAL_END,
};
use swarm_vm::{commit_digest, in_proximity, wrap_commit};
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

    let http = reqwest::Client::new();
    let mut played: HashMap<(u64, usize), Played> = HashMap::new();
    let mut first_round = None;

    loop {
        let block = read.get_block_number().await?;
        let (round, offset) = (round_of(block), offset_of(block));
        let first = *first_round.get_or_insert(round);
        if args.rounds > 0 && round >= first + args.rounds && offset >= REVEAL_END {
            info!("done");
            return Ok(());
        }

        // Commit phase. Leave two blocks of margin so the message or tx lands in time.
        if offset + 2 < COMMIT_END {
            let anchor = settlement.roundAnchor(round).call().await?;
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
                        },
                    );
                    continue;
                }
                // Honest nodes in the neighbourhood agree on the reserve commitment.
                let hash = if args.liar.contains(&n.idx) {
                    keccak256([b"lie".as_slice(), n.overlay.as_slice()].concat())
                } else {
                    keccak256([b"sim-reserve".as_slice(), anchor.as_slice()].concat())
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

        played.retain(|(r, _), _| *r + 2 > round);
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
