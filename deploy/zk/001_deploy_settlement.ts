import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

// Verifier, GameKeyRegistry, ClaimVerifier and Settlement.
//
const func: DeployFunction = async function ({ deployments, getNamedAccounts, network, ethers }) {
  const { deploy, get, log } = deployments;
  const { deployer } = await getNamedAccounts();
  const waitConfirmations = networkConfig[network.name]?.blockConfirmations || 1;

  // ZK_VERIFIER=mock deploys Groth16MockVerifier, which accepts every proof (contract tests only).
  // Otherwise the script deploys the two verifiers that `snarkd setup` wrote (src/settlement/groth16/):
  // GameVerifier for one game circuit size (SNARK_P and SNARK_F must be its -p and -f) and
  // PostageVerifier.
  const mode = process.env.ZK_VERIFIER || 'groth16';
  let gameVerifier: string;
  let postageVerifier: string;
  if (mode === 'mock') {
    gameVerifier = (await deploy('Groth16MockVerifier', { from: deployer, log: true, waitConfirmations })).address;
    postageVerifier = gameVerifier;
  } else {
    const verifier = async (name: string) =>
      (
        await deploy(name, {
          contract: `src/settlement/groth16/${name}.sol:${name}`,
          from: deployer,
          log: true,
          waitConfirmations,
        })
      ).address;
    gameVerifier = await verifier('GameVerifier');
    postageVerifier = await verifier('PostageVerifier');
  }
  const capacity = Number(process.env.SNARK_P ?? 16);
  const forcedCapacity = Number(process.env.SNARK_F ?? 4);

  const staking = (await get('StakeRegistry')).address;
  const postage = (await get('PostageStamp')).address;
  const gameKeys = await deploy('GameKeyRegistry', { from: deployer, args: [staking], log: true, waitConfirmations });
  const claims = await deploy('ClaimVerifier', { from: deployer, log: true, waitConfirmations });

  log(`Verifiers ${gameVerifier} (game), ${postageVerifier} (postage), game circuit size ${capacity}/${forcedCapacity}`);
  await deploy('Settlement', {
    from: deployer,
    args: [
      staking,
      postage,
      (await get('PriceOracle')).address,
      gameKeys.address,
      claims.address,
      gameVerifier,
      postageVerifier,
      capacity,
      forcedCapacity,
      // VERIFIER_DELAY seconds between proposeVerifier and applyVerifier: 0 on test networks, for
      // example 604800 (7 days) on mainnet.
      Number(process.env.VERIFIER_DELAY ?? 0),
    ],
    log: true,
    waitConfirmations,
  });
};

export default func;
func.tags = ['zk', 'settlement'];
