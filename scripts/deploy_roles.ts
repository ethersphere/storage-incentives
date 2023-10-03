import 'hardhat-deploy-ethers';
import '@nomiclabs/hardhat-etherscan';
import { ethers, network } from 'hardhat';
import hre from 'hardhat';

async function main() {
  // Order of contracts and how should they be deployed, testnet addresses
  const currentPostage = '0xF5147D56502C80004f91FB4112d6812CddE8eDE3';
  const currentOracle = '0xd41A47fCaa67945A11a398F00D5f7F130aF03733';
  const currentStaking = '0xCb07bf0603da228C8ec602bf12b973b8A94f9bac'; // old staking
  const currentRedis = '0x264079eeF0CE42D790e3FA7DF8D0cfA675ef6504';

  // Change roles on current stamp contract
  const stamp = await ethers.getContractAt('PostageStamp', currentPostage);
  const redistributorRole = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('REDISTRIBUTOR_ROLE'));
  const tx = await stamp.grantRole(redistributorRole, currentRedis);
  console.log('Changed REDISTRIBUTOR ROLE at : ', tx.hash);

  const oracleRole = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('PRICE_ORACLE_ROLE'));
  const tx2 = await stamp.grantRole(oracleRole, currentOracle);
  console.log('Changed ORACLE ROLE at : ', tx2.hash);

  // Change roles on current oracle contract
  const oracle = await ethers.getContractAt('PriceOracle', currentOracle);
  const updaterRole = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('PRICE_UPDATER_ROLE'));
  const tx3 = await oracle.grantRole(updaterRole, currentRedis);
  console.log('Changed UPDATER ROLE at : ', tx3.hash);

  // Change roles on current staking contract
  const stake = await ethers.getContractAt('StakeRegistry', currentStaking);
  const tx4 = await stake.grantRole(redistributorRole, currentRedis);
  console.log('Changed REDISTRIBUTOR ROLE at : ', tx4.hash);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
