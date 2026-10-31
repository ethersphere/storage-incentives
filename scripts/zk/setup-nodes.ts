// Fund and stake the simulated nodes for ZK settlement.
//
//   NODE_KEYS=0xabc,0xdef npx hardhat run scripts/zk/setup-nodes.ts --network zklocal
//
// For each key: top up ETH from the deployer (NODE_ETH, default 0.02), send sBZZ, approve and call
// StakeRegistry.manageStake. Skips nodes that are already staked. Nodes can play two rounds after staking.
import { ethers, deployments, network } from 'hardhat';

async function main() {
  const keys = (process.env.NODE_KEYS || '').split(',').filter((k) => k.trim());
  if (keys.length === 0) throw new Error('set NODE_KEYS');
  const [deployer] = await ethers.getSigners();
  const token = await ethers.getContractAt('TestToken', (await deployments.get('TestToken')).address, deployer);
  const staking = await ethers.getContractAt('StakeRegistry', (await deployments.get('StakeRegistry')).address);
  const minEth = ethers.utils.parseEther(process.env.NODE_ETH || '0.02');

  for (const [i, key] of keys.entries()) {
    const node = new ethers.Wallet(key.trim(), ethers.provider);
    if ((await staking.lastUpdatedBlockNumberOfAddress(node.address)).gt(0)) {
      console.log(`node ${i} ${node.address} already staked, overlay ${await staking.overlayOfAddress(node.address)}`);
      continue;
    }
    if ((await node.getBalance()).lt(minEth)) {
      await (await deployer.sendTransaction({ to: node.address, value: minEth })).wait();
    }
    const stake = ethers.BigNumber.from('100000000000000000').mul(i + 1);
    await (await token.transfer(node.address, stake)).wait();
    await (await token.connect(node).approve(staking.address, stake)).wait();
    const nonce = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`zk-node-${i}`));
    await (await staking.connect(node).manageStake(nonce, stake, 0)).wait();
    console.log(`node ${i} ${node.address} staked ${stake}, overlay ${await staking.overlayOfAddress(node.address)}`);
  }
  console.log(`network ${network.name}, block ${await ethers.provider.getBlockNumber()}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
