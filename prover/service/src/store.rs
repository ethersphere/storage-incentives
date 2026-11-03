//! Messages received per round, kept in memory and mirrored to `<data>/rounds/<n>/messages.json` so a
//! restarted prover can still settle rounds it anchored.
//!
//! This directory is the stand-in for the data availability layer. In the proposal it is Swarm itself:
//! the anchored list is uploaded and its reference passed as `dataRef` to `anchorRound`.

use alloy::primitives::Address;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};
use swarm_vm::{Reveal, SignedCommit};

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct RoundMessages {
    /// Latest commit per owner. BTreeMap keeps them sorted by owner, which is the anchored order.
    pub commits: BTreeMap<Address, SignedCommit>,
    pub reveals: Vec<Reveal>,
    /// The list exactly as anchored on chain. Set once, in the anchor phase.
    pub anchored: Option<Vec<SignedCommit>>,
    /// The reveal list exactly as passed to anchorReveals. Set once, in the reveal anchor phase.
    #[serde(default)]
    pub reveals_anchored: Option<Vec<Reveal>>,
    /// The first valid claim witness received off chain.
    #[serde(default)]
    pub claim: Option<alloy::primitives::Bytes>,
    pub settle_tx: Option<String>,
    pub failed: Option<String>,
}

pub struct Store {
    dir: PathBuf,
    pub rounds: BTreeMap<u64, RoundMessages>,
}

impl Store {
    pub fn open(dir: PathBuf) -> Result<Self> {
        let mut rounds = BTreeMap::new();
        let base = dir.join("rounds");
        std::fs::create_dir_all(&base)?;
        for entry in std::fs::read_dir(&base)? {
            let path = entry?.path().join("messages.json");
            if let (Some(n), Ok(bytes)) = (
                path.parent()
                    .and_then(|p| p.file_name())
                    .and_then(|n| n.to_str())
                    .and_then(|n| n.parse().ok()),
                std::fs::read(&path),
            ) {
                rounds.insert(n, serde_json::from_slice(&bytes)?);
            }
        }
        Ok(Self { dir, rounds })
    }

    pub fn round_dir(&self, round: u64) -> PathBuf {
        self.dir.join("rounds").join(round.to_string())
    }

    pub fn get_mut(&mut self, round: u64) -> &mut RoundMessages {
        self.rounds.entry(round).or_default()
    }

    pub fn save(&self, round: u64) -> Result<()> {
        if let Some(r) = self.rounds.get(&round) {
            let dir = self.round_dir(round);
            std::fs::create_dir_all(&dir)?;
            std::fs::write(dir.join("messages.json"), serde_json::to_vec_pretty(r)?)?;
        }
        Ok(())
    }

    /// The postage state the proof carries between settlements, kept by its hash. Settlement stores only
    /// the hash, so a prover needs this file (or must rebuild it from the PostageLog history).
    pub fn save_postage(&self, state: &swarm_vm::postage::PostageState) -> Result<()> {
        let dir = self.dir.join("postage");
        std::fs::create_dir_all(&dir)?;
        std::fs::write(
            dir.join(format!("{}.json", state.hash())),
            serde_json::to_vec(state)?,
        )?;
        Ok(())
    }

    pub fn load_postage(
        &self,
        hash: alloy::primitives::B256,
    ) -> Result<swarm_vm::postage::PostageState> {
        if hash.is_zero() {
            return Ok(Default::default());
        }
        let path = self.dir.join("postage").join(format!("{hash}.json"));
        let bytes = std::fs::read(&path)
            .map_err(|e| anyhow::anyhow!("postage state {hash} missing ({e})"))?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    pub fn write_file(&self, round: u64, name: &str, bytes: &[u8]) -> Result<()> {
        let dir = self.round_dir(round);
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join(name), bytes)?;
        Ok(())
    }
}
