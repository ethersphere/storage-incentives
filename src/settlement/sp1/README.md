# SP1 verifier (vendored)

These files are copied without changes from
[succinctlabs/sp1-contracts](https://github.com/succinctlabs/sp1-contracts) (MIT license):

- `ISP1Verifier.sol`
- `v6.1.0/SP1VerifierGroth16.sol`
- `v6.1.0/Groth16Verifier.sol`

The tests use them to check real proofs (`test/SP1Verifier.test.ts`). They need solc 0.8.20, which
`hardhat.config.ts` sets for these files only. The deployments do not use them: on Sepolia and mainnet,
Settlement uses the SP1 verifier gateway that Succinct deploys.
