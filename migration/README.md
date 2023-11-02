# Migration steps

Step 1
Clone this repo https://github.com/ethersphere/batch-migration/tree/master
and use the tool to download batches that are on Gnosis mainnet
You will need some Gnosis RPC, try with https://getblock.io/

Step 2
Use script in this folder that is stamp.sh It will use the JSON from step 1 and using HardHat task copybatch
it will create new batches on new PostageStamp contract. Just change in the script postagestamp contract address
and also which network you are using for imports

Step 3
Somewhere along the process you need to PAUSE old postageStamp contract so no new batches are created.
Also we need to expire all the batches, then add some address as redistributor and then call withdraw funds from old PostageStamp contract and add them to new PostageStamp contract
