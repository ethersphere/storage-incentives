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

    pub fn write_file(&self, round: u64, name: &str, bytes: &[u8]) -> Result<()> {
        let dir = self.round_dir(round);
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join(name), bytes)?;
        Ok(())
    }
}
