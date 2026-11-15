//! The SNARK version of the Redistribution VM (docs/SNARK-SETTLEMENT.md).
//!
//! The game and the postage accounting are proven by a Groth16 circuit (`prover/snark`, gnark). This
//! module is the reference: it computes the result of a round and the witness of the circuit. The hash
//! (MiMC) and the signature scheme (EdDSA on the BN254 twisted Edwards curve) are those of gnark-crypto,
//! so that the circuit, this code and the contracts compute the same values.

pub mod game;
pub mod synth;

use alloy_primitives::{keccak256, Address, B256, U256};
use std::sync::OnceLock;

/// A field element: an integer below `P`.
pub type Fr = U256;

/// The BN254 scalar field modulus.
pub const P: U256 = U256::from_limbs([
    0x43e1f593f0000001,
    0x2833e84879b97091,
    0xb85045b68181585d,
    0x30644e72e131a029,
]);

pub fn fadd(a: Fr, b: Fr) -> Fr {
    a.add_mod(b, P)
}
pub fn fsub(a: Fr, b: Fr) -> Fr {
    a.add_mod(P - (b % P), P)
}
pub fn fmul(a: Fr, b: Fr) -> Fr {
    a.mul_mod(b, P)
}
pub fn finv(a: Fr) -> Fr {
    a.inv_mod(P).expect("inverse of zero")
}
pub fn u(n: u64) -> Fr {
    U256::from(n)
}

/// The two 128-bit halves of a 256-bit value: (high, low).
pub fn halves(b: &B256) -> (Fr, Fr) {
    let v = U256::from_be_bytes(b.0);
    (v >> 128, v & ((U256::from(1u8) << 128) - U256::from(1u8)))
}
pub fn from_halves(hi: Fr, lo: Fr) -> B256 {
    B256::from((hi << 128) | lo)
}
pub fn addr(a: &Address) -> Fr {
    U256::from_be_slice(a.as_slice())
}
pub fn fr_bytes(x: Fr) -> B256 {
    B256::from(x)
}

// ---------------------------------------------------------------------------------------------------
// MiMC (gnark-crypto, ecc/bn254/fr/mimc): x^5, 110 rounds, Miyaguchi-Preneel
// ---------------------------------------------------------------------------------------------------

const MIMC_ROUNDS: usize = 110;

pub fn mimc_constants() -> &'static [Fr; MIMC_ROUNDS] {
    static C: OnceLock<[Fr; MIMC_ROUNDS]> = OnceLock::new();
    C.get_or_init(|| {
        let mut out = [U256::ZERO; MIMC_ROUNDS];
        let mut rnd = keccak256(b"seed");
        for c in out.iter_mut() {
            rnd = keccak256(rnd);
            *c = U256::from_be_bytes(rnd.0) % P;
        }
        out
    })
}

fn encrypt(key: Fr, mut m: Fr) -> Fr {
    for c in mimc_constants() {
        let t = fadd(fadd(m, key), *c);
        let t2 = fmul(t, t);
        m = fmul(fmul(t2, t2), t);
    }
    fadd(m, key)
}

/// The compression function: E_left(right) + left + right. Also the node hash of the Merkle trees.
pub fn compress(left: Fr, right: Fr) -> Fr {
    fadd(fadd(encrypt(left, right), left), right)
}

/// The MiMC hash of a list of field elements (Merkle-Damgard from state zero).
pub fn mimc(xs: &[Fr]) -> Fr {
    xs.iter().fold(U256::ZERO, |h, x| compress(h, *x))
}

/// Root of a list as the anchors take it: a Merkle tree of fixed depth `LIST_DEPTH`, leaves in list
/// order, zero for unused leaves, node hash `compress`.
pub const LIST_DEPTH: usize = 8;

pub fn list_root(leaves: &[Fr]) -> Fr {
    let mut level: Vec<Fr> = leaves.to_vec();
    level.resize(1 << LIST_DEPTH, U256::ZERO);
    while level.len() > 1 {
        level = level.chunks(2).map(|p| compress(p[0], p[1])).collect();
    }
    level[0]
}

pub fn list_proof(leaves: &[Fr], index: usize) -> Vec<Fr> {
    let mut level: Vec<Fr> = leaves.to_vec();
    level.resize(1 << LIST_DEPTH, U256::ZERO);
    let (mut out, mut i) = (Vec::new(), index);
    while level.len() > 1 {
        out.push(level[i ^ 1]);
        level = level.chunks(2).map(|p| compress(p[0], p[1])).collect();
        i >>= 1;
    }
    out
}

pub fn list_verify(root: Fr, index: usize, leaf: Fr, proof: &[Fr]) -> bool {
    if proof.len() != LIST_DEPTH || index >> LIST_DEPTH != 0 {
        return false;
    }
    let mut h = leaf;
    for (l, s) in proof.iter().enumerate() {
        h = if (index >> l) & 1 == 0 {
            compress(h, *s)
        } else {
            compress(*s, h)
        };
    }
    h == root
}

// ---------------------------------------------------------------------------------------------------
// EdDSA on the BN254 twisted Edwards curve (gnark-crypto, ecc/bn254/twistededwards): a = -1
// ---------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Point {
    pub x: Fr,
    pub y: Fr,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Sig {
    pub r: Point,
    pub s: U256,
}

