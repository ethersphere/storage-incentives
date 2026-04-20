import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';
import { ethers } from 'hardhat';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, get, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();
  const waitConfirmations = networkConfig[network.name]?.blockConfirmations || 1;

  const proxyAdmin = await get('DefaultProxyAdmin');

  log('Deploying VersionedRegistryRouter with ProxyAdmin at', proxyAdmin.address);

  await deploy('VersionedRegistryRouter', {
    from: deployer,
    args: [proxyAdmin.address],
    log: true,
    waitConfirmations,
  });

  const postageStamp = await get('PostageStamp');
  const priceOracle = await get('PriceOracle');
  const stakeRegistry = await get('StakeRegistry');
  const redistribution = await get('Redistribution');

  const proxyEntries = [
    { name: 'PostageStamp', address: postageStamp.address },
    { name: 'PriceOracle', address: priceOracle.address },
    { name: 'StakeRegistry', address: stakeRegistry.address },
    { name: 'Redistribution', address: redistribution.address },
  ];

  for (const entry of proxyEntries) {
    const proxyId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(entry.name));
    log(`Registering proxy ${entry.name} (${entry.address}) in VersionedRegistryRouter`);
    await execute(
      'VersionedRegistryRouter',
      { from: deployer },
      'registerProxy',
      proxyId,
      entry.address
    );
  }

  log('----------------------------------------------------');
};

export default func;
func.tags = ['registry', 'contracts'];
