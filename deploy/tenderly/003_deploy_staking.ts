import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network, ethers }) {
  const { deploy, log, get, read } = deployments;
  const { deployer } = await getNamedAccounts();
  const swarmNetworkID = networkConfig[network.name]?.swarmNetworkId;
  const token = await get('Token');
  let staking = null;

  if (!(staking = await get('StakeRegistry'))) {
  } else {
    // Add missing role for Staking so deployer can set roles to new contracts
    // On Tenderly we can set any FROM it will work

    // Transaction details
    const tx = {
      to: staking.address,
      from: networkConfig[network.name].multisig,
      data: '0x2f2ff15d0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000b1c7f17ed88189abf269bf68a3b2ed83c5276aae',
      gasLimit: ethers.utils.hexlify(210000), // Or a higher limit if it's a contract interaction
      gasPrice: ethers.utils.hexlify(ethers.utils.parseUnits('10', 'gwei')), // Gas price in gwei
    };

    console.log(tx);
    const [deployerAcc] = await ethers.getSigners();
    // Send the transaction
    try {
      //const txResponse = await ethers.provider.send('eth_sendTransaction', [tx]);

      const txResponse = await deployerAcc.sendTransaction(tx);
      console.log('Transaction Hash:', txResponse);
    } catch (error) {
      console.error('Error sending transaction:', error);
    }
    log('Using already deployed Staking at', staking.address);
  }

  log('----------------------------------------------------');
};

export default func;
func.tags = ['staking', 'contracts'];
