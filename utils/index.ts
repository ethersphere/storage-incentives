/** returns byte representation of the hex string */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.startsWith('0x')) {
    hex = hex.slice(2);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const hexByte = hex.substr(i * 2, 2);
    bytes[i] = parseInt(hexByte, 16);
  }

  return bytes;
}

/** returns the Proximity Order of the two hex strings */
export function proximity(hexA: string, hexB: string): number {
  const one = hexToBytes(hexA);
  const other = hexToBytes(hexB);

  const b = one.length < other.length ? one.length : other.length;
  const m = 8;
  for (let i = 0; i < b; i++) {
    const oxo = one[i] ^ other[i];
    for (let j = 0; j < m; j++) {
      if (((oxo >> (7 - j)) & 0x01) != 0) {
        return i * 8 + j;
      }
    }
  }
  return b * 8;
}
