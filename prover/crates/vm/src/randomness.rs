//! Round randomness from `prevrandao`, not from block hashes.
//!
//! A block builder chooses the transactions of a block, so it can try many block hashes and keep one that
//! selects the neighbourhood or the winner it wants. `prevrandao` (the header's `mixHash` since the merge)
//! is fixed before the slot: the proposer can only skip its slot.
//!
//! The proof gets the RLP headers of the block before the round (`roundStart - 1`) and of the seed block
//! (`roundStart + 48`). It commits to their hashes (`anchorBlockHash`, `seedBlockHash`), which Settlement
//! compares with the block hashes it reads itself (BLOCKHASH or EIP-2935). A matching hash proves the
//! header, so `mixHash` in it is the real `prevrandao`.
//!
//!   roundAnchor   = keccak256(abi.encode(prevrandao(roundStart - 1), round))
//!   selectionSeed = keccak256(abi.encode(roundAnchor, prevrandao(seed block)))

use alloy_primitives::{keccak256, Bytes, B256, U256};

/// Index of `mixHash` in an Ethereum block header (parentHash, ommersHash, beneficiary, stateRoot,
/// transactionsRoot, receiptsRoot, logsBloom, difficulty, number, gasLimit, gasUsed, timestamp,
/// extraData, mixHash, ...).
const MIX_HASH: usize = 13;
const NUMBER: usize = 8;

/// One RLP item at the start of `data`: (is a list, payload, length of the whole item).
fn item(data: &[u8]) -> Option<(bool, &[u8], usize)> {
    let b = *data.first()?;
    let (list, offset, len) = match b {
        0x00..=0x7f => return Some((false, &data[..1], 1)),
        0x80..=0xb7 => (false, 1, (b - 0x80) as usize),
        0xb8..=0xbf => {
            let n = (b - 0xb7) as usize;
            (false, 1 + n, be_len(data.get(1..1 + n)?)?)
        }
        0xc0..=0xf7 => (true, 1, (b - 0xc0) as usize),
        0xf8..=0xff => {
            let n = (b - 0xf7) as usize;
            (true, 1 + n, be_len(data.get(1..1 + n)?)?)
        }
    };
    let end = offset.checked_add(len)?;
    Some((list, data.get(offset..end)?, end))
}

fn be_len(bytes: &[u8]) -> Option<usize> {
    if bytes.len() > 8 || bytes.first() == Some(&0) {
        return None;
    }
    Some(bytes.iter().fold(0usize, |acc, b| (acc << 8) | *b as usize))
}

/// The fields of a header (an RLP list of strings).
fn fields(header: &[u8]) -> Option<Vec<&[u8]>> {
    let (list, mut rest, total) = item(header)?;
    if !list || total != header.len() {
        return None;
    }
    let mut out = Vec::new();
    while !rest.is_empty() {
        let (_, payload, len) = item(rest)?;
        out.push(payload);
        rest = &rest[len..];
    }
    Some(out)
}

/// `prevrandao` (mixHash) and the block number of an RLP block header.
pub fn header_mix_hash(header: &[u8]) -> Option<(B256, u64)> {
    let f = fields(header)?;
    let mix = f.get(MIX_HASH)?;
    let number = f.get(NUMBER)?;
    if mix.len() != 32 || number.len() > 8 {
        return None;
    }
    let n = number.iter().fold(0u64, |acc, b| (acc << 8) | *b as u64);
    Some((B256::from_slice(mix), n))
}

pub fn round_anchor(prevrandao: B256, round: u64) -> B256 {
    let mut buf = [0u8; 64];
    buf[..32].copy_from_slice(prevrandao.as_slice());
    buf[32..].copy_from_slice(&U256::from(round).to_be_bytes::<32>());
    keccak256(buf)
}

pub fn selection_seed(anchor: B256, prevrandao: B256) -> B256 {
    let mut buf = [0u8; 64];
    buf[..32].copy_from_slice(anchor.as_slice());
    buf[32..].copy_from_slice(prevrandao.as_slice());
    keccak256(buf)
}

