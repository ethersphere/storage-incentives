//! swarm-prover: the off-chain half of ZK settlement.
//!
//!   serve    collect signed commits and reveals over HTTP, anchor each round's commit set on chain,
//!            build the round input from chain state, prove the Redistribution VM with SP1 and call
//!            Settlement.settleRound
//!   vkey     print the program verification key Settlement must be deployed with
//!   execute  run a saved round input through the zkVM (no proof) and report cycles; --prove to prove
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
        #[arg(long)]
        out: PathBuf,
    },
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
            println!("{}", prover::vkey());
            Ok(())
        }
        Cmd::Synth { nodes, out } => {
            std::fs::write(&out, serde_json::to_vec_pretty(&synth::round(nodes)?)?)?;
            println!("wrote {} ({nodes} nodes)", out.display());
            Ok(())
        }
        Cmd::Execute { input, prove } => {
            let out = input.with_extension("proof.json");
            let input: swarm_vm::RoundInput = serde_json::from_slice(&std::fs::read(&input)?)?;
            tokio::task::spawn_blocking(move || prover::execute_report(&input, prove, &out)).await?
        }
    }
}
