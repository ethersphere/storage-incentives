## Steps to run the scripts

### 1. Connect to VPN

### 2. Change URL config in hardhat.config.ts for localcluster (dont commit)

```
   localcluster: {
     url: 'http://geth-swap.{NAMESPACE}.testnet.internal',
     chainId: 12345,
     deploy: ['deploy/local/'],
   },
```

### 3. Install modules and run scripts

```
yarn install
npx hardhat run scripts/cluster/changePrice.ts --network localcluster
```

### 4. Change script to match other contract that you might need to use

```
const redis = await ethers.getContractAt('Redistribution', currentRedis);
const curentPhase = await redis.currentPhaseClaim()
console.log('Curent redistribution phase ', curentPhase)
...
```
