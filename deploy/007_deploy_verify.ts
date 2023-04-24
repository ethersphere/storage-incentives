import { DeployFunction } from 'hardhat-deploy/types';
import { deployedBzzData } from '../helper-hardhat-config';
import verify from '../utils/verify';

const func: DeployFunction = async function ({ deployments, network, ethers }) {
  const { log, get } = deployments;

  if ((network.name == 'mainnet' || network.name == 'testnet') && process.env.MAINNET_ETHERSCAN_KEY) {
    // contract veryfing vars
    const token = await ethers.getContractAt(deployedBzzData[network.name].abi, deployedBzzData[network.name].address);
    const networkID = network.config.chainId as number;

    // Verify postageStamp
    const postageStamp = await get('PostageStamp');
    const argsStamp = [token.address, 16];

    log('Verifying...');
    await verify(postageStamp.address, argsStamp);
    log('----------------------------------------------------');

    // Verify oracle
    const priceOracle = await get('PriceOracle');
    const argsOracle = [postageStamp.address];

    log('Verifying...');
    await verify(priceOracle.address, argsOracle);
    log('----------------------------------------------------');

    // Verify staking
    const staking = await get('StakeRegistry');
    const argStaking = [token.address, networkID];

    log('Verifying...');
    await verify(staking.address, argStaking);
    log('----------------------------------------------------');

    // Verify redistribution
    const redistribution = await get('Redistribution');
    const argRedistribution = [staking.address, postageStamp.address, priceOracle.address];

    log('Verifying...');
    await verify(redistribution.address, argRedistribution);
    log('----------------------------------------------------');
  }
};

export default func;
func.tags = ['main', 'verify'];
