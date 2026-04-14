import { expect } from './util/chai';
import { ethers, getNamedAccounts, getUnnamedAccounts, deployments } from 'hardhat';
import {
  mineNBlocks,
  encodeAndHash,
  mintAndApprove,
  createOverlay,
  ROUND_LENGTH,
  PHASE_LENGTH,
  copyBatchForClaim,
  mineToRevealPhase,
} from './util/tools';
import { BigNumber } from 'ethers';
import { arrayify, hexlify } from 'ethers/lib/utils';
import { getClaimProofs, makeSample, setWitnesses } from './util/proofs';

const { read, execute } = deployments;

interface Outcome {
  node: string;
  stake: string;
  wins: number;
}

// Named accounts used by tests.
let deployer: string, stamper: string, oracle: string, pauser: string;
let others: string[];

const STATS_PREVRANDAO_SEQUENCE = [
  '0xab7643607671cd4b0a8e15ead33e41de652a4007c4ac16d2146460d86c63ecf7',
  '0xb2653f2236fa800a603e9d56aff7f5298faa70e84accd3c74a800b3294c7786d',
  '0x6a580e448d0f38928279c7c77ad1595c9ff0f74ae1ad80817fd08e6b19a1a85e',
  '0xa7c9f1f52ef20e39782785b40c63d586a542abe8a0010083797d4f455302d1c2',
  '0xc8c84156a8dab225afe907019064ef94e0cc4ef51f9a7693888213aaf716abc7',
  '0x3cfcdaf8601d1ef9aad03beabca86167d4d5a5b1701d3dae05fedb6a9d0ee6ec',
  '0xaa859c8b848d125a787a0b4cff5ca5be1f2ca3210763519851083bffb1fd093e',
  '0xdfeed58f4fbd216d3abe607184accd39205d26ec59c356f6e98b53b98624a038',
  '0x20de5a94dca5429bfbeb97c62be81b08ed14f1edb8b55b2a66033a9de6381733',
  '0x5a2f1a2abf7dde55f71f8377793bdad2e153cb5a48b51a3504fa00470c7992f4',
  '0xf42916b63c9ec1ca861e8748e35afe5364adfd3f90d761345ba3b6849bc1dc89',
  '0xdce8f86a969662ac4cd46bb6afd37265cfb836c2e2a06579e7e5fb09a1d553d4',
  '0xddbedb13eb44d7306d01804dcd847b9b220ce5edc8d346b89c026f04dd204ca8',
  '0x9f992a69711824d841452c6473e15d9344ae782463671a310905a9bbc6547197',
  '0xa1c582591829c01547da85c252058cfe2e749aa0628f477a4ec8386ddc4e3fa7',
  '0x28b8825d3fd8aca7953e656ee878f6c40110bf120f2462a44337867b573d6172',
  '0x5ba27ac55a171cc7bb24ca214fa156f0c7a869195da8f605fef967ffc7316db2',
  '0xaa686d0e6b1c335a7aa53c74519f815f0fdae45a43f8d6cb9cfe7188e666c9c8',
  '0x2b0e823c5ec548ba5d43ec768174c0ae34d14b1c8e356b5551fb885b1a8f2217',
  '0x9959cc37f4e28d78eb88e4972ac3c23c7966ad1d7e307010834d236d7d1a995a',
  '0x2f5f111cc7e2f4b49bd419942eb1d4e1e8bff92c4d530c5476eda719e9e36cea',
  '0xdccc400bfc3315a63e124cf14a87ba27ecccf67637fae710bfc25daeedf26c2d',
  '0x230b40c3e6b9de7f1cf3d9cc12f8c2ab7468b496a152d6d3d4444ab370f6dbfd',
  '0xea270dbc0bfc12188b03dfd61ccb2b6b74a51f92ec46a9dbe987a44682569172',
  '0xd56affd066498869cc1220ec03d690602459761405f8fd70cf315bd6c350e049',
  '0x19b9cf20820c14df9c1f7debdbe32391d7d1666235ea87256a8d1199d6718428',
  '0x3e3fd645066179f47f1d4c21690493eeab3940a40e8f3d97d060bbdd90f31f6a',
  '0xdeb28973f20db37dafc73f4e548edc52e6683221fa405f65a5dfde5f5ef56a85',
  '0x920e9b8c9582b484af3addb74ce751121bf3f620031073afc4aaa0d684275f3c',
  '0xa7596525b2903a1d8d9a04d3b84d66061fb39f62b9b2bf80abd2dfed5bbbc0c9',
  '0x3752dd7f877a52331e685ca7dafa66133c48f3174579e76e4469d85bf09bd322',
  '0x7208b9cd5ec524dda0de6873af05b8863b2b30355eb3b61e58a1faa04465ac73',
  '0x401ba5fe0a8f03a129c16a981272781d73f28db1246813a62fc9e760a088519d',
  '0x6b5346bf59297f45a1e5a4362ede769ad7f5ee03fdec3caf9be0e82fda33d5b4',
  '0xfb3680fabbbf76b618ffabd221cf59202672a6ae18779035389927f07df11f9c',
  '0x89939555720ed408e13dbc7ac4667bed226bbc8231d91f394c7d1c00a4744a5e',
  '0xe286d184179876d0bd8fb3e657d7c5e17facc778684733875f2fda696915a19d',
  '0xd93f299d973c8826fb296fe6d9584f2004a8851d106f2e7aa0f6dd96707ca208',
  '0x14d6622750c3020493a4d00ebde45424ad434f4d9a41c1a7d2fac312e78b3198',
  '0xf55714c3c10dc36f0808a3f0efe7b4379a6e139497743796f0e96b3d3ffcffc6',
  '0x24591ce3fc659795514f29b18cabee9d9c244bdda0b967ddc5d19b8bd285f53b',
  '0x1d367c54e88f56794a112086a0a66c784ce91e0784376eaf6ec3fb2c1893a415',
  '0x3f5edeffc0c72d060c8880cc1212b3623c59dd2518890fccbb789beec206fc80',
  '0x1e10cea6e8f6ea41382823f1efcf26c986a50328a575a797ab6a1a74f84c1eca',
  '0xcbb4fa59ed9a6268da82a6a0f8390c34b491be98066ec30a5132408a4d7f90aa',
  '0x8e698266187528b561846a239001fe23a895dd0f5ba98c33a1c98f98d21149fa',
  '0x4c75ed251832657d6d5ecf0b0af2fb96fab2a798b1cd0f250a7eb14d02e2a51c',
  '0xc888b298207bd30419e7d5ec5c06f49ee962f63144a8b624a32d5ee871159123',
  '0x89c275e4ec80a404de679f7f4f57ebea32b283cad1f201680115d20c634efd29',
  '0xc404af4848bd80a6520c4263b8e8e579a8934f55bfb19a25bd097e85cd637d37',
  '0xd2edcc97cb1ea4d05b7e6fd9b8454fe252dc04b7dc65db89e2fa297dc935478f',
  '0x3e2b24992a026a40c8bb68b33acda6b6593971059f991938a3a7a0d157184ed0',
  '0x83b76670f5b18c48f6573854d082adfc035cc11e07772f5a2e915f43abf324bf',
  '0x940baa8c374f3a319908719ecc0a017cfbc595ff83d52cd7f3ea2afc983e2868',
  '0xccb88acd7ee144f93ab9e33cf699fd51183a478018e007f2af89425d954a371e',
  '0x1c45d63d278cc83198ef284cce29cebe38d4c435e69ada8311badba87381306f',
  '0xdb1fcccc12059bf8f866863d49d4fcc6af46c04e2676cae89d18d363b1c8e881',
  '0x186bf9e869dbe48095f173ede0f6d2d32f574d746aa9722093e71a84dcc83224',
  '0xfbe7d6fe18b9b2a3963181473220117d7cae48fbc6605bf7dd861f72a2711fbb',
  '0x3abb045e4384595853c98b9be0b6bc00fad1e1b6ed0056e28b43624450230e35',
  '0x3bbf0544eb29823ca182874b359b2120d4e1375cc76a46196e744b4738774169',
  '0xe5615e5f5cca0988fdc2ed29506d39de4a0bdd2270b7e69b19b5f2ec6498d784',
  '0x33c98821e3f1aa4fb5b726d9baa1c697e1042d4e28001a06282d0b135e8615e4',
  '0xbfdecf24108045b1e03338345312f5a020fa29020683ff4a4304365b441906d5',
  '0xd9a372db8bbbe2aea6ff26fe1dfc04847a524e4dac3468f19b5cec9f4ea1c5f9',
  '0xab971f1fb7eec3dc7ed781d0e06fae26ac8aca114c1e824eb72d00dde4900a65',
  '0xaa1227368ae4788a35d85b4458f7360bd8e0061d1b5d5c6fd60029809df68514',
  '0x99a10987d7a71cab5357753a8c3fc580c242b4a4a36f6578cc7e953133160fc4',
  '0xdf62a16b5df6ada44f5bb17ca5a556c02992ab04d1cf978b0ee82ef482ed3781',
  '0x0d6dbd263b454d1011bc650537d911dfc2ac7e002a8894fca537a499b2a90349',
  '0x3d97ec2671c38422de094a7daddf0d57faab8bae39c3c004500a4eea8974ffc5',
  '0x63edc3a784554ce76820654a5b06b5a3e4897d7e81f5b7865afc12f7deaf7d65',
  '0x54ea988f0b12c8188097c0e18c622a8cbbb13dc752ea1fa07e740a4bcceaef05',
  '0x3d18da2a222db987c1639b176b763116e4b8614a8ccbb2aac75df4c110390ba4',
  '0xa5e5544824e87b223e62c50df42789e006c3739997dec7ca01cbe0f2d0ed59b6',
  '0x684c28af814b08c6a97855a2b19aaf3f04aaca3a6c398211d4f85d3ad6b75ad8',
  '0xa672d576a62ad02d2642bef0b675d64c4c78fa4d552e6fe59de8ddc18663fc5a',
  '0xd222e9c678ee2f7a38a45194b730091d7424fec3d988d6ffe4136e824551f2c1',
  '0x1c5f876c6e58dfb53bb05c4f011d64a0917ec63fd6e898d62f54cb45c174033e',
  '0xe3a13cae4a642bc13f8a79d016fe61202a4c5a27c2714ecdaaf8b2428492a0cb',
  '0xc241d0b6987c207c0adc8f39fa586bc9712868d9018bbeca652f8338cef755a3',
  '0x188704317a827113bf2dbb129cda16569c0544e6d78af2dde0c7b7b3a246c12f',
  '0x5eb2a4d3ec009f289baf9a1db28f20159e46af279f8f9819f6a30d488d6532ed',
  '0x92e0d413114c3583795e8b0188b40f393a422f8b3166f2bb5ec6b31856b2a708',
  '0x9602e444713d536fa1efc32501c56f6851e5285fc8c9f1a9c272921b90037bb9',
  '0xef9421b57a3ae5e5db99b3502cd7a86c26eb0e86eeace6341766c277cc0ab86b',
  '0x13c5e63a8c65eabf520e9b7c9ffcce3637a52ca3b4216ca13419c48b3b079791',
  '0xa07bc0c84425c3b44af0656c99115cde07e2e7fb7fa9db093c7343fabfa2dc0e',
  '0x794f2212ecccd0350f223e9ece6a619841e794f6b95f67142e7e04f6e7b185ac',
  '0x7545d55ac07735ce34d10e1900812bc3100b548db4bff51021a049a9a5a8cf5e',
  '0xa8905ce1b4bb7b468c8737b30566a56865f59f67387d630feb57b0ebe4790dc2',
  '0x0183c3b72bbe5a275b2bbefcb197ec563940b4106a319043d838c4c931392114',
  '0x0a0a19819a12d64fc8d4c0e672f3057854015724fe532f7ba50c29cd654dc9f4',
  '0xd54d39f6abbde3324942b51f47130d354f85925f0420c42970d7d03d70dbe41e',
  '0xfed3fdd970267d973cc752112d7ef9d706869a948d406f8db044571c1a87975d',
  '0x472769868a0aa716b4248a738daa31e0356bf95478516c88ec402a5ea08dadb0',
  '0x69a513bc3741b6969c62f910b511e50ca6d14151bf018185051975cf105c18ba',
  '0x9341200ee61730ac73af7d37f84fa87731d007b0bb9e0b110dbb4b2f69d0974a',
  '0x191c33bbf067bc8d15d8e24a46bb4f596d14aaef3d71d59fe3bbdc250e55d73b',
  '0x25a2d5f187dcfc39d60c078aa72d5ffe3e30945e9a748fb9c50267ec1c55fe77',
];

