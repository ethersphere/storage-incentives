# This bash is used on data gathered from this script here https://github.com/ethersphere/batch-migration/tree/master
# Using task defined in hardhat config, set PostageStamp contract that will be used in that config


for row in $(cat ./private_testnet_batches.json | jq -c '.batches[]'); do
    _field() {
        echo ${1} | jq -r ${2}
    }
    owner=$(_field $row ".owner")
    balance=$(_field $row ".remainingBalance")
    depth=$(_field $row ".depth")
    bucketDepth=16
    batchid=$(_field $row ".batchid")
    immutable=$(_field $row ".immutable")

    echo "current balance #####"
    echo ${balance}

    cmd="npx hardhat --network testnet copy --owner ${owner} --initialbalance ${balance}  --depth ${depth} --bucketDepth ${bucketDepth}  --batchid ${batchid}  --immutable ${immutable}"
    $cmd
    [ $? -eq 0 ] && echo "${batchid} migration successful" || echo "${batchid} migration failure"
done
