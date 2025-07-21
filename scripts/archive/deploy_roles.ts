import 'hardhat-deploy-ethers';
import '@nomiclabs/hardhat-etherscan';
import { ethers } from 'hardhat';

async function main() {
  // TESTNET
  // Order of contracts and how should they be deployed, testnet addresses
  const currentPostage = '0xf86b48B65355D292dDE7da8B4ad1913a72ad45C9';
  const currentOracle = '0x17CFdc0Ac0723ef2c9F39D4BC1FFBeD0405FffeD';
  const currentStaking = '0x484fc3388FD1083fbaF8CE12F282df11F1095Ddf';
  const currentRedis = '0x3803158ebED151c44cbd74CFa877ef28f5224eC3';

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
