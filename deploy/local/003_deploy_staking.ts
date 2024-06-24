import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network, ethers }) {
  const { deploy, get, log } = deployments;
  const { deployer } = await getNamedAccounts();
  const swarmNetworkID = networkConfig[network.name]?.swarmNetworkId;

  const token = await get('TestToken');
  const oracleAddress = (await get('PriceOracle')).address;

  const args = [token.address, swarmNetworkID, oracleAddress];
  await deploy('StakeRegistry', {
    from: deployer,
    args: args,
    log: true,
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 1,
  });

  log('----------------------------------------------------');
};

export default func;
func.tags = ['staking', 'contracts'];
