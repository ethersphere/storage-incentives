//! HTTP API nodes talk to. Validates timing and signatures on arrival so the store only holds messages
//! that can count.

use crate::settler::Ctx;
use alloy::providers::Provider;
use anyhow::Result;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::Arc;
use swarm_prover::{
    offset_of, round_of, seed_block, ClaimMsg, CommitMsg, OutcomeMsg, RevealMsg, COMMIT_END,
    REVEAL_ANCHOR_START, REVEAL_START,
};
use swarm_vm::{
    commits_hash, recover_commit_signer, reveals_hash, Reveal, RoundInput, SignedCommit,
};
use tracing::info;

type Reply = (StatusCode, Json<Value>);

/// How long an /outcome answer is served from the cache.
const OUTCOME_CACHE: std::time::Duration = std::time::Duration::from_secs(10);

fn err(code: StatusCode, msg: impl ToString) -> Reply {
    (code, Json(json!({ "error": msg.to_string() })))
}

pub async fn run(ctx: Arc<Ctx>, listen: &str) -> Result<()> {
    let app = Router::new()
        .route("/v1/status", get(status))
        .route("/v1/commit", post(commit))
        .route("/v1/reveal", post(reveal))
        .route("/v1/rounds/{round}", get(round))
        .route("/v1/rounds/{round}/commit-proof/{owner}", get(commit_proof))
        .route(
            "/v1/rounds/{round}/reveal-proof/{overlay}",
            get(reveal_proof),
        )
        .route("/v1/rounds/{round}/outcome", get(outcome))
        .route("/v1/claim", post(claim))
        .with_state(ctx);
    let listener = tokio::net::TcpListener::bind(listen).await?;
    info!("listening on {listen}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn block(ctx: &Ctx) -> Result<u64, Reply> {
    ctx.provider
        .get_block_number()
        .await
        .map_err(|e| err(StatusCode::BAD_GATEWAY, e))
}

async fn status(State(ctx): State<Arc<Ctx>>) -> Result<Json<Value>, Reply> {
    let b = block(&ctx).await?;
    Ok(Json(json!({
        "block": b,
        "round": round_of(b),
        "offset": offset_of(b),
        "chainId": ctx.chain_id,
        "settlement": ctx.settlement,
    })))
}

async fn commit(
    State(ctx): State<Arc<Ctx>>,
    Json(m): Json<CommitMsg>,
) -> Result<Json<Value>, Reply> {
    let b = block(&ctx).await?;
    if m.round != round_of(b) || offset_of(b) >= COMMIT_END {
        return Err(err(
            StatusCode::CONFLICT,
            format!("not the commit phase of round {}", m.round),
        ));
    }
    let c = SignedCommit {
        owner: m.owner,
        obfuscated_hash: m.obfuscated_hash,
        signature: m.signature,
    };
    // Only chain id, settlement and round matter for the signature check.
    let probe = RoundInput {
        chain_id: ctx.chain_id,
        settlement: ctx.settlement,
        round: m.round,
        round_anchor: Default::default(),
        selection_seed: Default::default(),
        commits: vec![],
        forced_commits: vec![],
        reveals: vec![],
        forced_reveals: vec![],
        stakes: vec![],
        stake_price: 0,
        last_claim_round: 0,
        last_winner_depth: 0,
        penalty_multiplier_disagreement: 0,
        penalty_multiplier_non_revealed: 0,
        penalty_random_factor: 0,
        stake_age_rounds: 0,
        claim: None,
        forced_claims: vec![],
        sample_max_value: Default::default(),
        fee_recipient: Default::default(),
        postage: Default::default(),
    };
    if recover_commit_signer(&probe, &c) != Some(c.owner) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "signature does not recover to owner",
        ));
    }
    let mut store = ctx.store.lock().await;
    store.get_mut(m.round).commits.insert(c.owner, c);
    store
        .save(m.round)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    info!(round = m.round, owner = %m.owner, "commit");
    Ok(Json(json!({ "ok": true })))
}

