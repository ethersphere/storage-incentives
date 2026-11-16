import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

// Verifier, GameKeyRegistry, ClaimVerifier and Settlement.
//
const func: DeployFunction = async function ({ deployments, getNamedAccounts, network, ethers }) {
  const { deploy, get, log } = deployments;
  const { deployer } = await getNamedAccounts();
  const waitConfirmations = networkConfig[network.name]?.blockConfirmations || 1;

  // SNARK_VERIFIER=mock deploys Groth16MockVerifier, which accepts every proof (contract tests only).
  // Otherwise the script deploys the verifiers that `snarkd setup` wrote (src/settlement/groth16/):
  // GameVerifier<P> for each game circuit size (SNARK_P and SNARK_P2: the number of slots).
  const mode = process.env.SNARK_VERIFIER || 'groth16';
  let gameVerifier: string;
  if (mode === 'mock') {
    gameVerifier = (await deploy('Groth16MockVerifier', { from: deployer, log: true, waitConfirmations })).address;
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
    gameVerifier = await verifier(`GameVerifier${process.env.SNARK_P ?? 16}`);
  }
  const capacity = Number(process.env.SNARK_P ?? 16);

  const staking = (await get('StakeRegistry')).address;
  const postage = (await get('PostageStamp')).address;
  const gameKeys = await deploy('GameKeyRegistry', { from: deployer, args: [staking], log: true, waitConfirmations });
  const claims = await deploy('ClaimVerifier', { from: deployer, log: true, waitConfirmations });

  log(`Game verifier ${gameVerifier}, circuit size ${capacity} slots`);
  const settlement = await deploy('Settlement', {
    from: deployer,
    args: [
      staking,
      postage,
      (await get('PriceOracle')).address,
      gameKeys.address,
      claims.address,
      gameVerifier,
      capacity,
      // VERIFIER_DELAY seconds between proposeVerifier and applyVerifier: 0 on test networks, for
      // example 604800 (7 days) on mainnet.
      Number(process.env.VERIFIER_DELAY ?? 0),
    ],
    log: true,
    waitConfirmations,
  });

  // A second, smaller game circuit (SNARK_P2): a small round then uses a verifier with fewer
  // public inputs. With VERIFIER_DELAY = 0 the change applies at once.
  const p2 = Number(process.env.SNARK_P2 ?? 8);
  if (mode !== 'mock' && p2 > 0 && settlement.newlyDeployed) {
    const small = await deploy(`GameVerifier${p2}`, {
      contract: `src/settlement/groth16/GameVerifier${p2}.sol:GameVerifier${p2}`,
      from: deployer,
      log: true,
      waitConfirmations,
    });
    await deployments.execute('Settlement', { from: deployer, log: true }, 'proposeVerifier', 1, small.address, p2);
    await deployments.execute('Settlement', { from: deployer, log: true }, 'applyVerifier');
  }
};

export default func;
func.tags = ['snark', 'settlement'];
