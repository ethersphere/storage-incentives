//! Print the circuit witness of a synthetic round: snark-synth NODES FORCED EVENTS EXPIRIES BATCHES P F E X
use swarm_vm::snark::{game, synth};

fn main() {
    let a: Vec<usize> = std::env::args().skip(1).map(|s| s.parse().expect("number")).collect();
    assert!(a.len() == 9, "usage: snark-synth NODES FORCED EVENTS EXPIRIES BATCHES P F E X");
    let (input, pv, _) = synth::synth(a[0], a[1], a[2], a[3], a[4]);
    let caps = game::Caps { p: a[5], f: a[6], e: a[7], x: a[8] };
    // Two lines: the witness of the game circuit, then of the postage circuit.
    let w = game::game_witness_json(&input, &pv, &caps).expect("witness");
    println!("{}", serde_json::to_string(&w).unwrap());
    let w = game::postage_witness_json(&input.postage, &pv, &caps).expect("witness");
    println!("{}", serde_json::to_string(&w).unwrap());
}
