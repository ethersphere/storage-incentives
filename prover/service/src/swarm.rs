//! Swarm as the data layer of ZK settlement: the prover uploads each round's anchored commit and reveal
//! lists, and a snapshot of the postage state, through its own Bee node. The references go on chain as
//! `dataRef` of `anchorRound` and `anchorReveals`. Everything uploaded can be checked against a hash on
//! chain (the list roots, `postageStateHash`), so a reader does not have to trust the prover.
//!
//! Uploads use one mutable postage batch of the prover's Bee node: when a bucket is full, the newest chunk
//! replaces the oldest, so old round data drops out by itself. Only the last day or two are of use (a round
//! can settle for at most 128 rounds, about 27 hours; only the newest snapshot is needed).
//!
//! Bee API endpoints used (Bee 2.x): POST /bytes, GET /bytes/{ref}, GET /chainstate, GET /stamps/{id},
//! POST /stamps/{amount}/{depth}, PATCH /stamps/topup/{id}/{amount}.

use alloy::primitives::{keccak256, Address, B256, U256};
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use swarm_vm::{postage::PostageState, Reveal, SignedCommit};

/// Format version of the uploaded documents.
pub const DATA_VERSION: u8 = 1;

/// The document behind a round's `dataRef`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundData {
    pub version: u8,
    pub chain_id: U256,
    pub settlement: Address,
    pub round: u64,
    /// The anchored commit list (in `anchorRound`'s document), sorted by owner, with signatures.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commits: Option<Vec<SignedCommit>>,
    /// The anchored reveal list (in `anchorReveals`'s document), in the anchored order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reveals: Option<Vec<Reveal>>,
    /// The newest postage snapshot the prover uploaded, so a new prover can find it from the last anchor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub postage_snapshot: Option<SnapshotRef>,
}

/// Where a postage snapshot is, and which settlement it belongs to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRef {
    /// Settlement.postageStateHash after that settlement.
    pub state_hash: B256,
    pub reference: B256,
    pub round: u64,
    pub cut_block: u64,
}

/// The document behind a snapshot reference: the full postage state and the log position after the same
/// settlement. Check: `state.hash() == state_hash` and the position against PostageStampZK's log.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostageSnapshot {
    pub version: u8,
    pub state_hash: B256,
    pub event_index: u64,
    pub event_hash: B256,
    pub state: PostageState,
}