fn dec(s: &str) -> U256 {
    U256::from_str_radix(s, 10).unwrap()
}
pub fn curve_d() -> Fr {
    dec("12181644023421730124874158521699555681764249180949974110617291017600649128846")
}
pub fn curve_order() -> U256 {
    dec("2736030358979909402780800718157159386076813972158567259200215660948447373041")
}
pub fn base() -> Point {
    Point {
        x: dec("9671717474070082183213120605117400219616337014328744928644933853176787189663"),
        y: dec("16950150798460657717958625567821834550301663161624707787222815936182638968203"),
    }
}
const IDENTITY: Point = Point {
    x: U256::ZERO,
    y: U256::from_limbs([1, 0, 0, 0]),
};

impl Point {
    pub fn is_zero(&self) -> bool {
        self.x.is_zero() && self.y.is_zero()
    }

    /// -x^2 + y^2 = 1 + d x^2 y^2
    pub fn on_curve(&self) -> bool {
        if self.x >= P || self.y >= P {
            return false;
        }
        let (x2, y2) = (fmul(self.x, self.x), fmul(self.y, self.y));
        fsub(y2, x2) == fadd(u(1), fmul(curve_d(), fmul(x2, y2)))
    }

    pub fn add(&self, o: &Point) -> Point {
        let (x1y2, y1x2) = (fmul(self.x, o.y), fmul(self.y, o.x));
        let (x1x2, y1y2) = (fmul(self.x, o.x), fmul(self.y, o.y));
        let k = fmul(curve_d(), fmul(x1x2, y1y2));
        Point {
            x: fmul(fadd(x1y2, y1x2), finv(fadd(u(1), k))),
            y: fmul(fadd(y1y2, x1x2), finv(fsub(u(1), k))),
        }
    }

    pub fn neg(&self) -> Point {
        Point {
            x: fsub(U256::ZERO, self.x),
            y: self.y,
        }
    }

    pub fn mul(&self, k: U256) -> Point {
        let mut acc = IDENTITY;
        for i in (0..256).rev() {
            acc = acc.add(&acc);
            if k.bit(i) {
                acc = acc.add(self);
            }
        }
        acc
    }
}

/// A game key pair from 32 secret bytes: (secret scalar, public key).
pub fn game_key(secret: &B256) -> (U256, Point) {
    let mut a = U256::from_be_bytes(keccak256(secret).0) % curve_order();
    if a.is_zero() {
        a = u(1);
    }
    (a, base().mul(a))
}

fn hram(r: &Point, a: &Point, msg: Fr) -> Fr {
    mimc(&[r.x, r.y, a.x, a.y, msg])
}

pub fn sign(sk: U256, msg: Fr) -> Sig {
    let l = curve_order();
    let a = base().mul(sk);
    let mut pre = [0u8; 64];
    pre[..32].copy_from_slice(&sk.to_be_bytes::<32>());
    pre[32..].copy_from_slice(&msg.to_be_bytes::<32>());
    let mut k = U256::from_be_bytes(keccak256(pre).0) % l;
    if k.is_zero() {
        k = u(1);
    }
    let r = base().mul(k);
    let h = hram(&r, &a, msg) % l;
    Sig {
        r,
        s: k.add_mod(h.mul_mod(sk, l), l),
    }
}

/// The check of gnark's `eddsa.IsValid`: 8 * ([S]B - [h]A - R) is the identity, and A does not have a
/// small order. `None` where the circuit cannot be satisfied (S not below the order, or a point that is
/// not on the curve): a prover must not anchor such a signature.
pub fn verify(key: &Point, msg: Fr, sig: &Sig) -> Option<bool> {
    if sig.s >= curve_order() || !key.on_curve() || !sig.r.on_curve() {
        return None;
    }
    let h = hram(&sig.r, key, msg);
    let q = base()
        .mul(sig.s)
        .add(&key.neg().mul(h))
        .neg()
        .add(&sig.r);
    let clear = |p: Point| {
        let p2 = p.add(&p);
        let p4 = p2.add(&p2);
        p4.add(&p4)
    };
    Some(clear(q) == IDENTITY && clear(*key) != IDENTITY)
}

/// sha256 with the top 3 bits cleared: the public input of the circuit.
pub fn digest(bytes: &[u8]) -> Fr {
    use sha2::{Digest, Sha256};
    let h: [u8; 32] = Sha256::digest(bytes).into();
    U256::from_be_bytes(h) & ((U256::from(1u8) << 253) - U256::from(1u8))
}

pub fn sha256(bytes: &[u8]) -> B256 {
    use sha2::{Digest, Sha256};
    let h: [u8; 32] = Sha256::digest(bytes).into();
    B256::from(h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eddsa_round_trip() {
        let (sk, pk) = game_key(&B256::repeat_byte(7));
        assert!(pk.on_curve());
        assert_eq!(base().mul(curve_order()), IDENTITY);
        let sig = sign(sk, u(12345));
        assert_eq!(verify(&pk, u(12345), &sig), Some(true));
        assert_eq!(verify(&pk, u(12346), &sig), Some(false));
    }

    /// Values printed by `snarkd vectors` (gnark-crypto).
    #[test]
    fn mimc_matches_gnark() {
        let h = mimc(&[u(1), u(2), u(3)]);
        assert_eq!(
            h.to_string(),
            include_str!("vectors_mimc.txt").trim(),
            "run `snarkd vectors` and compare"
        );
    }
}
