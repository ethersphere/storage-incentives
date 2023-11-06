# Migration steps

Step 1
Clone this repo https://github.com/ethersphere/batch-migration/tree/master
and use the tool to download batches that are on Gnosis mainnet
You will need some Gnosis RPC, try with https://getblock.io/

Step 2
Use script stamp.sh in this folder. It will use the JSON from step 1 and using HardHat task copybatch
it will create new batches on new PostageStamp contract. Just change in the script postagestamp contract address
and also which network you are using for imports.

Step 3
Somewhere along the process you need to PAUSE old postageStamp contract so no new batches are created.
To withdraw all the funds we first need to add the address doing this as redistributor to stamp contract.
Then we need to raise price to very high amount, after it call expireLimited so in that way all the batches are expired
and all the funds go into the pot. After that we go and withdraw funds to new postageStamp contract.
