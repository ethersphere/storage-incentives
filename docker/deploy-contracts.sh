#!/usr/bin/env sh

set -x
while ! curl -m 1 http://geth-swap:8545; do sleep 1; done
echo connected to geth >&2
sleep 2

npx hardhat deploy --network localcluster

cd ./s3
npx hardhat deploy --network localcluster

echo deployed
