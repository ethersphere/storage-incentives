import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';
import verify from '../../utils/verify';

const func: DeployFunction = async function ({ deployments, network }) {
  const { log, get } = deployments;

  if (process.env.TESTNET_ETHERSCAN_KEY) {
    const token = await get('TestToken');
    const argsToken = ['sBZZ', 'sBZZ', '1250000000000000000000000'];

    log('TestToken');
    await verify(token.address, argsToken);
    log('----------------------------------------------------');

    const postageStamp = await get('PostageStamp');
    log('PostageStamp implementation');
    if (postageStamp.implementation) {
      await verify(postageStamp.implementation, []);
    }
    log('----------------------------------------------------');

    const priceOracle = await get('PriceOracle');
    log('PriceOracle implementation');
    if (priceOracle.implementation) {
      await verify(priceOracle.implementation, []);
    }
    log('----------------------------------------------------');

    const staking = await get('StakeRegistry');
    log('StakeRegistry implementation');
    if (staking.implementation) {
      await verify(staking.implementation, []);
    }
    log('----------------------------------------------------');

    const redistribution = await get('Redistribution');
    log('Redistribution implementation');
    if (redistribution.implementation) {
      await verify(redistribution.implementation, []);
    }
    log('----------------------------------------------------');

    const registryRouter = await get('VersionedRegistryRouter');
    const proxyAdmin = await get('DefaultProxyAdmin');
    log('VersionedRegistryRouter');
    await verify(registryRouter.address, [proxyAdmin.address]);
    log('----------------------------------------------------');
  }
};

export default func;
func.tags = ['verify'];
