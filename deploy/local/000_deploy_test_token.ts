import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, ethers }) {
  const { deploy, log, execute } = deployments;
  const { deployer } = await getNamedAccounts();

  let token = null;

  const argsToken = ['TEST', 'TST', '1249989122910552325012092'];

  const bzzAccounts = ['0xbf4f9637c281ddfb1fbd3be5a1dae6531d408f11', '0xc45d64d8f9642a604db93c59fd38492b262391ca'];

  token = await deploy('TestToken', {
    from: deployer,
    args: argsToken,
    log: true,
  });

  // Transfer tokens to accounts used in cluster deployment
  const amount = ethers.utils.parseUnits('10', 18); // "10" is the token amount; adjust the decimal accordingly
  await execute('TestToken', { from: deployer }, 'transfer', bzzAccounts[0], amount);
  await execute('TestToken', { from: deployer }, 'transfer', bzzAccounts[1], amount);

  log('----------------------------------------------------');
};

export default func;
func.tags = ['testToken', 'contracts'];
