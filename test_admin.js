const { ethers } = require('ethers');

async function checkAdmin() {
  const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
  
  // PostageStamp contract
  const postageStampAddress = '0x45a1502382541Cd610CC9068e88727426b696293';
  const postageStampAbi = [
    'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',
    'function hasRole(bytes32 role, address account) view returns (bool)',
    'function getRoleMemberCount(bytes32 role) view returns (uint256)',
    'function getRoleMember(bytes32 role, uint256 index) view returns (address)'
  ];
  
  const contract = new ethers.Contract(postageStampAddress, postageStampAbi, provider);
  
  try {
    const defaultAdminRole = await contract.DEFAULT_ADMIN_ROLE();
    console.log('DEFAULT_ADMIN_ROLE:', defaultAdminRole);
    
    const memberCount = await contract.getRoleMemberCount(defaultAdminRole);
    console.log('Admin member count:', memberCount.toString());
    
    for (let i = 0; i < memberCount.toNumber(); i++) {
      const member = await contract.getRoleMember(defaultAdminRole, i);
      console.log(`Admin member ${i}:`, member);
    }
    
    // Check our addresses
    const addresses = [
      '0xb1C7F17Ed88189Abf269Bf68A3B2Ed83C5276aAe',
      '0x647942035bb69C8e4d7EB17C8313EBC50b0bABFA',
      '0xD5C070FEb5EA883063c183eDFF10BA6836cf9816'
    ];
    
    for (const address of addresses) {
      const hasRole = await contract.hasRole(defaultAdminRole, address);
      console.log(`${address} has admin role:`, hasRole);
    }
    
  } catch (error) {
    console.error('Error:', error);
  }
}

checkAdmin(); 