// Based on: https://github.com/Cafe137/swarm-chunked-upload/blob/feat/zero-bee-upload-proof/src/signature.ts

import { Wallet, utils } from 'ethers';
import { keccak256 } from 'ethers/lib/utils';

export function swarmAddressToBucketIndex(depth: number, address: Buffer): number {
  if (address.length !== 32) {
    throw Error('Expected 32 byte address, got ' + address.length + ' bytes');
  }
  if (depth < 16 || depth > 32) {
    throw Error('Expected depth between 16 and 33, got ' + depth);
  }
  const i = address.readUInt32BE(0);
  return i >>> (32 - depth);
}

function bucketAndIndexToBuffer(bucket: number, index: number): Buffer {
  console.log({ bucket, index });
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(bucket);
  buffer.writeUInt32BE(index, 4);
  return buffer;
}

export async function createSignature(
  address: Buffer,
  signer: Wallet,
  batchID: Buffer,
  index: Buffer,
  timestamp: number
): Promise<Buffer> {
  console.log('Address', address.toString('hex'));
  if (!Buffer.isBuffer(address)) {
    throw Error('Expected address to be a Buffer');
  }
  if (!Buffer.isBuffer(batchID)) {
    throw Error('Expected batchID to be a Buffer');
  }
  if (address.length !== 32) {
    throw Error('Expected 32 byte address, got ' + address.length + ' bytes');
  }
  if (batchID.length !== 32) {
    throw Error('Expected 32 byte batchID, got ' + batchID.length + ' bytes');
  }

  const timestampBuffer = Buffer.alloc(8);
  timestampBuffer.writeBigUInt64BE(BigInt(timestamp));
  const packed = utils.solidityPack(
    ['bytes32', 'bytes32', 'bytes8', 'bytes8'],
    [address, batchID, index, timestampBuffer]
  );
  console.log('Index', index.toString('hex'));
  console.log('Timestamp', timestampBuffer.toString('hex'));
  console.log('Digest', { packed });
  const packedBuffer = Buffer.from(packed.slice(2), 'hex');
  const keccaked = keccak256(packedBuffer);
  const signable = Buffer.from(keccaked.startsWith('0x') ? keccaked.slice(2) : keccaked, 'hex');
  const signedHexString = await signer.signMessage(signable);
  console.log({ signedHexString });
  const signed = Buffer.from(signedHexString.slice(2), 'hex');
  if (signed.length !== 65) {
    throw Error('Expected 65 byte signature, got ' + signed.length + ' bytes');
  }
  return signed;
}

export async function marshalPostageStamp(
  batchID: Buffer,
  timestamp: number,
  address: Buffer,
  signer: Wallet
): Promise<Buffer> {
  if (!Buffer.isBuffer(address)) {
    throw Error('Expected address to be a Buffer');
  }
  if (address.length !== 32) {
    throw Error('Expected 32 byte address, got ' + address.length + ' bytes');
  }
  const bucket = swarmAddressToBucketIndex(16, address);
  const index = bucketAndIndexToBuffer(bucket, 0);
  console.log({ index });
  const signature = await createSignature(address, signer, batchID, index, timestamp);
  const buffer = Buffer.alloc(32 + 8 + 8 + 65);
  batchID.copy(buffer, 0);
  index.copy(buffer, 32);
  buffer.writeBigUInt64BE(BigInt(timestamp), 40);
  signature.copy(buffer, 48);
  return buffer;
}

export async function constructPostageStamp(
  batchID: Buffer,
  address: Buffer,
  signer: Wallet,
  timestamp?: number
): Promise<{ signature: Uint8Array; index: Uint8Array }> {
  if (!Buffer.isBuffer(address)) {
    throw Error('Expected address to be a Buffer');
  }
  if (address.length !== 32) {
    throw Error('Expected 32 byte address, got ' + address.length + ' bytes');
  }
  timestamp ||= Math.floor(Date.now() / 1000);

  const bucket = swarmAddressToBucketIndex(16, address);
  const index = bucketAndIndexToBuffer(bucket, 0);
  console.log({ index });
  const signature = await createSignature(address, signer, batchID, index, timestamp);

  return {
    signature,
    index,
  };
}
