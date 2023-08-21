## Echidna tests

Installation either with homebrew of docker, more info here
https://github.com/crytic/echidna
For docker installs need to setup node like here https://github.com/crytic/echidna/issues/1106

Calling test works with this command

echidna . --contract TestStakeRegistry --test-limit 5000 --config test.yaml

### Test with local node and deployments

Run following commands, more info on link below

ECHIDNA_RPC_URL=http://127.0.0.1:8545/ echidna . --contract TestPriceOracle --test-limit 500

https://github.com/crytic/building-secure-contracts/blob/master/program-analysis/echidna/advanced/state-network-forking.md
