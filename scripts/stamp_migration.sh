postagecontract="0x822828dC7978ed03fd793B36E7a0cb9bce7e2048"
tokenaddress="0x2ac3c1d3e24b45c6c310534bc2dd84b5ed576335"

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