// Writes the inputs of a successful Redistribution.claim as a test vector for the Rust port of the claim
// checks (prover/crates/vm/tests/claim_vectors.rs). Off unless DUMP_CLAIM_VECTORS is set:
//
//   DUMP_CLAIM_VECTORS=1 npx hardhat test test/Redistribution.test.ts --grep "should claim pot by"
import fs from 'fs';
import path from 'path';
import { ethers } from 'hardhat';
import { BigNumber } from 'ethers';
import { hexlify } from 'ethers/lib/utils';

const PROOF =
  'tuple(bytes32[] proofSegments,bytes32 proveSegment,bytes32[] proofSegments2,bytes32 proveSegment2,' +
  'uint64 chunkSpan,bytes32[] proofSegments3,' +
  'tuple(bytes signature,bytes32 postageId,uint64 index,uint64 timeStamp) postageProof,' +
  'tuple(address signer,bytes signature,bytes32 identifier,bytes32 chunkAddr)[] socProof)';
const CLAIM_WITNESS = `tuple(${PROOF} proof1,${PROOF} proof2,${PROOF} proofLast)`;

const OUT_DIR = path.join(__dirname, '..', '..', 'prover', 'crates', 'vm', 'tests', 'vectors');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Proof = any;

// Fixture proofs carry `index` as 8 raw bytes; the ABI encoder wants a number.
function normalise(p: Proof): Proof {
  const index = p.postageProof.index;
  return {
    ...p,
    postageProof: {
      ...p.postageProof,
      index: BigNumber.isBigNumber(index) || typeof index === 'number' ? index : BigNumber.from(hexlify(index)),
    },
  };
}

export async function dumpClaimVector(
  name: string,
  anchor: string | Uint8Array,
  seed: string | Uint8Array,
  hash: string,
  depth: string | number,
  proofs: { proof1: Proof; proof2: Proof; proofLast: Proof }
): Promise<void> {
  if (!process.env.DUMP_CLAIM_VECTORS) return;

  const postage = await ethers.getContract('PostageStamp');
  const redistribution = await ethers.getContract('Redistribution');
  const all = [proofs.proof1, proofs.proof2, proofs.proofLast].map(normalise);
  const ids = [...new Set(all.map((p) => hexlify(p.postageProof.postageId)))];
  const batches = [];
  for (const id of ids) {
    const b = await postage.batches(id);
    batches.push({ batchId: id, owner: b.owner, depth: b.depth, bucketDepth: b.bucketDepth });
  }
  const witness = ethers.utils.defaultAbiCoder.encode(
    [CLAIM_WITNESS],
    [{ proof1: all[0], proof2: all[1], proofLast: all[2] }]
  );

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, `${name}.json`),
    JSON.stringify(
      {
        source: 'test/Redistribution.test.ts: claim accepted by Redistribution.claim',
        redistribution: redistribution.address,
        anchor: hexlify(anchor),
        seed: hexlify(seed),
        hash,
        depth: Number(depth),
        batches,
        witness,
      },
      null,
      2
    )
  );
}
