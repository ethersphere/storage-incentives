import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

// Verifier + Settlement.
//
// ZK_VERIFIER=mock (default on zklocal) deploys SP1MockVerifier, which accepts empty proofs. Use it with
// SP1_PROVER=mock on the prover side to run the whole flow without generating real proofs.
// ZK_VERIFIER=<address> uses that verifier (for example SP1VerifierGroth16 deployed on anvil). Otherwise the
// SP1 Groth16 verifier gateway from helper-hardhat-config is used. With a real verifier, PROGRAM_VKEY must
// be the output of `swarm-prover vkey`.
const func: DeployFunction = async function ({ deployments, getNamedAccounts, network, ethers }) {
  const { deploy, get, log } = deployments;
  const { deployer } = await getNamedAccounts();
  const waitConfirmations = networkConfig[network.name]?.blockConfirmations || 1;

  const mode = process.env.ZK_VERIFIER || (network.name === 'zklocal' ? 'mock' : 'sp1');
  let verifier: string;
  if (ethers.utils.isAddress(mode)) {
    // An already deployed verifier, e.g. SP1VerifierGroth16 on anvil for a local run with real proofs.
    verifier = mode;
  } else if (mode === 'mock') {
    verifier = (await deploy('SP1MockVerifier', { from: deployer, log: true, waitConfirmations })).address;
  } else {
    const gateway = networkConfig[network.name]?.sp1VerifierGateway;
    if (!gateway) throw new Error(`no sp1VerifierGateway configured for ${network.name}`);
    verifier = gateway;
  }

  const vkey = process.env.PROGRAM_VKEY || (mode === 'mock' ? ethers.constants.HashZero : '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(vkey)) throw new Error('set PROGRAM_VKEY (prover/target/release/swarm-prover vkey)');

  log(`Verifier ${verifier} (${mode}), program vkey ${vkey}`);
  await deploy('Settlement', {
    from: deployer,
    args: [
      (await get('StakeRegistry')).address,
      (await get('PostageStamp')).address,
      (await get('PriceOracle')).address,
      verifier,
      vkey,
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
