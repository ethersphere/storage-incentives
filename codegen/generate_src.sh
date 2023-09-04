#!/usr/bin/env bash

# Copyright 2022 The Swarm Authors. All rights reserved.
# Use of this source code is governed by a BSD-style
# license that can be found in the LICENSE file.

# This script generates Golang constants or .env key-pairs related to smart contracts.

readonly TAG=${1}
readonly TAG_ELEMENTS=(${1//-/ })
readonly TARGET_SUFFIX="${2}"
readonly TARGET_DIR="${3}"


readonly VERSION="${TAG_ELEMENTS[0]}"
! [[ "${VERSION}" =~ ^v[0-9]+.[0-9]+.[0-9]+$ ]] && printf "malformed version: %s\n" "${VERSION}" && exit 1

readonly REVISION="${TAG_ELEMENTS[1]}"
[[ -n "${REVISION}" ]] && ! [[ "${REVISION}" =~ ^rc[0-9]+$ ]] && printf "malformed revision: %s\n" "${REVISION}" && exit 1
[[ "${REVISION}" =~ ^rc[0-9]{1,}$ ]] && readonly NETWORK="testnet" || readonly NETWORK="mainnet"

readonly DEPLOYED_ARTIFACTS="${NETWORK}_deployed.json"
[[ ! -f "${DEPLOYED_ARTIFACTS}" ]] && printf "file %s does not exist\n" "${DEPLOYED_ARTIFACTS}" && exit 1


readonly CHAIN_ID="$(jq '.chainId | select( . != null )' "${DEPLOYED_ARTIFACTS}")"
[[ -z "${CHAIN_ID}" ]] && printf "chain id number is empty\n" && exit 1

readonly NETWORK_ID="$(jq '.swarmNetworkId | select( . != null )' "${DEPLOYED_ARTIFACTS}")"
[[ -z "${NETWORK_ID}" ]] && printf "network id number is empty\n" && exit 1

readonly BZZ_TOKEN_BLOCK_NUMBER="$(jq '.contracts.bzzToken.block | select( . != null )' "${DEPLOYED_ARTIFACTS}")"
[[ -z "${BZZ_TOKEN_BLOCK_NUMBER}" ]] && printf "bzz token block number is empty\n" && exit 1
readonly BZZ_TOKEN_ADDRESS="$(jq -r '.contracts.bzzToken.address | select( . != null )' "${DEPLOYED_ARTIFACTS}")"
[[ -z "${BZZ_TOKEN_ADDRESS}" ]] && printf "bzz token address is empty\n" && exit 1
readonly BZZ_TOKEN_BYTECODE="$(jq -r '.contracts.bzzToken.bytecode | select( . != null )' "${DEPLOYED_ARTIFACTS}")"
[[ -z "${BZZ_TOKEN_BYTECODE}" ]] && printf "bzz token bytecode is empty\n" && exit 1
readonly BZZ_TOKEN_ABI="$(jq '.contracts.bzzToken.abi | select( . != null )' "${DEPLOYED_ARTIFACTS}")"
[[ -z "${BZZ_TOKEN_ABI}" ]] && printf "bzz token abi is empty\n" && exit 1

readonly STAKING_BLOCK_NUMBER="$(jq '.contracts.staking.block | select( . != null )' "${DEPLOYED_ARTIFACTS}")"
[[ -z "${STAKING_BLOCK_NUMBER}" ]] && printf "staking block number is empty\n" && exit 1
readonly STAKING_ADDRESS="$(jq -r '.contracts.staking.address | select( . != null )' "${DEPLOYED_ARTIFACTS}")"
[[ -z "${STAKING_ADDRESS}" ]] && printf "staking address is empty\n" && exit 1
readonly STAKING_BYTECODE="$(jq -r '.contracts.staking.bytecode | select( . != null )' "${DEPLOYED_ARTIFACTS}")"
[[ -z "${STAKING_BYTECODE}" ]] && printf "staking bytecode is empty\n" && exit 1
readonly STAKING_ABI="$(jq '.contracts.staking.abi | select( . != null )' "${DEPLOYED_ARTIFACTS}")"
[[ -z "${STAKING_ABI}" ]] && printf "staking abi is empty\n" && exit 1

readonly POSTAGE_BLOCK_NUMBER="$(jq '.contracts.postageStamp.block | select( . != null )' "${DEPLOYED_ARTIFACTS}")"
[[ -z "${POSTAGE_BLOCK_NUMBER}" ]] && printf "postage stamp block number is empty\n" && exit 1
readonly POSTAGE_STAMP_ADDRESS="$(jq -r '.contracts.postageStamp.address | select( . != null )' "${DEPLOYED_ARTIFACTS}")"
[[ -z "${POSTAGE_STAMP_ADDRESS}" ]] && printf "postage stamp address is empty\n" && exit 1
readonly POSTAGE_STAMP_BYTECODE="$(jq -r '.contracts.postageStamp.bytecode | select( . != null )' "${DEPLOYED_ARTIFACTS}")"
[[ -z "${POSTAGE_STAMP_BYTECODE}" ]] && printf "postage stamp bytecode is empty\n" && exit 1
readonly POSTAGE_STAMP_ABI="$(jq '.contracts.postageStamp.abi | select( . != null )' "${DEPLOYED_ARTIFACTS}")"
[[ -z "${POSTAGE_STAMP_ABI}" ]] && printf "postage stamp abi is empty\n" && exit 1

readonly PRICE_ORACLE_BLOCK_NUMBER="$(jq '.contracts.priceOracle.block | select( . != null )' "${DEPLOYED_ARTIFACTS}")"
[[ -z "${PRICE_ORACLE_BLOCK_NUMBER}" ]] && printf "price oracle block number is empty\n" && exit 1
readonly PRICE_ORACLE_ADDRESS="$(jq -r '.contracts.priceOracle.address | select( . != null )' "${DEPLOYED_ARTIFACTS}")"
[[ -z "${PRICE_ORACLE_ADDRESS}" ]] && printf "price oracle address is empty\n" && exit 1
readonly PRICE_ORACLE_BYTECODE="$(jq -r '.contracts.priceOracle.bytecode | select( . != null )' "${DEPLOYED_ARTIFACTS}")"
[[ -z "${PRICE_ORACLE_BYTECODE}" ]] && printf "price oracle bytecode is empty\n" && exit 1
readonly PRICE_ORACLE_ABI="$(jq '.contracts.priceOracle.abi | select( . != null )' "${DEPLOYED_ARTIFACTS}")"
[[ -z "${PRICE_ORACLE_ABI}" ]] && printf "price oracle abi is empty\n" && exit 1

readonly REDISTRIBUTION_BLOCK_NUMBER="$(jq '.contracts.redistribution.block | select( . != null )' "${DEPLOYED_ARTIFACTS}")"
[[ -z "${REDISTRIBUTION_BLOCK_NUMBER}" ]] && printf "redistribution block number is empty\n" && exit 1
readonly REDISTRIBUTION_ADDRESS="$(jq -r '.contracts.redistribution.address | select( . != null )' "${DEPLOYED_ARTIFACTS}")"
[[ -z "${REDISTRIBUTION_ADDRESS}" ]] && printf "redistribution address is empty\n" && exit 1
readonly REDISTRIBUTION_BYTECODE="$(jq -r '.contracts.redistribution.bytecode | select( . != null )' "${DEPLOYED_ARTIFACTS}")"
[[ -z "${REDISTRIBUTION_BYTECODE}" ]] && printf "redistribution bytecode is empty\n" && exit 1
readonly REDISTRIBUTION_ABI="$(jq '.contracts.redistribution.abi | select( . != null )' "${DEPLOYED_ARTIFACTS}")"
[[ -z "${REDISTRIBUTION_ABI}" ]] && printf "redistribution abi is empty\n" && exit 1

function write_go_file() {
  cat << EOF > "${1}"
// Copyright $(date +"%Y") The Swarm Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

// Code generated by codegen/generate_src.sh for tag: ${2}; DO NOT EDIT.
package abi

const (
	${NETWORK^}ChainID   = ${CHAIN_ID}
	${NETWORK^}NetworkID = ${NETWORK_ID}
)

const (
	${NETWORK^}BzzTokenBlockNumber = ${BZZ_TOKEN_BLOCK_NUMBER}
	${NETWORK^}BzzTokenAddress     = "${BZZ_TOKEN_ADDRESS}"
	${NETWORK^}BzzTokenBin         = "${BZZ_TOKEN_BYTECODE}"
	${NETWORK^}BzzTokenABI         = \`${BZZ_TOKEN_ABI}\`
)

const (
	${NETWORK^}StakingBlockNumber = ${STAKING_BLOCK_NUMBER}
	${NETWORK^}StakingAddress     = "${STAKING_ADDRESS}"
	${NETWORK^}StakingBin         = "${STAKING_BYTECODE}"
	${NETWORK^}StakingABI         = \`${STAKING_ABI}\`
)

const (
	${NETWORK^}PostageStampBlockNumber  = ${POSTAGE_BLOCK_NUMBER}
	${NETWORK^}PostageStampBin          = "${POSTAGE_STAMP_BYTECODE}"
	${NETWORK^}PostageStampAddress      = "${POSTAGE_STAMP_ADDRESS}"
	${NETWORK^}PostageStampABI          = \`${POSTAGE_STAMP_ABI}\`
)

const (
	${NETWORK^}PriceOracleBlockNumber = ${PRICE_ORACLE_BLOCK_NUMBER}
	${NETWORK^}PriceOracleBin         = "${PRICE_ORACLE_BYTECODE}"
	${NETWORK^}PriceOracleAddress     = "${PRICE_ORACLE_ADDRESS}"
	${NETWORK^}PriceOracleABI         = \`${PRICE_ORACLE_ABI}\`
)

const (
	${NETWORK^}RedistributionBlockNumber = ${REDISTRIBUTION_BLOCK_NUMBER}
	${NETWORK^}RedistributionBin         = "${REDISTRIBUTION_BYTECODE}"
	${NETWORK^}RedistributionAddress     = "${REDISTRIBUTION_ADDRESS}"
	${NETWORK^}RedistributionABI         = \`${REDISTRIBUTION_ABI}\`
)
EOF
}

function write_env_file() {
  cat << EOF > "${1}"
# Code generated by codegen/generate_src.sh for tag: ${2}; DO NOT EDIT.

STAKING_BYTECODE=${STAKING_BYTECODE}
POSTAGE_STAMP_BYTECODE=${POSTAGE_STAMP_BYTECODE}
INCENTIVES_PRICE_ORACLE_BYTECODE=${PRICE_ORACLE_BYTECODE}
REDISTRIBUTION_BYTECODE=${REDISTRIBUTION_BYTECODE}
EOF
}

case "${TARGET_SUFFIX}" in
  go)
    TARGET="${TARGET_DIR}/abi_${NETWORK}.${TARGET_SUFFIX}"
    write_go_file "${TARGET}" "${TAG}"
    gofmt -w "${TARGET}"
    ;;
  env)
    TARGET="${TARGET_DIR}/.abi_${NETWORK}.${TARGET_SUFFIX}"
    write_env_file "${TARGET}" "${TAG}"
    ;;
  *)
    printf "unknown target suffix: %s\n" "${TARGET_SUFFIX}" && exit 1
    ;;
esac

exit $?
