import { DeployFunction } from 'hardhat-deploy/types';
import { developmentChains } from '../helper-hardhat-config';
import verify from '../utils/verify';

const func: DeployFunction = async function ({ deployments, network }) {
  const { log, get } = deployments;

  // contract veryfing vars
  const token = await get('TestToken');
  const networkID = network.config.chainId as number;

  if (!developmentChains.includes(network.name) && process.env.MAINNET_ETHERSCAN_KEY) {
    // Verify postageStamp
    const postageStamp = await get('PostageStamp');
    const argsStamp = [token.address, 16];

    log('Verifying...');
    await verify(postageStamp.address, argsStamp);
    log('----------------------------------------------------');

    // Verify oracle
    const priceOracle = await get('PriceOracle');
    const argsOracle = [postageStamp.address];

    log('Verifying...');
    await verify(priceOracle.address, argsOracle);
    log('----------------------------------------------------');

    // Verify staking
    const staking = await get('StakeRegistry');
    const argStaking = [token.address, networkID];

    log('Verifying...');
    await verify(staking.address, argStaking);
    log('----------------------------------------------------');

    // Verify redistribution
    const redistribution = await get('Redistribution');
    const argRedistribution = [staking.address, postageStamp.address, priceOracle.address];

    log('Verifying...');
    await verify(redistribution.address, argRedistribution);
    log('----------------------------------------------------');
  }
};

export default func;
func.tags = ['main', 'verify'];
