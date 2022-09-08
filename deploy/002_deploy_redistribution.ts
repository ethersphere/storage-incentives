import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, get, read, execute } = deployments;
  const { deployer } = await getNamedAccounts();

  await deploy('Redistribution', {
    from: deployer,
    args: [],
    log: true,
  });

  const redistributorRole = await read('PostageStamp', 'REDISTRIBUTOR_ROLE');
  await execute(
    'PostageStamp',
    { from: deployer },
    'grantRole',
    redistributorRole,
    (await get('Redistribution')).address
  );
};

export default func;