async fn reveal(
    State(ctx): State<Arc<Ctx>>,
    Json(m): Json<RevealMsg>,
) -> Result<Json<Value>, Reply> {
    let b = block(&ctx).await?;
    let off = offset_of(b);
    // Off-chain reveals close when the reveal anchor phase starts; after that only forceReveal.
    if m.round != round_of(b) || !(REVEAL_START..REVEAL_ANCHOR_START).contains(&off) {
        return Err(err(
            StatusCode::CONFLICT,
            format!("not the reveal phase of round {}", m.round),
        ));
    }
    let r = Reveal {
        overlay: m.overlay,
        depth: m.depth,
        hash: m.hash,
        nonce: m.nonce,
    };
    let obf = swarm_vm::wrap_commit(r.overlay, r.depth, r.hash, r.nonce);
    // A node left out of the anchored list commits with forceCommit, and may still reveal here.
    let forced = crate::settler::forced_commits(&ctx, m.round)
        .await
        .map_err(|e| err(StatusCode::BAD_GATEWAY, e))?;
    let mut store = ctx.store.lock().await;
    let msgs = store.get_mut(m.round);
    let known = forced.iter().any(|c| c.obfuscated_hash == obf)
        || msgs
            .anchored
            .as_ref()
            .is_some_and(|a| a.iter().any(|c| c.obfuscated_hash == obf));
    if !known {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "reveal does not open any anchored commit",
        ));
    }
    if !msgs.reveals.contains(&r) {
        msgs.reveals.push(r);
    }
    store
        .save(m.round)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    info!(round = m.round, overlay = %m.overlay, "reveal");
    Ok(Json(json!({ "ok": true })))
}

/// The anchored commit and reveal lists of a round, so a node can check it was included (and fall back
/// to forceCommit or forceReveal if not), plus where the round stands. A node must compare the hashes
/// with the chain (Settlement.rounds) before it trusts them.
async fn round(State(ctx): State<Arc<Ctx>>, Path(round): Path<u64>) -> Result<Json<Value>, Reply> {
    let store = ctx.store.lock().await;
    let Some(m) = store.rounds.get(&round) else {
        return Err(err(StatusCode::NOT_FOUND, "unknown round"));
    };
    Ok(Json(json!({
        "round": round,
        "pendingCommits": m.commits.len(),
        "anchored": m.anchored.as_ref().map(|a| json!({
            "commitsHash": commits_hash(a.iter().map(|c| (&c.owner, &c.obfuscated_hash))),
            "commits": a.iter().map(|c| json!({ "owner": c.owner, "obfuscatedHash": c.obfuscated_hash })).collect::<Vec<_>>(),
        })),
        "reveals": m.reveals.len(),
        "revealsAnchored": m.reveals_anchored.as_ref().map(|a| json!({
            "revealsHash": reveals_hash(a),
            "reveals": a,
        })),
        "settleTx": m.settle_tx,
        "failed": m.failed,
    })))
}

/// Merkle proof that `owner`'s commit is in the anchored commit list. A node checks it against
/// Settlement.rounds(round).commitsHash and commitCount (swarm_vm::list_verify), so it does not need the
/// list. No proof: the node calls forceCommit.
async fn commit_proof(
    State(ctx): State<Arc<Ctx>>,
    Path((round, owner)): Path<(u64, alloy::primitives::Address)>,
) -> Result<Json<Value>, Reply> {
    let store = ctx.store.lock().await;
    let list = store
        .rounds
        .get(&round)
        .and_then(|m| m.anchored.clone())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "round not anchored here"))?;
    let index = list.iter().position(|c| c.owner == owner).ok_or_else(|| {
        err(
            StatusCode::NOT_FOUND,
            "no commit of this owner in the anchored list",
        )
    })?;
    let leaves: Vec<_> = list
        .iter()
        .map(|c| swarm_vm::commit_leaf(&c.owner, &c.obfuscated_hash))
        .collect();
    Ok(Json(json!({
        "round": round,
        "index": index,
        "count": list.len(),
        "root": commits_hash(list.iter().map(|c| (&c.owner, &c.obfuscated_hash))),
        "obfuscatedHash": list[index].obfuscated_hash,
        "proof": swarm_vm::list_proof(&leaves, index),
    })))
}

/// Merkle proof that the reveal of `overlay` is in the anchored reveal list (see `commit_proof`).
async fn reveal_proof(
    State(ctx): State<Arc<Ctx>>,
    Path((round, overlay)): Path<(u64, alloy::primitives::B256)>,
) -> Result<Json<Value>, Reply> {
    let store = ctx.store.lock().await;
    let list = store
        .rounds
        .get(&round)
        .and_then(|m| m.reveals_anchored.clone())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "reveals not anchored here"))?;
    let index = list
        .iter()
        .position(|r| r.overlay == overlay)
        .ok_or_else(|| {
            err(
                StatusCode::NOT_FOUND,
                "no reveal of this overlay in the anchored list",
            )
        })?;
    let leaves: Vec<_> = list.iter().map(swarm_vm::reveal_leaf).collect();
    Ok(Json(json!({
        "round": round,
        "index": index,
        "count": list.len(),
        "root": reveals_hash(&list),
        "reveal": list[index],
        "proof": swarm_vm::list_proof(&leaves, index),
    })))
}

