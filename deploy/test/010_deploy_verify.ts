import { DeployFunction } from 'hardhat-deploy/types';
import { deployedBzzData, networkConfig } from '../../helper-hardhat-config';
import verify from '../../utils/verify';

const func: DeployFunction = async function ({ deployments, network, ethers }) {
  const { log, get } = deployments;

  if (network.name == 'testnet' && process.env.TESTNET_ETHERSCAN_KEY) {
    // contract verifying vars
    const token = await ethers.getContractAt(deployedBzzData[network.name].abi, deployedBzzData[network.name].address);
    const swarmNetworkID = networkConfig[network.name]?.swarmNetworkId;

    // Verify postageStamp
    const postageStamp = await get('PostageStamp');
    const argsStamp = [token.address, 16, networkConfig[network.name]?.multisig];

    log('Verifying...');
    await verify(postageStamp.address, argsStamp);
    log('----------------------------------------------------');

    // Verify oracle
    const priceOracle = await get('PriceOracle');
    const argsOracle = [postageStamp.address, networkConfig[network.name]?.multisig];

    log('Verifying...');
    await verify(priceOracle.address, argsOracle);
    log('----------------------------------------------------');

    // Verify staking
    const staking = await get('StakeRegistry');
    const argStaking = [token.address, swarmNetworkID, networkConfig[network.name]?.multisig];

    log('Verifying...');
    await verify(staking.address, argStaking);
    log('----------------------------------------------------');

    // Verify redistribution
    const redistribution = await get('Redistribution');
    const argRedistribution = [
      staking.address,
      postageStamp.address,
      priceOracle.address,
      networkConfig[network.name]?.multisig,
    ];

    log('Verifying...');
    await verify(redistribution.address, argRedistribution);
    log('----------------------------------------------------');
  }
};

export default func;
func.tags = ['verify'];