// Before the tests, assign accounts
before(async function () {
  const namedAccounts = await getNamedAccounts();
  deployer = namedAccounts.deployer;
  stamper = namedAccounts.stamper;
  oracle = namedAccounts.oracle;
  pauser = namedAccounts.pauser;
  others = await getUnnamedAccounts();
});

async function nPlayerGames(nodes: string[], stakes: string[], effectiveStakes: string[], trials: number) {
  const price1 = 100;

  const postageStampOracle = await ethers.getContract('PostageStamp', oracle);
  await postageStampOracle.setPrice(price1);

  const postageStampAdmin = await ethers.getContract('PostageStamp', deployer);
  await postageStampAdmin.setMinimumValidityBlocks(0);

  const { postageDepth, initialBalance, batchId, batchOwner } = await copyBatchForClaim(
    deployer,
    '0x5bee6f33f47fbe2c3ff4c853dbc95f1a6a4a4191a1a7e3ece999a76c2790a83f'
  );

  const batchSize = BigNumber.from(2).pow(BigNumber.from(postageDepth));
  const transferAmount = BigNumber.from(2).mul(BigNumber.from(initialBalance)).mul(batchSize);

  const postage = await ethers.getContract('PostageStamp', stamper);
  await mintAndApprove(deployer, stamper, postage.address, transferAmount.toString());

  const depth = '0x00';
  const nonce = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';
  const reveal_nonce = '0xb5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33b5555b33';

  for (let i = 0; i < nodes.length; i++) {
    const sr_node = await ethers.getContract('StakeRegistry', nodes[i]);
    await mintAndApprove(deployer, nodes[i], sr_node.address, stakes[i]);
    await sr_node.manageStake(nonce, stakes[i], 0);
  }

  const winDist: Outcome[] = [];
  for (let i = 0; i < nodes.length; i++) {
    winDist.push({ node: nodes[i], stake: stakes[i], wins: 0 });
  }

  let r_node = await ethers.getContract('Redistribution', nodes[0]);

  await mineNBlocks(ROUND_LENGTH * 2); // anyway reverted with panic code 0x11 (Arithmetic operation underflowed or overflowed outside of an unchecked block

  for (let i = 0; i < trials; i++) {
    const anchor1 = arrayify(await r_node.currentSeed());

    // mine new witness chunks because of new anchor and reserve estimation
    const numbering = String(i).padStart(3, '0');
    const witnessChunks = await setWitnesses(`stats-${numbering}`, anchor1, Number(depth));
    const sampleChunk = makeSample(witnessChunks);

    const sampleHashString = hexlify(sampleChunk.address());

    for (let i = 0; i < nodes.length; i++) {
      const r_node = await ethers.getContract('Redistribution', nodes[i]);
      const overlay = createOverlay(nodes[i], depth, nonce);
      const obfuscatedHash = encodeAndHash(overlay, depth, sampleHashString, reveal_nonce);
      const currentRound = await r_node.currentRound();
      await r_node.commit(obfuscatedHash, currentRound);
    }

    await mineToRevealPhase();
    await ethers.provider.send('hardhat_setPrevRandao', [STATS_PREVRANDAO_SEQUENCE[i]]);

    for (let i = 0; i < nodes.length; i++) {
      const r_node = await ethers.getContract('Redistribution', nodes[i]);
      await r_node.reveal(depth, sampleHashString, reveal_nonce);
    }

    const anchor2 = await r_node.currentSeed(); // for creating proofs

    await mineNBlocks(PHASE_LENGTH - nodes.length + 1);

    let winnerIndex = 0;
    for (let i = 0; i < winDist.length; i++) {
      const overlay = createOverlay(winDist[i].node, depth, nonce);
      if (await r_node.isWinner(overlay)) {
        winDist[i].wins++;
        winnerIndex = i;
      }
    }
    r_node = await ethers.getContract('Redistribution', nodes[winnerIndex]);

    const { proofParams } = await getClaimProofs(witnessChunks, sampleChunk, anchor1, anchor2, batchOwner, batchId);

    await r_node.claim(proofParams.proof1, proofParams.proof2, proofParams.proofLast);

    const sr = await ethers.getContract('StakeRegistry');

    //stakes are preserved

    for (let i = 0; i < nodes.length; i++) {
      expect(await sr.nodeEffectiveStake(nodes[i])).to.be.eq(effectiveStakes[i]);
    }

    await mineNBlocks(PHASE_LENGTH * 2 - nodes.length);
  }

  return winDist;
}

