package main

import (
	"fmt"

	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr/mimc"
)

// vectors prints MiMC(1, 2, 3) of gnark-crypto, for the Rust test `mimc_matches_gnark`.
func vectors() {
	h := mimc.NewHasher()
	for _, v := range []uint64{1, 2, 3} {
		var e fr.Element
		e.SetUint64(v)
		h.WriteElement(e)
	}
	d := h.SumDigest()
	fmt.Println(d.String())
}
