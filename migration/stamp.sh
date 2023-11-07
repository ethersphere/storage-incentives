# This bash is used on data gathered from this script here https://github.com/ethersphere/batch-migration/tree/master
# Using task defined in hardhat config, set PostageStamp contract that will be used in that config
postagecontract="0x7c89b0ac426ca28c4718ac96b5982052fbf8a3b6"

for row in $(cat ./migration/batches.json | jq -c '.batches[]'); do
    _field() {
        echo ${1} | jq -r ${2}
    }
    owner=$(_field $row ".owner")
    balance=$(_field $row ".remainingBalance")
    depth=$(_field $row ".depth")
    bucketdepth=$(_field $row ".bucketDepth")
    batchid=$(_field $row ".batchid")
    immutable=$(_field $row ".immutable")

    echo "Batch balance #####"
    echo ${balance}

    cmd="npx hardhat --network tenderly copy --owner ${owner} --initialbalance ${balance}  --depth ${depth} --bucketdepth ${bucketdepth}  --batchid ${batchid}  --immutable ${immutable} --contract ${postagecontract}"
    $cmd
    [ $? -eq 0 ] && echo "${batchid} migration successful" || echo "${batchid} migration failure"
done
