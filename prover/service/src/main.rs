//! swarm-prover: the off-chain half of ZK settlement.
//!
//!   serve    collect signed commits and reveals over HTTP, anchor each round's commit set on chain,
//!            build the round input from chain state, prove the Redistribution VM with SP1 and call
//!            Settlement.settleRound
//!   vkey     print the program verification key Settlement must be deployed with
//!   execute  run a saved round input through the zkVM (no proof) and report cycles; --prove to prove
//!   stamp    status, buy or top up the mutable postage batch for Swarm uploads (through the Bee node)
//!
//! See docs/ZK-SETTLEMENT.md for the protocol and prover/README.md for how to run it.

mod prover;
mod server;
mod settler;
mod store;
mod synth;

use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    Serve(settler::Config),
    Vkey,
    Execute {
        /// A round input saved by `serve` (data/rounds/<n>/input.json).
        input: PathBuf,
        /// Also generate and verify a Groth16 proof (SP1_PROVER decides where).
        #[arg(long)]
        prove: bool,
    },
    /// Write a synthetic round input with N signed commits, for cycle and proving-cost measurements.
    Synth {
        #[arg(long)]
        nodes: usize,
        /// Extra live batches in the carried postage state (mainnet has thousands).
        #[arg(long, default_value_t = 0)]
        batches: usize,
        #[arg(long)]
        out: PathBuf,
    },
    /// The mutable postage batch the prover uploads round lists and postage snapshots with.
    Stamp {
        #[command(subcommand)]
        cmd: StampCmd,
        /// Bee API of the prover's Swarm node.
        #[arg(
            long,
            env = "SWARM_API",
            default_value = "http://localhost:1633",
            global = true
        )]
        swarm_api: String,
        /// Block time of the chain of the Swarm postage contract (5 on Gnosis, 12 on Ethereum).
        #[arg(
            long,
            env = "SWARM_BLOCK_SECONDS",
            default_value_t = 5.0,
            global = true
        )]
        block_seconds: f64,
    },
}

#[derive(Subcommand)]
enum StampCmd {
    /// Show the batch: depth, days left, how full.
    Status {
        #[arg(long, env = "SWARM_BATCH_ID")]
        batch: String,
    },
    /// Buy a new mutable batch. The Bee node pays from its wallet. Prints the batch id for SWARM_BATCH_ID.
    Buy {
        /// 2^depth chunks. 20 (about 1M chunks) holds more than a year of round lists and snapshots.
        #[arg(long, default_value_t = 20)]
        depth: u8,
        #[arg(long, default_value_t = 30.0)]
        days: f64,
        #[arg(long, default_value = "zk-settlement")]
        label: String,
        /// Print the cost and do nothing.
        #[arg(long)]
        dry_run: bool,
    },
    /// Add storage time to the batch.
    Topup {
        #[arg(long, env = "SWARM_BATCH_ID")]
        batch: String,
        #[arg(long, default_value_t = 30.0)]
        days: f64,
        #[arg(long)]
        dry_run: bool,
    },
}

/// BZZ has 16 decimals (PLUR).
fn bzz(plur: alloy::primitives::U256) -> String {
    format!("{:.4}", f64::from(plur) / 1e16)
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenv::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,sp1_core_executor=warn,sp1_prover=warn".into()),
        )
        .init();

    match Cli::parse().cmd {
        Cmd::Serve(cfg) => settler::serve(cfg).await,
        Cmd::Vkey => {
            // The blocking SP1 SDK must not run on the async runtime's thread.
            println!("{}", tokio::task::spawn_blocking(prover::vkey).await?);
            Ok(())
        }
        Cmd::Synth {
            nodes,
            batches,
            out,
        } => {
            std::fs::write(
                &out,
                serde_json::to_vec_pretty(&synth::round(nodes, batches)?)?,
            )?;
            println!(
                "wrote {} ({nodes} nodes, {batches} extra batches)",
                out.display()
            );
            Ok(())
        }
        Cmd::Stamp {
            cmd,
            swarm_api,
            block_seconds,
        } => {
            use swarm_prover::swarm::{amount_for_days, Bee};
            let bee = Bee::new(&swarm_api, None);
            let price = || async { anyhow::Ok(bee.chainstate().await?.current_price) };
            match cmd {
                StampCmd::Status { batch } => {
                    let st = bee.stamp(&batch).await?;
                    println!(
                        "batch {}: depth {} (bucket {}), {} days left, usable {}, mutable {}, fullest bucket {} of {}",
                        st.batch_id,
                        st.depth,
                        st.bucket_depth,
                        st.ttl_secs / 86_400,
                        st.usable,
                        !st.immutable,
                        st.utilization,
                        1u64 << (st.depth - st.bucket_depth)
                    );
                }
                StampCmd::Buy {
                    depth,
                    days,
                    label,
                    dry_run,
                } => {
                    let amount = amount_for_days(price().await?, days, block_seconds);
                    let total = amount * alloy::primitives::U256::from(1u64 << depth);
                    println!(
                        "batch depth {depth}, {days} days: {amount} PLUR per chunk, {} BZZ in total",
                        bzz(total)
                    );
                    if !dry_run {
                        let id = bee.buy(depth, amount, &label).await?;
                        println!(
                            "bought batch {id}. Set SWARM_BATCH_ID={id} for swarm-prover serve."
                        );
                        println!("It can take a few minutes until Bee reports it as usable.");
                    }
                }
                StampCmd::Topup {
                    batch,
                    days,
                    dry_run,
                } => {
                    let st = bee.stamp(&batch).await?;
                    let amount = amount_for_days(price().await?, days, block_seconds);
                    let total = amount * alloy::primitives::U256::from(1u64 << st.depth);
                    println!(
                        "top-up of {days} days: {amount} PLUR per chunk, {} BZZ in total",
                        bzz(total)
                    );
                    if !dry_run {
                        bee.topup(&batch, amount).await?;
                        println!("topped up {batch}");
                    }
                }
            }
            Ok(())
        }
        Cmd::Execute { input, prove } => {
            let out = input.with_extension("proof.json");
            let input: swarm_vm::RoundInput = serde_json::from_slice(&std::fs::read(&input)?)?;
            tokio::task::spawn_blocking(move || prover::execute_report(&input, prove, &out)).await?
        }
    }
}
