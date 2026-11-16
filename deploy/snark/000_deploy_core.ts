import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

// SNARK settlement deployment (docs/SNARK-SETTLEMENT.md): TestToken, PostageStamp and StakeRegistry from
// master, unchanged, and PriceOracleSnark (64-block rounds) in place of PriceOracle. Redistribution is not
// deployed; Settlement takes its roles.
const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, get, log } = deployments;
  const { deployer } = await getNamedAccounts();
  const waitConfirmations = networkConfig[network.name]?.blockConfirmations || 1;

  log('Deployer', deployer);
  await deploy('TestToken', {
    from: deployer,
    args: ['sBZZ', 'sBZZ', '1' + '0'.repeat(30)],
    log: true,
    waitConfirmations,
  });
  const token = await get('TestToken');
  // PostageStamp of master, unchanged. Settlement takes the pot out of it once a round (withdraw).
  await deploy('PostageStamp', {
    from: deployer,
    args: [token.address, 16],
    log: true,
    waitConfirmations,
  });
  const postage = await get('PostageStamp');
  // PriceOracleSnark: PriceOracle with 64-block rounds (12 s blocks), as Settlement.
  await deploy('PriceOracle', {
    from: deployer,
    contract: 'PriceOracleSnark',
    args: [postage.address],
    log: true,
    waitConfirmations,
  });
  const oracle = await get('PriceOracle');
  await deploy('StakeRegistry', {
    from: deployer,
    args: [token.address, networkConfig[network.name]?.swarmNetworkId ?? 0, oracle.address],
    log: true,
    waitConfirmations,
  });
};

export default func;
func.tags = ['snark', 'core'];
