package circuit

import (
	"math/big"

	"github.com/consensys/gnark/std/math/uints"
)

const (
	// TreeDepth is the depth of the postage batch tree.
	TreeDepth = 24
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
	// PostagePublic is the number of public inputs of the postage circuit.
	PostagePublic = 9
)

// Caps is the size of the circuits. Game: P anchored commits and reveals, F forced commits and
// reveals (P must be a power of two). Postage: E events and X batch expiries.
type Caps struct{ P, F, E, X int }

type Commit struct{ Owner, Obf, Rx, Ry, S V }
type FCommit struct{ Owner, Obf V }
type Stake struct{ OvHi, OvLo, Committed, Potential, Height, LastUpdated, KeyX, KeyY V }
type Reveal struct{ OvHi, OvLo, Depth, HHi, HLo, NHi, NLo V }

// Write is one leaf of the batch tree before a write, with its path.
type Write struct {
	Index V
	Leaf  [6]V // idHi, idLo, depth, balance, nextIndex, nextBalance
	Sibs  [TreeDepth]V
}
type Event struct {
	E [6]V // kind, idHi, idLo, depth, value, block
	W [3]Write
}
type Expiry struct{ Head, Target Write }

func commitDomain() *big.Int { return new(big.Int).SetBytes([]byte("SwarmCommit")) }

func shl(n uint) *big.Int { return new(big.Int).Lsh(big.NewInt(1), n) }

var _ = uints.NewU8
