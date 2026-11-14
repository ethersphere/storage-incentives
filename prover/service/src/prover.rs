//! The proof of a round: a Groth16 proof of the settlement circuit, made by `snarkd serve`
//! (prover/snark). The daemon keeps the circuit and the proving key in memory.

use anyhow::{anyhow, bail, Result};

pub struct SettlementProof {
    pub proof: Vec<u8>,
    pub prove_ms: u64,
    pub constraints: u64,
    pub peak_mb: u64,
}

/// The circuits that the daemon has keys for: the game circuit sizes (commits, forced entries), and
/// the size of the postage circuit (events, expiries).
pub async fn caps(url: &str) -> Result<(Vec<(usize, usize)>, usize, usize)> {
    let v: serde_json::Value = reqwest::get(format!("{url}/caps")).await?.json().await?;
    let n = |v: &serde_json::Value, k: &str| {
        v[k].as_u64().map(|x| x as usize).ok_or_else(|| anyhow!("caps.{k}"))
    };
    let mut games = vec![];
    for g in v["games"].as_array().ok_or_else(|| anyhow!("caps.games"))? {
        games.push((n(g, "p")?, n(g, "f")?));
    }
    Ok((games, n(&v, "e")?, n(&v, "x")?))
}

/// Prove with this witness (`swarm_vm::game_witness_json` or `postage_witness_json`).
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
