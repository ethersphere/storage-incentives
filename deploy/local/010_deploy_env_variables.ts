import { DeployFunction } from 'hardhat-deploy/types';
import fs from 'fs';
import path from 'path';

const func: DeployFunction = async function ({ deployments }) {
  const { get, log } = deployments;

  const Token = await get('TestToken');
  const StakeRegistry = await get('StakeRegistry');
  const PostageStamp = await get('PostageStamp');
  const PriceOracle = await get('PriceOracle');
  const Redistribution = await get('Redistribution');

  // Generate content for the environment file
  let content: string = '';
  content += `export BEE_TOKEN_ADDRESS=${Token.address}\n`;
  content += `export BEE_POSTAGE_STAMP_ADDRESS=${PostageStamp.address}\n`;
  content += `export BEE_INCENTIVES_PRICE_ORACLE_ADDRESS=${PriceOracle.address}\n`;
  content += `export BEE_STAKING_ADDRESS=${StakeRegistry.address}\n`;
  content += `export BEE_REDISTRIBUTION_ADDRESS=${Redistribution.address}\n`;

  const envFilePath: string = path.join(__dirname, 'deployedContracts.sh');

  // Write the content to the file
  fs.writeFileSync(envFilePath, content, { flag: 'a' });
  console.log(`Exported contract addresses to ${envFilePath}`);

  log('----------------------------------------------------');
};

export default func;
func.tags = ['variables'];
