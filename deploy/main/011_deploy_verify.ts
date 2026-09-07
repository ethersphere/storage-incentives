import { DeployFunction } from 'hardhat-deploy/types';
import verify from '../../utils/verify';

const func: DeployFunction = async function ({ deployments, network }) {
  const { log, get } = deployments;

  if (network.name == 'mainnet' && process.env.MAINNET_ETHERSCAN_KEY) {
    const postageStamp = await get('PostageStamp');
    const priceOracle = await get('PriceOracle');
    const staking = await get('StakeRegistry');
    const redistribution = await get('Redistribution');

    log('Verifying PostageStamp implementation...');
    if (postageStamp.implementation) {
      await verify(postageStamp.implementation, []);
    }
    log('----------------------------------------------------');

    log('Verifying PriceOracle implementation...');
    if (priceOracle.implementation) {
      await verify(priceOracle.implementation, []);
    }
    log('----------------------------------------------------');

    log('Verifying StakeRegistry implementation...');
    if (staking.implementation) {
      await verify(staking.implementation, []);
    }
    log('----------------------------------------------------');

    log('Verifying Redistribution implementation...');
    if (redistribution.implementation) {
      await verify(redistribution.implementation, []);
    }
    log('----------------------------------------------------');

    const registryRouter = await get('VersionedRegistryRouter');
    const proxyAdmin = await get('DefaultProxyAdmin');
    log('Verifying VersionedRegistryRouter...');
    await verify(registryRouter.address, [proxyAdmin.address]);
    log('----------------------------------------------------');
  }
};

export default func;
func.tags = ['verify'];
