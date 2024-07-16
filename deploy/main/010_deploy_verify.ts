import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';
import verify from '../../utils/verify';

const func: DeployFunction = async function ({ deployments, network }) {
  const { log, get } = deployments;

  if (network.name == 'mainnet' && process.env.MAINNET_ETHERSCAN_KEY) {
    const swarmNetworkID = networkConfig[network.name]?.swarmNetworkId;
    const token = await get('Token');

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
    const argStaking = [token.address, swarmNetworkID, priceOracle.address];

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
func.tags = ['verify'];