/// Truth and winner of a round, computed from the messages and the chain once the seed exists. A node
/// that holds the truth's sample uses it to know that it must send the claim witness.
async fn outcome(
    State(ctx): State<Arc<Ctx>>,
    Path(round): Path<u64>,
) -> Result<Json<OutcomeMsg>, Reply> {
    let b = block(&ctx).await?;
    if b <= seed_block(round) {
        return Err(err(StatusCode::CONFLICT, "seed not available yet"));
    }
    if let Some((at, o)) = ctx.outcomes.lock().await.get(&round) {
        if at.elapsed() < OUTCOME_CACHE {
            return Ok(Json(o.clone()));
        }
    }
    let _permit = ctx
        .heavy
        .try_acquire()
        .map_err(|_| err(StatusCode::SERVICE_UNAVAILABLE, "busy, try again"))?;
    let input = crate::settler::build_input(&ctx, round, b, None)
        .await
        .map_err(|e| err(StatusCode::NOT_FOUND, format!("{e:#}")))?;
    let pv = swarm_vm::run(&input)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:?}")))?;
    let o = OutcomeMsg {
        round,
        has_truth: pv.outcome.hasTruth || pv.outcome.unclaimed,
        truth_hash: pv.outcome.truthHash,
        truth_depth: pv.outcome.truthDepth,
        winner: pv.outcome.winner,
        round_anchor: input.round_anchor,
        selection_seed: input.selection_seed,
        claimed: pv.outcome.hasTruth,
    };
    ctx.outcomes
        .lock()
        .await
        .insert(round, (std::time::Instant::now(), o.clone()));
    Ok(Json(o))
}

/// Accept a claim witness only if it makes the round claimed: the VM runs with it before it is stored.
async fn claim(State(ctx): State<Arc<Ctx>>, Json(m): Json<ClaimMsg>) -> Result<Json<Value>, Reply> {
    // Cheap checks first: the heavy check below builds the whole round input.
    if m.witness.len() > 16_384 {
        return Err(err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "witness larger than 16 KB",
        ));
    }
    if swarm_vm::claim::ClaimWitness::decode(&m.witness).is_none() {
        return Err(err(StatusCode::BAD_REQUEST, "witness does not decode"));
    }
    if ctx
        .store
        .lock()
        .await
        .rounds
        .get(&m.round)
        .is_some_and(|r| r.claim.is_some())
    {
        return Ok(Json(
            json!({ "ok": true, "note": "a valid witness is already known" }),
        ));
    }
    let b = block(&ctx).await?;
    if b <= seed_block(m.round) {
        return Err(err(StatusCode::CONFLICT, "seed not available yet"));
    }
    if ctx
        .store
        .lock()
        .await
        .rounds
        .get(&m.round)
        .is_some_and(|r| r.settle_tx.is_some())
    {
        return Err(err(StatusCode::CONFLICT, "round already settled"));
    }
    let _permit = ctx
        .heavy
        .try_acquire()
        .map_err(|_| err(StatusCode::SERVICE_UNAVAILABLE, "busy, try again"))?;
    let input = crate::settler::build_input(&ctx, m.round, b, Some(m.witness.clone()))
        .await
        .map_err(|e| err(StatusCode::NOT_FOUND, format!("{e:#}")))?;
    let pv = swarm_vm::run(&input).map_err(|e| err(StatusCode::BAD_REQUEST, format!("{e:?}")))?;
    if !pv.outcome.hasTruth {
        let batches = swarm_vm::claim_batch_records(&input).unwrap_or_default();
        let why = swarm_vm::claim::ClaimWitness::decode(&m.witness)
            .map(|w| {
                let ctx2 = swarm_vm::claim::ClaimContext {
                    anchor: input.round_anchor,
                    seed: input.selection_seed,
                    sample_hash: pv.outcome.truthHash,
                    depth: pv.outcome.truthDepth,
                    batches: &batches,
                    sample_max_value: input.sample_max_value,
                };
                format!("{:?}", swarm_vm::claim::verify_claim(&w, &ctx2))
            })
            .unwrap_or_else(|| "witness does not decode".into());
        return Err(err(
            StatusCode::BAD_REQUEST,
            format!("witness rejected: {why}"),
        ));
    }
    if ctx.withhold_claims {
        info!(
            round = m.round,
            "claim witness accepted and thrown away (TEST MODE)"
        );
        return Ok(Json(json!({ "ok": true })));
    }
    let mut store = ctx.store.lock().await;
    let r = store.get_mut(m.round);
    if r.claim.is_none() {
        r.claim = Some(m.witness);
    }
    store
        .save(m.round)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    ctx.outcomes.lock().await.remove(&m.round); // "claimed" changed
    info!(round = m.round, "claim witness accepted");
    Ok(Json(json!({ "ok": true })))
}
