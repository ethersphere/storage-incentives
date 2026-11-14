package circuit

import (
	"github.com/consensys/gnark/frontend"
)

// PostageCircuit proves the postage accounting between two settlements: the replay of the event log
// of PostageStampZK on the batch tree, the pot, and the batches that expired.
//
// Public inputs (Settlement builds the same values, see `_settlePostage`):
//
//	0 prevStateHash    1 newStateHash
//	2 prevEventIndex << 128 | eventIndex << 64 | cutBlock
//	3 prevEventHash    4 eventHash    (the MiMC hash chain of the event log)
//	5 potAmount    6 validChunkCount
type PostageCircuit struct {
	Pub [PostagePublic]V `gnark:",public"`

	Header         [7]V // root, nextFree, liveChunks, lastCutBlock, priceBlock, priceOutpayment, price
	PrevEventIndex V
	PrevEventHash  V
	CutBlock       V
	Events         []Event
	Expiries       []Expiry
	FinalHead      Write
}

// NewPostage returns a postage circuit of this size.
func NewPostage(c Caps) *PostageCircuit {
	return &PostageCircuit{Events: make([]Event, c.E), Expiries: make([]Expiry, c.X)}
}

func (ci *PostageCircuit) Define(api frontend.API) error {
	c, err := newCtx(api)
	if err != nil {
		return err
	}

	// ---------------------------------------------------------------- postage
	h := ci.Header
	c.rng(h[1], TreeDepth)
	c.rng(h[2], 72)
	c.rng(h[3], 64)
	c.rng(h[4], 64)
	c.rng(h[5], 128)
	c.rng(h[6], 64)
	prevStateHash := c.hash(h[:]...)
	root, nextFree, live := h[0], h[1], h[2]
	lastCut, priceBlock, priceOutp, price := h[3], h[4], h[5], h[6]
	c.rng(api.Sub(lastCut, priceBlock), 64)
	paidTo := api.Add(api.Mul(price, api.Sub(lastCut, priceBlock)), priceOutp)
	c.rng(ci.CutBlock, 64)
	c.rng(api.Sub(ci.CutBlock, lastCut), 64)
	c.rng(ci.PrevEventIndex, 64)

	evHash := ci.PrevEventHash
	var pot, nEvents V = 0, 0
	var prevEn V = 1

	// write checks a leaf against the root (when check is 1) and replaces it (when update is 1).
	write := func(root V, check, update V, w Write, newLeaf [6]V) V {
		idxBits := c.bits(w.Index, TreeDepth)
		old := c.path(c.hash(w.Leaf[:]...), idxBits, w.Sibs[:])
		c.zeroIf(check, api.Sub(old, root))
		return api.Select(update, c.path(c.hash(newLeaf[:]...), idxBits, w.Sibs[:]), root)
	}
	key := func(bal, index V) V { return api.Add(api.Mul(bal, shl(32)), index) }

	for s := range ci.Events {
		ev := ci.Events[s]
		kind, idHi, idLo, depth, value, block := ev.E[0], ev.E[1], ev.E[2], ev.E[3], ev.E[4], ev.E[5]
		isCreate, isTopup, isDepth, isPrice := c.eq(kind, 1), c.eq(kind, 2), c.eq(kind, 3), c.eq(kind, 4)
		isChange := api.Add(isTopup, isDepth)
		en := c.not(api.IsZero(kind))
		api.AssertIsEqual(api.Add(isCreate, isChange, isPrice), en)
		c.zeroIf(en, c.not(prevEn)) // the used slots come first
		prevEn = en
		tree := api.Add(isCreate, isChange)

		c.rng(kind, 8)
		c.rng(idHi, 128)
		c.rng(idLo, 128)
		depthBits := c.bits(depth, 8)
		c.rng(value, 128)
		c.rng(block, 64)
		c.zeroIf(tree, api.Add(depthBits[6], depthBits[7]))
		c.rng(api.Mul(en, api.Sub(ci.CutBlock, block)), 64)
		c.rng(api.Mul(en, api.Sub(block, h[3])), 64)
		c.rng(api.Mul(en, api.Sub(block, priceBlock)), 64)

		outp := api.Add(api.Mul(price, api.Sub(block, priceBlock)), priceOutp)
		delta := api.Mul(en, api.Sub(outp, paidTo))
		c.rng(delta, 128)
		pot = api.Add(pot, api.Mul(live, delta))
		paidTo = api.Select(en, outp, paidTo)

		c.rng(api.Mul(isPrice, value), 64)
		priceBlock = api.Select(isPrice, block, priceBlock)
		priceOutp = api.Select(isPrice, outp, priceOutp)
		price = api.Select(isPrice, value, price)

		a, b, t := ev.W[0], ev.W[1], ev.W[2]
		// unlink (top-up, depth): the predecessor a points to the batch's leaf t
		c.zeroIf(isChange, api.Sub(a.Leaf[4], t.Index))
		c.zeroIf(isChange, api.Sub(a.Leaf[5], t.Leaf[3]))
		newA := a.Leaf
		newA[4], newA[5] = t.Leaf[4], t.Leaf[5]
		root = write(root, isChange, isChange, a, newA)

		// link: b is before the new key, and the successor of b is after it
		c.zeroIf(tree, c.eq(b.Index, t.Index))
		member := api.Or(api.IsZero(b.Index), c.not(api.And(api.IsZero(b.Leaf[0]), api.IsZero(b.Leaf[1]))))
		c.trueIf(tree, member)
		newKey := key(value, t.Index)
		c.trueIf(tree, c.less(key(b.Leaf[3], b.Index), newKey, 161))
		c.trueIf(tree, api.Or(api.IsZero(b.Leaf[4]), c.less(newKey, key(b.Leaf[5], b.Leaf[4]), 161)))
		newB := b.Leaf
		newB[4], newB[5] = t.Index, value
		root = write(root, tree, tree, b, newB)

		// the batch's leaf
		c.zeroIf(isCreate, api.Sub(t.Index, nextFree))
		for f := 0; f < 6; f++ {
			c.zeroIf(isCreate, t.Leaf[f])
		}
		c.zeroIf(isChange, api.Sub(t.Leaf[0], idHi))
		c.zeroIf(isChange, api.Sub(t.Leaf[1], idLo))
		c.zeroIf(tree, api.And(api.IsZero(idHi), api.IsZero(idLo)))
		root = write(root, tree, tree, t, [6]V{idHi, idLo, depth, value, b.Leaf[4], b.Leaf[5]})

		nextFree = api.Add(nextFree, isCreate)
		live = api.Add(live, api.Mul(tree, c.pow2(depthBits[:6])))
		live = api.Sub(live, api.Mul(isChange, c.pow2(c.bits(t.Leaf[2], 6))))
		nEvents = api.Add(nEvents, en)

		// the log hash chain of PostageStampZK
		e1 := api.Add(api.Mul(kind, shl(200)), api.Mul(depth, shl(192)), api.Mul(block, shl(128)), value)
		id := api.Add(api.Mul(idHi, shl(128)), idLo) // the batch id modulo the field
		evHash = api.Select(en, c.compress(c.compress(evHash, e1), id), evHash)
	}

	// the cut
	c.rng(api.Sub(ci.CutBlock, priceBlock), 64)
	cut := api.Add(api.Mul(price, api.Sub(ci.CutBlock, priceBlock)), priceOutp)
	c.rng(api.Sub(cut, paidTo), 128)
	pot = api.Add(pot, api.Mul(live, api.Sub(cut, paidTo)))
	expired := func(head Write) V {
		return api.And(c.not(api.IsZero(head.Leaf[4])), c.not(c.less(cut, head.Leaf[5], 129)))
	}
	for x := range ci.Expiries {
		hd, t := ci.Expiries[x].Head, ci.Expiries[x].Target
		api.AssertIsEqual(hd.Index, 0)
		gone := expired(hd)
		c.zeroIf(gone, api.Sub(t.Index, hd.Leaf[4]))
		c.zeroIf(gone, api.Sub(t.Leaf[3], hd.Leaf[5]))
		newHd := hd.Leaf
		newHd[4], newHd[5] = t.Leaf[4], t.Leaf[5]
		root = write(root, 1, gone, hd, newHd)
		root = write(root, gone, gone, t, [6]V{0, 0, 0, 0, 0, 0})
		size := api.Mul(gone, c.pow2(c.bits(t.Leaf[2], 6)))
		unpaid := api.Mul(gone, api.Sub(cut, t.Leaf[3]))
		pot = api.Sub(pot, api.Mul(size, unpaid))
		live = api.Sub(live, size)
	}
	api.AssertIsEqual(ci.FinalHead.Index, 0)
	root = write(root, 1, 0, ci.FinalHead, ci.FinalHead.Leaf)
	api.AssertIsEqual(expired(ci.FinalHead), 0)

	newStateHash := c.hash(root, nextFree, live, ci.CutBlock, priceBlock, priceOutp, price)
	eventIndex := api.Add(ci.PrevEventIndex, nEvents)

	// ---------------------------------------------------------------- public inputs
	c.rng(eventIndex, 64)
	c.rng(pot, 200)
	c.rng(live, 72)
	eq := api.AssertIsEqual
	eq(ci.Pub[0], prevStateHash)
	eq(ci.Pub[1], newStateHash)
	eq(ci.Pub[2], api.Add(api.Mul(ci.PrevEventIndex, shl(128)), api.Mul(eventIndex, shl(64)), ci.CutBlock))
	eq(ci.Pub[3], ci.PrevEventHash)
	eq(ci.Pub[4], evHash)
	eq(ci.Pub[5], pot)
	eq(ci.Pub[6], live)
	return nil
}
