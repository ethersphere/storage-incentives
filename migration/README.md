# Migration steps

Step 1
Clone this repo https://github.com/ethersphere/batch-migration/tree/master
and use the tool to download batches that are on mainnet
You will need some Gnosis RPC, try with https://getblock.io/

Step 2
Use script that is stamp_migration.sh which will use the JSON from step 1 and with HardHat task copybatch
it will create new batches on new PostageStamp contract

Step 3
Withdraw funds from old PostageStamp contract and add them to new PostageStamp contract
