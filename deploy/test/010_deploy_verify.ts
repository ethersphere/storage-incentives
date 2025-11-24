import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';
import verify from '../../utils/verify';

const func: DeployFunction = async function ({ deployments, network }) {
  const { log, get } = deployments;

  // Support testnet with Etherscan API V2 or legacy key
  if (process.env.ETHERSCAN_API_KEY || process.env.TESTNET_ETHERSCAN_KEY) {
    const swarmNetworkID = networkConfig[network.name]?.swarmNetworkId;
    const roundLength = networkConfig[network.name]?.roundLength || 152;
    const minimumValidityBlocks = networkConfig[network.name]?.minimumValidityBlocks || 17280;

    // Verify TestNet token
    const token = await get('TestToken');
    const argsToken = ['sBZZ', 'sBZZ', '1250000000000000000000000'];

    log('Verifying TestToken...');
    await verify(token.address, argsToken);
    log('----------------------------------------------------');

    // Verify postageStamp
    const postageStamp = await get('PostageStamp');
    const argsStamp = [token.address, 16, minimumValidityBlocks];

    log('Verifying PostageStamp...');
    await verify(postageStamp.address, argsStamp);
    log('----------------------------------------------------');

    // Verify oracle
    const priceOracle = await get('PriceOracle');
    const argsOracle = [postageStamp.address, roundLength];

    log('Verifying PriceOracle...');
    await verify(priceOracle.address, argsOracle);
    log('----------------------------------------------------');

    // Verify staking
    const staking = await get('StakeRegistry');
    const argStaking = [token.address, swarmNetworkID, priceOracle.address];

    log('Verifying StakeRegistry...');
    await verify(staking.address, argStaking);
    log('----------------------------------------------------');

    // Verify redistribution
    const redistribution = await get('Redistribution');
    const argRedistribution = [staking.address, postageStamp.address, priceOracle.address, roundLength];

    log('Verifying Redistribution...');
    await verify(redistribution.address, argRedistribution);
    log('----------------------------------------------------');
  }
};

export default func;
func.tags = ['verify'];
