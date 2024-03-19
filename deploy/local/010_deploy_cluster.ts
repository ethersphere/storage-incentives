import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, ethers }) {
  const { get, log, execute } = deployments;
  const { deployer } = await getNamedAccounts();

  // Access the BZZACCOUNTS environment variable
  const bzzAccountsRaw = process.env.BZZACCOUNTS
    ? process.env.BZZACCOUNTS
    : '0xbf4f9637c281ddfb1fbd3be5a1dae6531d408f11,0xc45d64d8f9642a604db93c59fd38492b262391ca';
  const bzzAccounts = bzzAccountsRaw.split(',');

  // Transfer tokens to accounts used in cluster deployment
  const amount = ethers.utils.parseUnits('10', 18); // "10" is the token amount; adjust the decimal accordingly
  for (const account of bzzAccounts) {
    await execute('TestToken', { from: deployer }, 'transfer', ethers.utils.getAddress(account), amount);
  }

  log(`Sent BZZ tokens to ` + bzzAccountsRaw);
  log('----------------------------------------------------');

  const Token = await get('TestToken');
  const StakeRegistry = await get('StakeRegistry');
  const PostageStamp = await get('PostageStamp');
  const PriceOracle = await get('PriceOracle');
  const Redistribution = await get('Redistribution');

  // Generate content for the environment file
  let content = '';

  content += `echo "----- USE THE COMMANDS BELOW TO SETUP YOUR TERMINALS -----" >&2\n\n`;
  content += `export BEE_TOKEN_ADDRESS=${Token.address}\n`;
  content += `export BEE_POSTAGE_STAMP_ADDRESS=${PostageStamp.address}\n`;
  content += `export BEE_INCENTIVES_PRICE_ORACLE_ADDRESS=${PriceOracle.address}\n`;
  content += `export BEE_STAKING_ADDRESS=${StakeRegistry.address}\n`;
  content += `export BEE_REDISTRIBUTION_ADDRESS=${Redistribution.address}\n`;

  // Output the content to the terminal
  log(content);
  log(`Exported contract addresses to console`);

  log('----------------------------------------------------');
};

export default func;
func.tags = ['variables'];
