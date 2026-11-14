package circuit

import (
	"encoding/json"
	"fmt"
	"math/big"
)

// WitnessJSON is the output of `witness_json` of the Rust reference: every circuit input as a decimal
// string, padded to the capacity.
type WitnessJSON struct {
	Caps struct {
		P, F, E, X int
	} `json:"caps"`
	Digest         string     `json:"digest"`
	G              []string   `json:"g"`
	Commits        [][]string `json:"commits"`
	ForcedCommits  [][]string `json:"forcedCommits"`
	Stakes         [][]string `json:"stakes"`
	Reveals        [][]string `json:"reveals"`
	ForcedReveals  [][]string `json:"forcedReveals"`
	Header         []string   `json:"header"`
	PrevEventIndex string     `json:"prevEventIndex"`
	PrevEventHash  []string   `json:"prevEventHash"`
	CutBlock       string     `json:"cutBlock"`
	Events         []struct {
		E []string   `json:"e"`
		W [][]string `json:"w"`
	} `json:"events"`
	Expiries []struct {
		Head   []string `json:"head"`
		Target []string `json:"target"`
	} `json:"expiries"`
	FinalHead    []string `json:"finalHead"`
	PublicValues string   `json:"publicValues"`
}

func num(s string) V {
	n, ok := new(big.Int).SetString(s, 10)
	if !ok {
		panic("not a number: " + s)
	}
	return n
}

func write(a []string) Write {
	var w Write
	w.Index = num(a[0])
	for i := range w.Leaf {
		w.Leaf[i] = num(a[1+i])
	}
	for i := range w.Sibs {
		w.Sibs[i] = num(a[7+i])
	}
	return w
}

func reveal(a []string) Reveal {
	return Reveal{num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5]), num(a[6])}
}

// Assignment builds the circuit assignment from the JSON witness.
func Assignment(data []byte) (*Circuit, Caps, error) {
	var w WitnessJSON
	if err := json.Unmarshal(data, &w); err != nil {
		return nil, Caps{}, err
	}
	caps := Caps{w.Caps.P, w.Caps.F, w.Caps.E, w.Caps.X}
	if len(w.G) != gLen || len(w.Commits) != caps.P || len(w.ForcedCommits) != caps.F ||
		len(w.Stakes) != caps.P+caps.F || len(w.Reveals) != caps.P || len(w.ForcedReveals) != caps.F ||
		len(w.Events) != caps.E || len(w.Expiries) != caps.X || len(w.Header) != 7 {
		return nil, caps, fmt.Errorf("witness does not match its capacity")
	}
	c := New(caps)
	c.Digest = num(w.Digest)
	for i := range c.G {
		c.G[i] = num(w.G[i])
	}
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
	for i := range c.Header {
		c.Header[i] = num(w.Header[i])
	}
	c.PrevEventIndex = num(w.PrevEventIndex)
	c.PrevEventHash = [2]V{num(w.PrevEventHash[0]), num(w.PrevEventHash[1])}
	c.CutBlock = num(w.CutBlock)
	for i, e := range w.Events {
		for j := range c.Events[i].E {
			c.Events[i].E[j] = num(e.E[j])
		}
		for j := range c.Events[i].W {
			c.Events[i].W[j] = write(e.W[j])
		}
	}
	for i, e := range w.Expiries {
		c.Expiries[i] = Expiry{write(e.Head), write(e.Target)}
	}
	c.FinalHead = write(w.FinalHead)
	return c, caps, nil
}