/// What a round's randomness is, and the block hashes that prove it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Randomness {
    pub anchor_block_hash: B256,
    pub seed_block_hash: B256,
    pub round_anchor: B256,
    pub selection_seed: B256,
}

/// Check the two headers (their block numbers) and derive the anchor and the seed.
pub fn derive(
    round: u64,
    round_length: u64,
    seed_offset: u64,
    anchor_header: &[u8],
    seed_header: &[u8],
) -> Option<Randomness> {
    let start = round.checked_mul(round_length)?;
    let (anchor_mix, anchor_number) = header_mix_hash(anchor_header)?;
    let (seed_mix, seed_number) = header_mix_hash(seed_header)?;
    if anchor_number.checked_add(1)? != start || seed_number != start.checked_add(seed_offset)? {
        return None;
    }
    let round_anchor = round_anchor(anchor_mix, round);
    Some(Randomness {
        anchor_block_hash: keccak256(anchor_header),
        seed_block_hash: keccak256(seed_header),
        round_anchor,
        selection_seed: selection_seed(round_anchor, seed_mix),
    })
}

/// A minimal header with this block number and mixHash: the 15 pre-London fields, the others zero. For
/// tests and synthetic rounds only (its hash is no real block hash).
pub fn synthetic_header(number: u64, mix: B256) -> Bytes {
    fn string(out: &mut Vec<u8>, s: &[u8]) {
        if s.len() == 1 && s[0] < 0x80 {
            out.push(s[0]);
        } else if s.len() <= 55 {
            out.push(0x80 + s.len() as u8);
            out.extend_from_slice(s);
        } else {
            let l = (s.len() as u64).to_be_bytes();
            let l = &l[l.iter().position(|b| *b != 0).unwrap_or(7)..];
            out.push(0xb7 + l.len() as u8);
            out.extend_from_slice(l);
            out.extend_from_slice(s);
        }
    }
    let n = number.to_be_bytes();
    let n = &n[n.iter().position(|b| *b != 0).unwrap_or(8)..];
    let zero32 = [0u8; 32];
    let mut body = Vec::new();
    for i in 0..15 {
        match i {
            2 => string(&mut body, &[0u8; 20]),
            6 => string(&mut body, &[0u8; 256]),
            7 | 9 | 10 | 11 | 12 => string(&mut body, &[]),
            8 => string(&mut body, n),
            13 => string(&mut body, mix.as_slice()),
            14 => string(&mut body, &[0u8; 8]),
            _ => string(&mut body, &zero32),
        }
    }
    let mut out = Vec::new();
    let l = (body.len() as u64).to_be_bytes();
    let l = &l[l.iter().position(|b| *b != 0).unwrap_or(7)..];
    out.push(0xf7 + l.len() as u8);
    out.extend_from_slice(l);
    out.extend_from_slice(&body);
    Bytes::from(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_mix_hash_and_number_and_derives_the_round_values() {
        let mix_a = keccak256(b"a");
        let mix_s = keccak256(b"s");
        let a = synthetic_header(6399, mix_a);
        let s = synthetic_header(6448, mix_s);
        assert_eq!(header_mix_hash(&a), Some((mix_a, 6399)));
        let r = derive(100, 64, 48, &a, &s).unwrap();
        assert_eq!(r.round_anchor, round_anchor(mix_a, 100));
        assert_eq!(r.selection_seed, selection_seed(r.round_anchor, mix_s));
        assert_eq!(r.seed_block_hash, keccak256(&s));
        // Wrong blocks: the anchor header must be roundStart - 1 and the seed header roundStart + 48.
        assert!(derive(101, 64, 48, &a, &s).is_none());
        assert!(derive(100, 64, 48, &s, &a).is_none());
        // Not a header.
        assert!(header_mix_hash(&[0xc0]).is_none());
        assert!(header_mix_hash(&a[..a.len() - 1]).is_none());
    }
}
