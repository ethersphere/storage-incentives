//! SP1 side: execute and prove the program in `prover/program`.

use alloy_sol_types::SolType;
use anyhow::{anyhow, bail, Result};
use sp1_sdk::{
    blocking::{MockProver, ProveRequest, Prover, ProverClient},
    include_elf, Elf, HashableKey, ProvingKey, SP1Stdin,
};
use swarm_vm::{PublicValues, RoundInput};

pub const ELF: Elf = include_elf!("swarm-settlement-program");

/// The verification key Settlement is deployed with. Changes whenever the program or the VM changes.
pub fn vkey() -> String {
    let pk = MockProver::new().setup(ELF).expect("setup");
    pk.verifying_key().bytes32().to_string()
}

pub fn is_mock() -> bool {
    std::env::var("SP1_PROVER")
        .map(|m| m == "mock")
        .unwrap_or(false)
}

fn stdin(input: &RoundInput) -> SP1Stdin {
    let mut s = SP1Stdin::new();
    s.write(input);
    s
}

/// A proof ready for `Settlement.settleRound(publicValues, proofBytes)`.
pub struct SettlementProof {
    pub public_values: Vec<u8>,
    pub proof: Vec<u8>,
    pub cycles: u64,
}

/// Execute in the zkVM, check the output against the native run, then prove with Groth16.
/// Blocking; call from a blocking thread.
pub fn prove(input: &RoundInput) -> Result<SettlementProof> {
    let expected =
        PublicValues::abi_encode(&swarm_vm::run(input).map_err(|e| anyhow!("vm: {e:?}"))?);

    let client = ProverClient::from_env();
    let (out, report) = client
        .execute(ELF, stdin(input))
        .run()
        .map_err(|e| anyhow!("execute: {e}"))?;
    if out.as_slice() != expected.as_slice() {
        bail!("zkVM output differs from native VM output");
    }
    let cycles = report.total_instruction_count();

    let pk = client.setup(ELF).map_err(|e| anyhow!("setup: {e}"))?;
    let proof = client
        .prove(&pk, stdin(input))
        .groth16()
        .run()
        .map_err(|e| anyhow!("prove: {e}"))?;
    client
        .verify(&proof, pk.verifying_key(), None)
        .map_err(|e| anyhow!("local verify: {e}"))?;

    // SP1MockVerifier only accepts an empty proof.
    let proof_bytes = if is_mock() { vec![] } else { proof.bytes() };
    Ok(SettlementProof {
        public_values: proof.public_values.to_vec(),
        proof: proof_bytes,
        cycles,
    })
}

pub fn execute_report(
    input: &RoundInput,
    also_prove: bool,
    out_path: &std::path::Path,
) -> Result<()> {
    let client = ProverClient::from_env();
    let started = std::time::Instant::now();
    let (out, report) = client
        .execute(ELF, stdin(input))
        .run()
        .map_err(|e| anyhow!("execute: {e}"))?;
    let pv = PublicValues::abi_decode(out.as_slice())?;
    println!("participants: {}", pv.inputs.participants.len());
    println!(
        "truth:        {} (depth {})",
        pv.outcome.truthHash, pv.outcome.truthDepth
    );
    println!("winner:       {}", pv.outcome.winner);
    println!("redundancy:   {}", pv.outcome.redundancy);
    println!("freezes:      {}", pv.outcome.freezeOwners.len());
    println!(
        "claim:        {}",
        if pv.outcome.hasTruth {
            "valid witness"
        } else if pv.outcome.unclaimed {
            "unclaimed"
        } else {
            "no truth"
        }
    );
    println!("cycles:       {}", report.total_instruction_count());
    println!("execute time: {:?}", started.elapsed());
    if also_prove {
        let started = std::time::Instant::now();
        let p = prove(input)?;
        println!("proof bytes:  {}", p.proof.len());
        println!("prove time:   {:?}", started.elapsed());
        std::fs::write(
            out_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "vkey": vkey(),
                "publicValues": format!("0x{}", hex::encode(&p.public_values)),
                "proof": format!("0x{}", hex::encode(&p.proof)),
                "cycles": p.cycles,
                "proveSeconds": started.elapsed().as_secs(),
            }))?,
        )?;
        println!("written:      {}", out_path.display());
    }
    Ok(())
}
