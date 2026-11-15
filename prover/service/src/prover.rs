//! The proof of a round: a Groth16 proof of the settlement circuit, made by `snarkd serve`
//! (prover/snark). The daemon keeps the circuit and the proving key in memory.

use anyhow::{anyhow, bail, Result};

pub struct SettlementProof {
    pub proof: Vec<u8>,
    pub prove_ms: u64,
    pub constraints: u64,
    pub peak_mb: u64,
}

/// The game circuit sizes (slots) that the daemon has keys for.
pub async fn caps(url: &str) -> Result<Vec<usize>> {
    let v: serde_json::Value = reqwest::get(format!("{url}/caps")).await?.json().await?;
    let mut games = vec![];
    for g in v["games"].as_array().ok_or_else(|| anyhow!("caps.games"))? {
        games.push(g["p"].as_u64().ok_or_else(|| anyhow!("caps.games.p"))? as usize);
    }
    Ok(games)
}

/// Prove with this witness (`swarm_vm::game_witness_json`).
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
