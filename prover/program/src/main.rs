//! SP1 program: run one round of the Redistribution VM and commit the ABI-encoded PublicValues that
//! Settlement.settleRound checks and executes.
#![no_main]
sp1_zkvm::entrypoint!(main);

use alloy_sol_types::SolType;
use swarm_vm::{run, PublicValues, RoundInput};

pub fn main() {
    let input = sp1_zkvm::io::read::<RoundInput>();
    let pv = run(&input).expect("round input is not provable");
    sp1_zkvm::io::commit_slice(&PublicValues::abi_encode(&pv));
}
