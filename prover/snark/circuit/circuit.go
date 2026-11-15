package circuit

import (
	"math/big"
)

const (
	// ListDepth is the depth of the anchored commit and reveal lists.
	ListDepth = 8
	// DrawBits is the size of a random draw.
	DrawBits = 80
	// StakeBits bounds a stake amount.
	StakeBits = 96
	// RoundLength is Settlement.ROUND_LENGTH.
	RoundLength = 64
	// GamePublic is the number of public inputs of the game circuit before the stake commitments.
	GamePublic = 12
)

// Caps is the size of the game circuit: P anchored commits and reveals, F forced commits and reveals.
// P must be a power of two.
type Caps struct{ P, F int }

type Commit struct{ Owner, Obf, Rx, Ry, S V }
type FCommit struct{ Owner, Obf V }
type Stake struct{ OvHi, OvLo, Committed, Potential, Height, LastUpdated, KeyX, KeyY V }
type Reveal struct{ OvHi, OvLo, Depth, HHi, HLo, NHi, NLo V }

func commitDomain() *big.Int { return new(big.Int).SetBytes([]byte("SwarmCommit")) }

func shl(n uint) *big.Int { return new(big.Int).Lsh(big.NewInt(1), n) }
