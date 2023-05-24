import { expect } from './util/chai';
import { createSOC, mineOverlayInDepth, mineSOCinDepth, mineCACinDepth, compareHexAsBinary } from './util/tools';

const prefix = '0xac33';
const overlayNonce = '0x00';
const networkID = '0x00';
const depth = 6;
const maxAttempts = 10000;
const socOwner = '0x8d3766440f0d7b949a5e32995d09619a7f86e632';
const identifier = '0x0000000000000000000000000000000000000000000000000000000000000000';

describe('tools', async function () {
  it('creates soc', async function () {
    const o = await createSOC(identifier, socOwner);
    expect(o).to.be.eq('0x9d453ebb73b2fedaaf44ceddcf7a0aa37f3e3d6453fea5841c31f0ea6d61dc85');
  });

  it('mines overlay in depth', async function () {
    const o = await mineOverlayInDepth(prefix, overlayNonce, networkID, depth, maxAttempts);
    expect(compareHexAsBinary('0xac33', o.overlay, depth)).to.be.true;
  });

  it('mines soc in depth', async function () {
    const o = await mineSOCinDepth(socOwner, prefix, depth, maxAttempts);
    expect(o.address).to.be.eq('0xac92f680a73a684849e4d6d4cc3c232726c1a14430eb1fafdfce712f61351434');
    expect(o.identifier).to.be.eq('0x0000009200000000000000000000000000000000000000000000000000000000');
  });

  it('mines cac in depth', async function () {
    const o = await mineCACinDepth('0xac33', 6, 10000);
    expect(o.address).to.be.eq('0xad5553436c4eb621c9a38a643db558bf9816e2e98e9cdd0c69cdc4c2077adaf0');
    expect(o.payload).to.be.eq('0x0000008000000000000000000000000000000000000000000000000000000000');
  });
});