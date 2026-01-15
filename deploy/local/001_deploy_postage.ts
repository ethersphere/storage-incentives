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

  // Step 1: Deploy PostageStampStorage (truly immutable)
  log('--- Deploying PostageStampStorage ---');

  const storageDeployment = await deploy('PostageStampStorage', {
    from: deployer,
    args: [
      token.address, // BZZ token address
      deployer, // Admin who can grant/revoke WRITER_ROLE
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

  // Step 3: Grant WRITER_ROLE to the logic contract
  log('--- Granting WRITER_ROLE to Logic Contract ---');

  const WRITER_ROLE = await read('PostageStampStorage', 'WRITER_ROLE');
  const hasRole = await read('PostageStampStorage', 'hasRole', WRITER_ROLE, logicDeployment.address);

  if (!hasRole) {
    await execute(
      'PostageStampStorage',
      { from: deployer, log: true },
      'grantRole',
      WRITER_ROLE,
      logicDeployment.address
    );
    log('WRITER_ROLE granted to:', logicDeployment.address);
  } else {
    log('Logic contract already has WRITER_ROLE');
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