describe('Stats', async function () {
  beforeEach(async function () {
    await ethers.provider.send('hardhat_reset', []);
    await deployments.fixture();
    const priceOracleRole = await read('PostageStamp', 'PRICE_ORACLE_ROLE');
    await execute('PostageStamp', { from: deployer }, 'grantRole', priceOracleRole, oracle);

    const pauserRole = await read('StakeRegistry', 'DEFAULT_ADMIN_ROLE');
    await execute('StakeRegistry', { from: deployer }, 'grantRole', pauserRole, pauser);

    const priceOracle = await ethers.getContract('PriceOracle', deployer);
    await priceOracle.pause(); // TODO: remove when price oracle is not paused by default.
  });

  describe('two player game', async function () {
    const trials = 100;

    it('is fair with 1:3 stake', async function () {
      this.timeout(120000);
      const allowed_variance = 0.035;
      const stakes = ['100000000000000000', '300000000000000000'];
      const effectiveStakes = ['99999999999984000', '300000000000000000'];
      const nodes = [others[0], others[1]];

      const dist = await nPlayerGames(nodes, stakes, effectiveStakes, trials);
      let sumStakes = BigInt(0);
      for (let i = 0; i < stakes.length; i++) {
        sumStakes += BigInt(stakes[i]);
      }

      for (let i = 0; i < dist.length; i++) {
        const actual =
          parseInt((BigInt(dist[i].stake) / BigInt('100000000000000000')).toString()) /
          parseInt((sumStakes / BigInt('100000000000000000')).toString());
        const probable = dist[i].wins / trials;
        expect(Math.abs(actual - probable)).be.lessThan(allowed_variance);
      }
    });
  });
});
