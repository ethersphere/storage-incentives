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
