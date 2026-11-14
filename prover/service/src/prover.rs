//! The proof of a round: a Groth16 proof of the settlement circuit, made by `snarkd serve`
//! (prover/snark). The daemon keeps the circuit and the proving key in memory.

use anyhow::{anyhow, bail, Result};

pub struct SettlementProof {
    pub proof: Vec<u8>,
    pub prove_ms: u64,
    pub constraints: u64,
    pub peak_mb: u64,
}

/// The size of the circuit that the daemon proves: (events, expiries) for each proof. The other two
/// sizes are in `Settlement` (capacity, forcedCapacity).
pub async fn caps(url: &str) -> Result<(usize, usize, usize, usize)> {
    let v: serde_json::Value = reqwest::get(format!("{url}/caps")).await?.json().await?;
    let n = |k: &str| v[k].as_u64().map(|x| x as usize).ok_or_else(|| anyhow!("caps.{k}"));
    Ok((n("p")?, n("f")?, n("e")?, n("x")?))
}

/// Prove the round with this witness (`swarm_vm::witness_json`).
pub async fn prove(url: &str, witness: &serde_json::Value) -> Result<SettlementProof> {
    let res = reqwest::Client::new()
        .post(format!("{url}/prove"))
        .json(witness)
        .send()
        .await?;
    if !res.status().is_success() {
        bail!("snarkd: {}", res.text().await.unwrap_or_default());
    }
    let v: serde_json::Value = res.json().await?;
    let proof: alloy::primitives::Bytes = v["proof"]
        .as_str()
        .ok_or_else(|| anyhow!("no proof"))?
        .parse()?;
    Ok(SettlementProof {
        proof: proof.to_vec(),
        prove_ms: v["proveMs"].as_u64().unwrap_or(0),
        constraints: v["constraints"].as_u64().unwrap_or(0),
        peak_mb: v["peakMB"].as_u64().unwrap_or(0),
    })
}
