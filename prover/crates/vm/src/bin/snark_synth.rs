//! Print the game circuit witness of a synthetic round: snark-synth NODES FORCED SLOTS
use swarm_vm::snark::{game, synth};

fn main() {
    let a: Vec<usize> = std::env::args().skip(1).map(|s| s.parse().expect("number")).collect();
    assert!(a.len() == 3, "usage: snark-synth NODES FORCED SLOTS");
    let (input, pv) = synth::synth(a[0], a[1]);
    let caps = game::Caps { p: a[2] };
    let w = game::game_witness_json(&input, &pv, &caps).expect("witness");
    println!("{}", serde_json::to_string(&w).unwrap());
}
