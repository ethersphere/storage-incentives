"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const worker_threads_1 = require("worker_threads");
const bmt_js_1 = require("@fairdatasociety/bmt-js");
const ethers_1 = require("ethers");
const { keccak256Hash } = bmt_js_1.Utils;
const SAMPLE_MAX_VALUE = ethers_1.BigNumber.from('1284401000000000000000000000000000000000000000000000000000000000000000000');
function numberToArray(n) {
    const buff = Buffer.alloc(32);
    buff.writeUint32BE(n);
    return Uint8Array.from(buff);
}
function transformedHashFn(anchor) {
    return (...messages) => keccak256Hash(anchor, ...messages);
}
function calculateTransformedAddress(nonceBuf, anchor) {
    const chunk = (0, bmt_js_1.makeChunk)(nonceBuf, { hashFn: transformedHashFn(anchor) });
    return chunk.address();
}
function inProximity(a, b, minimum) {
    let byteIndex = 0;
    let remainingBits = minimum;
    while (remainingBits > 0) {
        if (remainingBits >= 8) {
            if (a[byteIndex] !== b[byteIndex])
                return false;
            byteIndex++;
            remainingBits -= 8;
        }
        else {
            const aBits = a[byteIndex] >>> (8 - remainingBits);
            const bBits = b[byteIndex] >>> (8 - remainingBits);
            return aBits === bBits;
        }
    }
    return true;
}
function reserveSizeEstimationAcceptance(transformedAddress) {
    return ethers_1.BigNumber.from(transformedAddress).lt(SAMPLE_MAX_VALUE);
}
function tAddressAcceptance(ogChunkAddress, transformedAddress, anchor, depth) {
    return reserveSizeEstimationAcceptance(transformedAddress) && inProximity(ogChunkAddress, anchor, depth);
}
function mineCacWitness(anchor, depth, startNonce) {
    let i = 0;
    while (true) {
        const nonce = i++ + startNonce;
        const nonceBuf = numberToArray(nonce);
        const transformedAddress = calculateTransformedAddress(nonceBuf, anchor);
        if (tAddressAcceptance((0, bmt_js_1.makeChunk)(nonceBuf).address(), transformedAddress, anchor, depth)) {
            return {
                nonce,
                transformedAddress: '0x' + Buffer.from(transformedAddress).toString('hex'),
            };
        }
    }
}
const { anchor, depth, startNonce, witnessIndex } = worker_threads_1.workerData;
const anchorBuf = new Uint8Array(anchor);
const result = mineCacWitness(anchorBuf, depth, startNonce);
worker_threads_1.parentPort?.postMessage({ witnessIndex, ...result });
