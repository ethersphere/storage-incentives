import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

// Verifier, GameKeyRegistry, ClaimVerifier and Settlement.
//
const func: DeployFunction = async function ({ deployments, getNamedAccounts, network, ethers }) {
  const { deploy, get, log } = deployments;
  const { deployer } = await getNamedAccounts();
  const waitConfirmations = networkConfig[network.name]?.blockConfirmations || 1;

  // ZK_VERIFIER=mock deploys Groth16MockVerifier, which accepts every proof (contract tests only).
  // ZK_VERIFIER=<address> uses that verifier. Otherwise the script deploys src/settlement/groth16/Verifier.sol:
  // the verifier that `snarkd setup` wrote for one circuit size and one setup. SNARK_P and SNARK_F must
  // be the -p and -f of that setup.
  const mode = process.env.ZK_VERIFIER || 'groth16';
  let verifier: string;
  if (ethers.utils.isAddress(mode)) {
    verifier = mode;
  } else if (mode === 'mock') {
    verifier = (await deploy('Groth16MockVerifier', { from: deployer, log: true, waitConfirmations })).address;
  } else {
    verifier = (
      await deploy('Verifier', {
        contract: 'src/settlement/groth16/Verifier.sol:Verifier',
        from: deployer,
        log: true,
        waitConfirmations,
      })
    ).address;
  }
  const capacity = Number(process.env.SNARK_P ?? 16);
  const forcedCapacity = Number(process.env.SNARK_F ?? 4);

  const staking = (await get('StakeRegistry')).address;
  const postage = (await get('PostageStamp')).address;
  const gameKeys = await deploy('GameKeyRegistry', { from: deployer, args: [staking], log: true, waitConfirmations });
  const claims = await deploy('ClaimVerifier', { from: deployer, log: true, waitConfirmations });

  log(`Verifier ${verifier} (${mode}), circuit size ${capacity}/${forcedCapacity}`);
  await deploy('Settlement', {
    from: deployer,
    args: [
      staking,
      postage,
      (await get('PriceOracle')).address,
      gameKeys.address,
      claims.address,
      verifier,
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
