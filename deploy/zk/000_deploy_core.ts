import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

// ZK settlement deployment (docs/ZK-SETTLEMENT.md): TestToken, PriceOracle and StakeRegistry from master,
// unchanged, and PostageStampZK in place of PostageStamp. Redistribution is not deployed; Settlement takes
// its roles.
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
  // PostageStampZK: PostageStamp without the batch tree; expiry and the pot are computed in the settlement
  // proof. Deployed under the name 'PostageStamp' so the other scripts and tools find it.
  await deploy('PostageStamp', {
    from: deployer,
    contract: 'PostageStampZK',
    args: [token.address, 16],
    log: true,
    waitConfirmations,
  });
  const postage = await get('PostageStamp');
  // PriceOracleZK: PriceOracle with 64-block rounds (12 s blocks), as Settlement.
  await deploy('PriceOracle', {
    from: deployer,
    contract: 'PriceOracleZK',
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
func.tags = ['zk', 'core'];
