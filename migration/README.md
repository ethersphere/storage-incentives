# Migration steps

Step 1
Clone this repo https://github.com/ethersphere/batch-migration/tree/master
and use the tool to download batches that are on Gnosis mainnet
We will need some Gnosis RPC, try with https://getblock.io/

Some notes, one year will have somewhere around 5.5M blocks, line below should be run to get output

make binary && dist/batchpull --stamp-address 0x647942035bb69c8e4d7eb17c8313ebc50b0babfa --rpc-endpoint https://go.getblock.io/f1147e377b1c4022a7462499e9258f27 --sleep '0.0001s' --block-start 30321200 --output "batches.json"

Step 2
Before we start the process we need to PAUSE old postageStamp contract so no new batches are created.
We also need to PAUSE the old redistribution conract so the game is not played.
To withdraw all the funds we first need to add the address that will call the withdraw as redistributor to old postageStamp contract.
Then we need to raise price to very high amount, after it, call expireLimited so in that way all the batches are expired
and all the funds go into the pot. After that we go and withdraw funds to new postageStamp contract.

Step 3
Use script stamp.sh in this folder. It will use the JSON from step 1 and using HardHat task copybatch
it will create new batches on new PostageStamp contract. BEFORE doint that we MUST change in the script postagestamp contract address
to currently active one and also which network we are using for imports.
