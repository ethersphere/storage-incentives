import { DeployFunction } from 'hardhat-deploy/types';
import { networkConfig } from '../../helper-hardhat-config';
import { ethers } from 'hardhat';

const func: DeployFunction = async function ({ deployments, getNamedAccounts, network }) {
  const { execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  if (network.name == 'mainnet') {
    log('Deploy multisig to all contracts');

    const multisig = networkConfig['mainnet'].multisig;
    const adminRole = '0x0000000000000000000000000000000000000000000000000000000000000000';

    // Hand DEFAULT_ADMIN_ROLE on every protocol contract to the multisig.
    await execute('PostageStamp', { from: deployer }, 'grantRole', adminRole, multisig);
    await execute('PriceOracle', { from: deployer }, 'grantRole', adminRole, multisig);
    await execute('StakeRegistry', { from: deployer }, 'grantRole', adminRole, multisig);
    await execute('Redistribution', { from: deployer }, 'grantRole', adminRole, multisig);

    // Hand all VersionedRegistryRouter roles to the multisig. Granting only the
    // admin role would leave the deployer EOA permanently in possession of
    // REGISTRAR / DEPRECATOR / ROUTER_ADMIN, which is the entire point of the
    // multisig handover.
    const registrarRole = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('REGISTRAR_ROLE'));
    const deprecatorRole = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('DEPRECATOR_ROLE'));
    const routerAdminRole = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('ROUTER_ADMIN_ROLE'));

    await execute('VersionedRegistryRouter', { from: deployer }, 'grantRole', adminRole, multisig);
    await execute('VersionedRegistryRouter', { from: deployer }, 'grantRole', registrarRole, multisig);
    await execute('VersionedRegistryRouter', { from: deployer }, 'grantRole', deprecatorRole, multisig);
    await execute('VersionedRegistryRouter', { from: deployer }, 'grantRole', routerAdminRole, multisig);

    // Revoke every role from the deployer so the multisig is the sole authority.
    // Order matters: revoke the privileged roles first, DEFAULT_ADMIN_ROLE last,
    // otherwise the deployer would lose the ability to revoke its own roles.
    await execute('VersionedRegistryRouter', { from: deployer }, 'renounceRole', registrarRole, deployer);
    await execute('VersionedRegistryRouter', { from: deployer }, 'renounceRole', deprecatorRole, deployer);
    await execute('VersionedRegistryRouter', { from: deployer }, 'renounceRole', routerAdminRole, deployer);
    await execute('VersionedRegistryRouter', { from: deployer }, 'renounceRole', adminRole, deployer);

    log('----------------------------------------------------');
  }
};

export default func;
func.tags = ['multisig', 'roles'];
