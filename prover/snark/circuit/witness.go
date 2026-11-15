package circuit

import (
	"encoding/json"
	"fmt"
	"math/big"
)

// WitnessJSON is the output of the Rust reference (`game_witness_json`): every input of the game
// circuit as a decimal string, padded to the capacity.
type WitnessJSON struct {
	Kind string `json:"kind"`
	Caps struct {
		P, F int
	} `json:"caps"`
	Public []string `json:"public"`

	G             []string   `json:"g"`
	Seed          string     `json:"seed"`
	Anchor64      string     `json:"anchor64"`
	Commits       [][]string `json:"commits"`
	ForcedCommits [][]string `json:"forcedCommits"`
	Stakes        [][]string `json:"stakes"`
	Reveals       [][]string `json:"reveals"`
	ForcedReveals [][]string `json:"forcedReveals"`
}

func num(s string) V {
	n, ok := new(big.Int).SetString(s, 10)
	if !ok {
		panic("not a number: " + s)
	}
	return n
}

func reveal(a []string) Reveal {
	return Reveal{num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5]), num(a[6])}
}

// Assignment builds the circuit assignment from the JSON witness.
func Assignment(data []byte) (*GameCircuit, Caps, error) {
	var w WitnessJSON
	if err := json.Unmarshal(data, &w); err != nil {
		return nil, Caps{}, err
	}
	caps := Caps{w.Caps.P, w.Caps.F}
	if len(w.G) != gLen || len(w.Commits) != caps.P || len(w.ForcedCommits) != caps.F ||
		len(w.Stakes) != caps.P+caps.F || len(w.Reveals) != caps.P || len(w.ForcedReveals) != caps.F ||
		len(w.Public) != GamePublic+caps.P+caps.F {
		return nil, caps, fmt.Errorf("witness does not match its capacity")
	}
	c := NewGame(caps)
	for i := range c.Pub {
		c.Pub[i] = num(w.Public[i])
	}
	for i := range c.G {
		c.G[i] = num(w.G[i])
	}
	c.Seed, c.Anchor64 = num(w.Seed), num(w.Anchor64)
	for i, a := range w.Commits {
		c.Commits[i] = Commit{num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4])}
	}
	for i, a := range w.ForcedCommits {
		c.Forced[i] = FCommit{num(a[0]), num(a[1])}
	}
	for i, a := range w.Stakes {
		c.Stakes[i] = Stake{num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5]), num(a[6]), num(a[7])}
	}
	for i, a := range w.Reveals {
		c.Reveals[i] = reveal(a)
	}
	for i, a := range w.ForcedReveals {
		c.ForcedReveals[i] = reveal(a)
	}
	return c, caps, nil
}
