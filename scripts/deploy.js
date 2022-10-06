require('hardhat/types');
require('hardhat-deploy');

async function main() {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, execute, read } = deployments;

  const [deployer] = await ethers.getSigners();

  console.log('Deploying contracts with the account:', deployer.address);

  console.log('Account balance:', (await deployer.getBalance()).toString());

  const StakeRegistry = await ethers.getContractFactory('StakeRegistry');
  const token = await deploy('StakeRegistry', {
    from: deployer.address,
    args: ['0x2ac3c1d3e24b45c6c310534bc2dd84b5ed576335', 10],
    log: true,
  });

  console.log('Stake registry address:', token.address);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
