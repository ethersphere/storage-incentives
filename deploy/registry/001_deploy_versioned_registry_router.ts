import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network, ethers }) {
  const { deploy, log } = deployments;
  const { deployer } = await getNamedAccounts();
  const waitConfirmations = networkConfig[network.name]?.blockConfirmations || 1;

  const proxyAdminDeploy = await deploy('ProxyAdmin', {
    from: deployer,
    log: true,
    waitConfirmations,
  });

  const sampleV1 = await deploy('SampleImplementation', {
    from: deployer,
    log: true,
    waitConfirmations,
  });

  await deploy('SampleImplementationV2', {
    from: deployer,
    log: true,
    waitConfirmations,
  });

  await deploy('SampleProxy', {
    contract: 'TransparentUpgradeableProxy',
    from: deployer,
    args: [sampleV1.address, proxyAdminDeploy.address, '0x'],
    log: true,
    waitConfirmations,
  });

  await deploy('VersionedRegistryRouter', {
    from: deployer,
    args: [proxyAdminDeploy.address],
    log: true,
    waitConfirmations,
  });

  log('----------------------------------------------------');
};

export default func;
func.tags = ['registry'];
