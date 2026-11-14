// Package circuit is the Groth16 circuit of one round of the redistribution game with its postage
// accounting (docs/SNARK-SETTLEMENT.md). The Rust module prover/crates/vm/src/snark is the reference:
// it computes the same values and the witness.
package circuit

import (
	"math/big"

	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr/mimc"
	"github.com/consensys/gnark/constraint/solver"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/hash/sha2"
	"github.com/consensys/gnark/std/math/uints"
	"github.com/consensys/gnark/std/rangecheck"
)

type V = frontend.Variable

func init() {
	solver.RegisterHint(divModHint)
}

// divModHint: outputs (a / b, a % b).
func divModHint(_ *big.Int, in []*big.Int, out []*big.Int) error {
	out[0].DivMod(in[0], in[1], out[1])
	return nil
}

type ctx struct {
	api    frontend.API
	consts []big.Int
	by     *uints.Bytes
	rc     frontend.Rangechecker
}

func newCtx(api frontend.API) (*ctx, error) {
	by, err := uints.NewBytes(api)
	if err != nil {
		return nil, err
	}
	return &ctx{api: api, consts: mimc.GetConstants(), by: by, rc: rangecheck.New(api)}, nil
}

// enc is the MiMC block cipher of gnark-crypto: 110 rounds of (m + k + c)^5, then + k.
func (c *ctx) enc(k, m V) V {
	api := c.api
	for i := range c.consts {
		t := api.Add(m, k, c.consts[i])
		t2 := api.Mul(t, t)
		m = api.Mul(api.Mul(t2, t2), t)
	}
	return api.Add(m, k)
}

// compress is E_l(r) + l + r: the MiMC compression function and the node hash of the trees.
func (c *ctx) compress(l, r V) V {
	return c.api.Add(c.enc(l, r), l, r)
}

// hash is the MiMC hash of field elements (Merkle-Damgard from zero).
func (c *ctx) hash(xs ...V) V {
	var h V = 0
	for _, x := range xs {
		h = c.compress(h, x)
	}
	return h
}

// Compress is `compress` outside a circuit.
func Compress(l, r *big.Int) *big.Int {
	var a, b, d fr.Element
	a.SetBigInt(l)
	b.SetBigInt(r)
	mimc.Compressor{}.CompressField(&d, &a, &b)
	return d.BigInt(new(big.Int))
}

// bits returns the n low bits of v (least significant first) and constrains v < 2^n.
func (c *ctx) bits(v V, n int) []V {
	return c.api.ToBinary(v, n)
}

func (c *ctx) rng(v V, n int) {
	c.rc.Check(v, n)
}

func (c *ctx) not(a V) V { return c.api.Sub(1, a) }
func (c *ctx) eq(a, b V) V {
	return c.api.IsZero(c.api.Sub(a, b))
}

// less is 1 when a < b. Both must be below 2^n.
func (c *ctx) less(a, b V, n int) V {
	d := c.api.Add(c.api.Sub(a, b), new(big.Int).Lsh(big.NewInt(1), uint(n)))
	return c.not(c.bits(d, n+1)[n])
}

// assertIf constrains x == 0 when cond is 1.
func (c *ctx) zeroIf(cond, x V) {
	c.api.AssertIsEqual(c.api.Mul(cond, x), 0)
}

// trueIf constrains b == 1 when cond is 1.
func (c *ctx) trueIf(cond, b V) {
	c.zeroIf(cond, c.not(b))
}

// pow2 is 2^e for e below 2^len(bits), from the bits of e.
func (c *ctx) pow2(bits []V) V {
	var r V = 1
	for i, b := range bits {
		f := new(big.Int).Lsh(big.NewInt(1), uint(1)<<uint(i))
		r = c.api.Mul(r, c.api.Select(b, f, 1))
	}
	return r
}

// low is the value of the n low bits of a field element.
func (c *ctx) low(v V, n int) V {
	return c.api.FromBinary(c.bits(v, 254)[:n]...)
}

// be returns the big-endian bytes of the number with these bits (least significant first), padded
// with zero bytes to nbytes.
func (c *ctx) be(bits []V, nbytes int) []uints.U8 {
	out := make([]uints.U8, nbytes)
	for j := 0; j < nbytes; j++ {
		lo := 8 * (nbytes - 1 - j)
		if lo >= len(bits) {
			out[j] = uints.NewU8(0)
			continue
		}
		b := make([]V, 8)
		for i := range b {
			if lo+i < len(bits) {
				b[i] = bits[lo+i]
			} else {
				b[i] = 0
			}
		}
		out[j] = c.by.FromBits(b...)
	}
	return out
}

// beNum is the big-endian bytes of v, which must be below 2^nbits.
func (c *ctx) beNum(v V, nbits, nbytes int) []uints.U8 {
	return c.be(c.bits(v, nbits), nbytes)
}

func (c *ctx) sha256(data []uints.U8) []uints.U8 {
	h, err := sha2.New(c.api)
	if err != nil {
		panic(err)
	}
	h.Write(data)
	return h.Sum()
}

// path is the root of the tree that has `leaf` at the index with these bits.
func (c *ctx) path(leaf V, idxBits []V, sibs []V) V {
	h := leaf
	for l := range sibs {
		left := c.api.Select(idxBits[l], sibs[l], h)
		right := c.api.Select(idxBits[l], h, sibs[l])
		h = c.compress(left, right)
	}
	return h
}

// listRoot is the root of the fixed-depth list tree with these first leaves.
func (c *ctx) listRoot(leaves []V) V {
	level := leaves
	zero := big.NewInt(0)
	depth := 0
	for len(level) > 1 {
		next := make([]V, len(level)/2)
		for i := range next {
			next[i] = c.compress(level[2*i], level[2*i+1])
		}
		level = next
		zero = Compress(zero, zero)
		depth++
	}
	h := level[0]
	for ; depth < ListDepth; depth++ {
		h = c.compress(h, zero)
		zero = Compress(zero, zero)
	}
	return h
}