/// The reference to put on chain for a document: its Swarm reference if it was uploaded, else the
/// keccak256 of its bytes (a stand-in that still identifies the content).
pub fn stand_in_ref(bytes: &[u8]) -> B256 {
    keccak256(bytes)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChainState {
    pub block: u64,
    /// Storage price per chunk per block (PLUR).
    pub current_price: U256,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stamp {
    pub batch_id: String,
    pub depth: u8,
    pub bucket_depth: u8,
    /// Balance per chunk (PLUR).
    pub amount: U256,
    pub ttl_secs: i64,
    pub usable: bool,
    pub immutable: bool,
    pub utilization: u64,
}

/// Per-chunk amount that keeps a batch alive for `days` at `price`, with `block_secs` seconds per block of
/// the chain the postage contract is on (5 on Gnosis, 12 on Ethereum).
pub fn amount_for_days(price: U256, days: f64, block_secs: f64) -> U256 {
    let blocks = (days * 86_400.0 / block_secs).ceil() as u64;
    price * U256::from(blocks)
}

/// A minimal client for the prover's Bee node.
#[derive(Clone)]
pub struct Bee {
    api: String,
    batch: Option<String>,
    http: reqwest::Client,
}

fn parse_u256(v: &serde_json::Value) -> Result<U256> {
    match v {
        serde_json::Value::String(s) => Ok(s.parse()?),
        serde_json::Value::Number(n) => Ok(U256::from(n.as_u64().context("number")?)),
        _ => bail!("not a number: {v}"),
    }
}

impl Bee {
    pub fn new(api: &str, batch: Option<String>) -> Self {
        Bee {
            api: api.trim_end_matches('/').to_string(),
            batch: batch.map(|b| b.trim_start_matches("0x").to_lowercase()),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .expect("http client"),
        }
    }

    pub fn batch(&self) -> Option<&str> {
        self.batch.as_deref()
    }

    async fn check(r: reqwest::Response) -> Result<reqwest::Response> {
        if !r.status().is_success() {
            let status = r.status();
            bail!("Bee: {status} {}", r.text().await.unwrap_or_default());
        }
        Ok(r)
    }

    /// Upload bytes with the configured batch; returns the Swarm reference.
    pub async fn upload(&self, bytes: Vec<u8>) -> Result<B256> {
        let batch = self.batch.as_ref().context("no postage batch configured")?;
        let r = self
            .http
            .post(format!("{}/bytes", self.api))
            .header("swarm-postage-batch-id", batch)
            .header("content-type", "application/octet-stream")
            .body(bytes)
            .send()
            .await?;
        let v: serde_json::Value = Self::check(r).await?.json().await?;
        let reference = v["reference"].as_str().context("no reference")?;
        Ok(reference.parse()?)
    }

    pub async fn download(&self, reference: B256) -> Result<Vec<u8>> {
        let r = self
            .http
            .get(format!("{}/bytes/{}", self.api, hex::encode(reference)))
            .send()
            .await?;
        Ok(Self::check(r).await?.bytes().await?.to_vec())
    }

    pub async fn chainstate(&self) -> Result<ChainState> {
        let r = self
            .http
            .get(format!("{}/chainstate", self.api))
            .send()
            .await?;
        let v: serde_json::Value = Self::check(r).await?.json().await?;
        Ok(ChainState {
            block: v["block"].as_u64().unwrap_or_default(),
            current_price: parse_u256(&v["currentPrice"])?,
        })
    }

    pub async fn stamp(&self, batch: &str) -> Result<Stamp> {
        let r = self
            .http
            .get(format!("{}/stamps/{}", self.api, batch))
            .send()
            .await?;
        let v: serde_json::Value = Self::check(r).await?.json().await?;
        Ok(Stamp {
            batch_id: v["batchID"].as_str().unwrap_or_default().to_string(),
            depth: v["depth"].as_u64().unwrap_or_default() as u8,
            bucket_depth: v["bucketDepth"].as_u64().unwrap_or_default() as u8,
            amount: parse_u256(&v["amount"]).unwrap_or_default(),
            ttl_secs: v["batchTTL"].as_i64().unwrap_or_default(),
            usable: v["usable"].as_bool().unwrap_or_default(),
            immutable: v["immutableFlag"].as_bool().unwrap_or_default(),
            utilization: v["utilization"].as_u64().unwrap_or_default(),
        })
    }

    /// Buy a mutable batch. Bee pays from its own wallet (BZZ for the batch, native token for gas).
    pub async fn buy(&self, depth: u8, amount: U256, label: &str) -> Result<String> {
        let r = self
            .http
            .post(format!("{}/stamps/{amount}/{depth}", self.api))
            .query(&[("label", label)])
            .header("immutable", "false")
            .send()
            .await?;
        let v: serde_json::Value = Self::check(r).await?.json().await?;
        Ok(v["batchID"]
            .as_str()
            .context("no batchID")?
            .trim_start_matches("0x")
            .to_string())
    }

    /// Add `amount` per chunk to the batch.
    pub async fn topup(&self, batch: &str, amount: U256) -> Result<()> {
        let r = self
            .http
            .patch(format!("{}/stamps/topup/{batch}/{amount}", self.api))
            .send()
            .await?;
        Self::check(r).await?;
        Ok(())
    }

    /// Upload a JSON document if a batch is configured. Returns (reference to put on chain, uploaded).
    pub async fn publish<T: Serialize>(bee: Option<&Bee>, doc: &T) -> (B256, bool, Vec<u8>) {
        let bytes = serde_json::to_vec(doc).expect("serialize");
        if let Some(bee) = bee.filter(|b| b.batch.is_some()) {
            match bee.upload(bytes.clone()).await {
                Ok(r) => return (r, true, bytes),
                Err(e) => {
                    tracing::warn!("Swarm upload failed, using the stand-in reference: {e:#}")
                }
            }
        }
        (stand_in_ref(&bytes), false, bytes)
    }

    /// Download and parse a JSON document.
    pub async fn fetch<T: for<'de> Deserialize<'de>>(&self, reference: B256) -> Result<T> {
        let bytes = self.download(reference).await?;
        serde_json::from_slice(&bytes).map_err(|e| anyhow!("{reference}: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::{Path, Query},
        http::{HeaderMap, StatusCode},
        routing::{get, patch, post},
        Json, Router,
    };
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    /// A Bee stand-in with the endpoints above, keeping uploads in memory.
    async fn mock_bee() -> (String, Arc<Mutex<HashMap<String, Vec<u8>>>>) {
        let store: Arc<Mutex<HashMap<String, Vec<u8>>>> = Default::default();
        let s1 = store.clone();
        let s2 = store.clone();
        let app = Router::new()
            .route(
                "/bytes",
                post(move |h: HeaderMap, body: axum::body::Bytes| {
                    let s = s1.clone();
                    async move {
                        if h.get("swarm-postage-batch-id").map(|v| v.to_str().unwrap())
                            != Some("ab".repeat(32).as_str())
                        {
                            return (StatusCode::BAD_REQUEST, Json(json!({"message": "batch"})));
                        }
                        let r = hex::encode(keccak256(&body));
                        s.lock().unwrap().insert(r.clone(), body.to_vec());
                        (StatusCode::CREATED, Json(json!({ "reference": r })))
                    }
                }),
            )
            .route(
                "/bytes/{r}",
                get(move |Path(r): Path<String>| {
                    let s = s2.clone();
                    async move { s.lock().unwrap().get(&r).cloned().unwrap_or_default() }
                }),
            )
            .route(
                "/chainstate",
                get(|| async {
                    Json(json!({"chainTip": 100, "block": 99, "totalAmount": "5", "currentPrice": "198291"}))
                }),
            )
            .route(
                "/stamps/{id}",
                get(|Path(id): Path<String>| async move {
                    Json(json!({"batchID": id, "utilization": 3, "usable": true, "label": "zk",
                        "depth": 20, "amount": "1000", "bucketDepth": 16, "blockNumber": 1,
                        "immutableFlag": false, "exists": true, "batchTTL": 86400}))
                }),
            )
            .route(
                "/stamps/{amount}/{depth}",
                post(
                    |Path((amount, depth)): Path<(String, u8)>,
                     Query(q): Query<HashMap<String, String>>,
                     h: HeaderMap| async move {
                        assert_eq!(h.get("immutable").unwrap(), "false");
                        assert_eq!(q.get("label").unwrap(), "zk-settlement");
                        assert_eq!((amount.as_str(), depth), ("1713234240", 20));
                        (StatusCode::CREATED, Json(json!({"batchID": "cd".repeat(32), "txHash": "0x1"})))
                    },
                ),
            )
            .route(
                "/stamps/topup/{id}/{amount}",
                patch(|Path((id, amount)): Path<(String, String)>| async move {
                    assert_eq!((id.len(), amount.as_str()), (64, "5"));
                    (StatusCode::ACCEPTED, Json(json!({"batchID": id, "txHash": "0x2"})))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), store)
    }

    #[tokio::test]
    async fn uploads_and_reads_back_round_data() {
        let (api, _) = mock_bee().await;
        let bee = Bee::new(&api, Some("0x".to_string() + &"AB".repeat(32)));
        let doc = RoundData {
            version: DATA_VERSION,
            chain_id: U256::from(11155111u64),
            settlement: Address::repeat_byte(1),
            round: 7,
            commits: Some(vec![]),
            reveals: None,
            postage_snapshot: None,
        };
        let (reference, uploaded, bytes) = Bee::publish(Some(&bee), &doc).await;
        assert!(uploaded);
        assert_eq!(reference, keccak256(&bytes));
        let back: RoundData = bee.fetch(reference).await.unwrap();
        assert_eq!(back.round, 7);
        assert!(back.reveals.is_none());
    }

    #[tokio::test]
    async fn without_a_batch_nothing_is_uploaded() {
        let (api, store) = mock_bee().await;
        let bee = Bee::new(&api, None);
        let (reference, uploaded, bytes) = Bee::publish(Some(&bee), &json!({"a": 1})).await;
        assert!(!uploaded);
        assert_eq!(reference, stand_in_ref(&bytes));
        assert!(store.lock().unwrap().is_empty());
        let (_, uploaded, _) = Bee::publish(None, &json!({"a": 1})).await;
        assert!(!uploaded);
    }

    #[tokio::test]
    async fn buys_tops_up_and_reads_a_batch() {
        let (api, _) = mock_bee().await;
        let bee = Bee::new(&api, None);
        let cs = bee.chainstate().await.unwrap();
        assert_eq!(cs.current_price, U256::from(198291u64));
        // 0.5 days of 5 s blocks = 8,640 blocks.
        let amount = amount_for_days(cs.current_price, 0.5, 5.0);
        assert_eq!(amount, U256::from(198291u64 * 8640));
        let id = bee.buy(20, amount, "zk-settlement").await.unwrap();
        assert_eq!(id, "cd".repeat(32));
        bee.topup(&id, U256::from(5u8)).await.unwrap();
        let st = bee.stamp(&id).await.unwrap();
        assert_eq!(
            (st.depth, st.ttl_secs, st.immutable, st.usable),
            (20, 86400, false, true)
        );
    }
}
