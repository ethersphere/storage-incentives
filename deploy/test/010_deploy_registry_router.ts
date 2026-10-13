import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';
import { ethers } from 'hardhat';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, get, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  const proxyAdmin = await get('DefaultProxyAdmin');

  await deploy('VersionedRegistryRouter', {
    from: deployer,
    args: [proxyAdmin.address],
    log: true,
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 6,
  });

  const contractNames = ['PostageStamp', 'PriceOracle', 'StakeRegistry', 'Redistribution'];

  for (const name of contractNames) {
    const proxyId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(name));
    const proxy = await get(name);
    log(`Registering proxy ${name} (${proxy.address})`);
    await execute('VersionedRegistryRouter', { from: deployer }, 'registerProxy', proxyId, proxy.address);
  }

  for (const name of contractNames) {
    const proxy = await get(name);
    const implAddress = await ethers
      .getContractAt('ProxyAdmin', proxyAdmin.address)
      .then((pa) => pa.getProxyImplementation(proxy.address));

    const codehash = ethers.utils.keccak256(await ethers.provider.getCode(implAddress));
    const versionId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`${name}@1.0.0`));

    log(`Registering release ${name}@1.0.0 (impl=${implAddress})`);
    await execute(
      'VersionedRegistryRouter',
      { from: deployer },
      'registerRelease',
      versionId,
      `${name}@1.0.0`,
      implAddress,
      codehash
    );
  }

  log('----------------------------------------------------');
};

export default func;
func.tags = ['registry', 'contracts'];
func.dependencies = ['postageStamp', 'priceOracle', 'staking', 'redistribution'];
