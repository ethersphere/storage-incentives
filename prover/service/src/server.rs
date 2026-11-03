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

fn err(code: StatusCode, msg: impl ToString) -> Reply {
    (code, Json(json!({ "error": msg.to_string() })))
}

pub async fn run(ctx: Arc<Ctx>, listen: &str) -> Result<()> {
    let app = Router::new()
        .route("/v1/status", get(status))
        .route("/v1/commit", post(commit))
        .route("/v1/reveal", post(reveal))
        .route("/v1/rounds/{round}", get(round))
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
    let input = crate::settler::build_input(&ctx, round, b, None)
        .await
        .map_err(|e| err(StatusCode::NOT_FOUND, format!("{e:#}")))?;
    let pv = swarm_vm::run(&input)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:?}")))?;
    Ok(Json(OutcomeMsg {
        round,
        has_truth: pv.outcome.hasTruth || pv.outcome.unclaimed,
        truth_hash: pv.outcome.truthHash,
        truth_depth: pv.outcome.truthDepth,
        winner: pv.outcome.winner,
        round_anchor: input.round_anchor,
        selection_seed: input.selection_seed,
        claimed: pv.outcome.hasTruth,
    }))
}

/// Accept a claim witness only if it makes the round claimed: the VM runs with it before it is stored.
async fn claim(State(ctx): State<Arc<Ctx>>, Json(m): Json<ClaimMsg>) -> Result<Json<Value>, Reply> {
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
    let mut store = ctx.store.lock().await;
    let r = store.get_mut(m.round);
    if r.claim.is_none() {
        r.claim = Some(m.witness);
    }
    store
        .save(m.round)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    info!(round = m.round, "claim witness accepted");
    Ok(Json(json!({ "ok": true })))
}
