import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { deploy, log, get, execute, read } = deployments;
  const { deployer } = await getNamedAccounts();

  log('----------------------------------------------------');
  log('Deploying PostageStamp Storage Decoupling Architecture');
  log('Deployer address at ', deployer);
  log('----------------------------------------------------');

  const token = await get('TestToken');
  log('BZZ Token:', token.address);

  const minimumBucketDepth = 16;
  const minimumValidityBlocks = networkConfig[network.name]?.minimumValidityBlocks || 17280;

  // Step 1: Deploy PostageStampStorage
  log('--- Deploying PostageStampStorage ---');

  const tempLogicAddress = deployer; // Temporary, will be updated

  const storageDeployment = await deploy('PostageStampStorage', {
    from: deployer,
    args: [
      token.address,
      tempLogicAddress, // Temporary logic contract address
      deployer, // Admin who can update logic contract
    ],
    log: true,
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 1,
  });

  log('PostageStampStorage deployed at:', storageDeployment.address);

  // Step 2: Deploy PostageStamp (logic contract) - use fully qualified name
  log('--- Deploying PostageStamp (logic) ---');

  const logicDeployment = await deploy('PostageStamp', {
    from: deployer,
    contract: 'src/PostageStamp.sol:PostageStamp', // Fully qualified name
    args: [storageDeployment.address, minimumBucketDepth, minimumValidityBlocks],
    log: true,
    waitConfirmations: networkConfig[network.name]?.blockConfirmations || 1,
  });

  log('PostageStamp deployed at:', logicDeployment.address);

  // Step 3: Update storage contract to point to the real logic contract
  log('--- Updating Logic Contract Address in Storage ---');

  const currentLogicAddress = await read('PostageStampStorage', 'logicContract');

  if (currentLogicAddress.toLowerCase() !== logicDeployment.address.toLowerCase()) {
    await execute('PostageStampStorage', { from: deployer, log: true }, 'updateLogicContract', logicDeployment.address);
    log('Logic contract updated to:', logicDeployment.address);
  } else {
    log('Logic contract already set correctly');
  }

  log('----------------------------------------------------');
  log('PostageStamp Storage Decoupling Deployment Complete');
  log('PostageStampStorage:', storageDeployment.address);
  log('PostageStamp:', logicDeployment.address);
  log('----------------------------------------------------');
};

export default func;
func.tags = ['postageStamp', 'contracts'];
func.dependencies = ['TestToken'];
