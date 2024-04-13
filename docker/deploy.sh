#!/usr/bin/env sh

set -x

cd ./s3 && while ! curl -m 1 -H "Content-Type: application/json" --data "{\"jsonrpc\":\"2.0\",\"method\":\"net_version\",\"params\":[],\"id\":67}" http://localhost:8545; do sleep 1; done && npx hardhat deploy --network localhost &

yarn hardhat node --hostname 0.0.0.0
