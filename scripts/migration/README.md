# Migration steps

### Step 1

Clone this repo https://github.com/ethersphere/batch-migration/tree/master and use the tool to download batches that are on Gnosis mainnet
We will need some Gnosis RPC, try with https://getblock.io/ or https://www.chainnodes.org/

Some notes, one year will have somewhere around 5.5M blocks, line below should be run to get output. Should take around 25 minutes.
It's not stuck if it doesnt move in the end, just wait for it.

`make binary && dist/batchpull --stamp-address 0x30d155478eF27Ab32A1D578BE7b84BC5988aF381 --rpc-endpoint https://go.getblock.io/f1147e377b1c4022a7462499e9258f27 --sleep '0.0001s' --block-start 25527076 --output "batches.json" `

### Step 2

Before we start the process we need to PAUSE old postageStamp contract so no new batches are created.
We also need to PAUSE the old redistribution conract so the game is not played.
To withdraw all the funds we first need to add the address that will call the withdraw as redistributor on old postageStamp contract.
Then we need to raise price to very high amount, after it, call expireLimited so in that way all the batches are expired
and all the funds go into the pot.
When all this is done we go and withdraw funds to new postageStamp contract.

### Step 3 - Legacy

Use script import.sh in this folder. It will use the JSON from step 1 and using HardHat task copybatch
it will create new batches on new PostageStamp contract. BEFORE doing that we MUST change in the script postagestamp contract address
to currently active one and also which network we are using for imports.

`./migration.sh `

### Step 3 - Recommended

Use TS script in this folder that is called import.ts, it will plug in into hardhat framework and use network you passed it to
So what you should be calling is, also set the contract name and batch size in the script

`hardhat run scripts/migration/import.ts --network mainnet `
