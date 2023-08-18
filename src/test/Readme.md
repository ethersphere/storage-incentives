## Echidna tests

Installation either with homebrew of docker, more info here
https://github.com/crytic/echidna
For docker installs need to setup node like here https://github.com/crytic/echidna/issues/1106

Calling test works with this command

echidna . --contract TestStakeRegistry --test-limit 5000 --config test.yaml
