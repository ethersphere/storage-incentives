package circuit

import (
	"math/big"

	tedwards "github.com/consensys/gnark-crypto/ecc/twistededwards"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/algebra/native/twistededwards"
	stdmimc "github.com/consensys/gnark/std/hash/mimc"
	"github.com/consensys/gnark/std/math/uints"
	"github.com/consensys/gnark/std/signature/eddsa"
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
)

// Caps is the size of the circuit: P anchored commits and reveals, F forced commits and reveals,
// E postage events and X batch expiries. P must be a power of two.
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

// Indices of Circuit.G.
const (
	gChainID = iota
	gSettlement
	gRound
	gAnchorHi
	gAnchorLo
	gSeedHi
	gSeedLo
	gCommitCount
	gRevealCount
	gForcedCommitCount
	gForcedRevealCount
	gLastClaimRound
	gLastWinnerDepth
	gPenDisagreement
	gPenNonRevealed
	gPenRandom
	gStakeAge
	gStakePrice
	gFeeRecipient
	gLen
)

type Circuit struct {
	// sha256 of the packed public values, top 3 bits cleared.
	Digest V `gnark:",public"`

	G             [gLen]V
	Commits       []Commit
	Forced        []FCommit
	Stakes        []Stake // P for the anchored commits, then F for the forced commits
	Reveals       []Reveal
	ForcedReveals []Reveal

	Header         [7]V // root, nextFree, liveChunks, lastCutBlock, priceBlock, priceOutpayment, price
	PrevEventIndex V
	PrevEventHash  [2]V
	CutBlock       V
	Events         []Event
	Expiries       []Expiry
	FinalHead      Write
}

// New returns a circuit of this size, for compilation or as an empty assignment.
func New(c Caps) *Circuit {
	return &Circuit{
		Commits:       make([]Commit, c.P),
		Forced:        make([]FCommit, c.F),
		Stakes:        make([]Stake, c.P+c.F),
		Reveals:       make([]Reveal, c.P),
		ForcedReveals: make([]Reveal, c.F),
		Events:        make([]Event, c.E),
		Expiries:      make([]Expiry, c.X),
	}
}

func commitDomain() *big.Int { return new(big.Int).SetBytes([]byte("SwarmCommit")) }

func shl(n uint) *big.Int { return new(big.Int).Lsh(big.NewInt(1), n) }

func (ci *Circuit) Define(api frontend.API) error {
	c, err := newCtx(api)
	if err != nil {
		return err
	}
	P, F := len(ci.Commits), len(ci.Forced)
	N := P + F
	g := ci.G

	// ---------------------------------------------------------------- globals
	chainBits := c.bits(g[gChainID], 64)
	settlementBits := c.bits(g[gSettlement], 160)
	roundBits := c.bits(g[gRound], 64)
	anchorHi, anchorLo := c.bits(g[gAnchorHi], 128), c.bits(g[gAnchorLo], 128)
	seedHiBits, seedLoBits := c.bits(g[gSeedHi], 128), c.bits(g[gSeedLo], 128)
	commitCountBits := c.bits(g[gCommitCount], 16)
	revealCountBits := c.bits(g[gRevealCount], 16)
	fCommitCountBits := c.bits(g[gForcedCommitCount], 16)
	fRevealCountBits := c.bits(g[gForcedRevealCount], 16)
	lastClaimBits := c.bits(g[gLastClaimRound], 64)
	lwdBits := c.bits(g[gLastWinnerDepth], 8)
	pen1Bits := c.bits(g[gPenDisagreement], 8)
	pen2Bits := c.bits(g[gPenNonRevealed], 8)
	penRBits := c.bits(g[gPenRandom], 8)
	ageBits := c.bits(g[gStakeAge], 8)
	priceBits := c.bits(g[gStakePrice], 32)
	feeBits := c.bits(g[gFeeRecipient], 160)
	api.AssertIsEqual(c.less(P, g[gCommitCount], 16), 0)
	api.AssertIsEqual(c.less(P, g[gRevealCount], 16), 0)
	api.AssertIsEqual(c.less(F, g[gForcedCommitCount], 16), 0)
	api.AssertIsEqual(c.less(F, g[gForcedRevealCount], 16), 0)

	// minimum depth: skipped = min(round - lastClaimRound, 254) + 1
	diff := api.Sub(g[gRound], g[gLastClaimRound])
	c.rng(diff, 64)
	skipped := api.Select(c.less(254, diff, 64), 255, api.Add(diff, 1))
	minDepth := api.Select(c.less(skipped, g[gLastWinnerDepth], 9), api.Sub(g[gLastWinnerDepth], skipped), 0)

	roundStart := api.Mul(g[gRound], RoundLength)
	cutoff := api.Mul(g[gStakeAge], RoundLength)
	startOK := c.not(c.less(roundStart, cutoff, 72))
	threshold := api.Select(startOK, api.Sub(roundStart, cutoff), 0)

	// ---------------------------------------------------------------- commits
	curve, err := twistededwards.NewEdCurve(api, tedwards.BN254)
	if err != nil {
		return err
	}
	hasher, err := stdmimc.NewMiMC(api)
	if err != nil {
		return err
	}
	baseX, baseY := curve.Params().Base[0], curve.Params().Base[1]

	owners := make([]V, N)
	obfs := make([]V, N)
	used := make([]V, N)
	active := make([]V, N)
	commitments := make([]V, N)

	leaves := make([]V, P)
	for i := 0; i < P; i++ {
		cm, st := ci.Commits[i], ci.Stakes[i]
		owners[i], obfs[i] = cm.Owner, cm.Obf
		c.rng(cm.Owner, 160)
		used[i] = c.less(i, g[gCommitCount], 16)
		if i > 0 {
			c.trueIf(used[i], c.less(owners[i-1], owners[i], 160))
		}
		msg := c.hash(commitDomain(), g[gChainID], g[gSettlement], g[gRound], cm.Obf)
		keyZero := api.And(api.IsZero(st.KeyX), api.IsZero(st.KeyY))
		key := eddsa.PublicKey{A: twistededwards.Point{
			X: api.Select(keyZero, baseX, st.KeyX),
			Y: api.Select(keyZero, baseY, st.KeyY),
		}}
		sig := eddsa.Signature{R: twistededwards.Point{X: cm.Rx, Y: cm.Ry}, S: cm.S}
		hasher.Reset()
		ok, err := eddsa.IsValid(curve, sig, msg, key, &hasher)
		if err != nil {
			return err
		}
		active[i] = api.And(api.And(used[i], ok), c.not(keyZero))
		leaves[i] = api.Mul(used[i], c.hash(cm.Owner, cm.Obf, cm.Rx, cm.Ry, cm.S))
	}
	commitsRoot := c.listRoot(leaves)

	var forcedCommitsHash V = 0
	for j := 0; j < F; j++ {
		k := P + j
		fc := ci.Forced[j]
		owners[k], obfs[k] = fc.Owner, fc.Obf
		c.rng(fc.Owner, 160)
		used[k] = c.less(j, g[gForcedCommitCount], 16)
		forcedCommitsHash = api.Select(used[k],
			c.compress(forcedCommitsHash, c.compress(fc.Owner, fc.Obf)), forcedCommitsHash)
		var present V = 0
		for q := 0; q < k; q++ {
			present = api.Or(present, api.And(active[q], c.eq(owners[q], fc.Owner)))
		}
		active[k] = api.And(used[k], c.not(present))
	}

	// ---------------------------------------------------------------- stakes
	type stakeInfo struct {
		eligible, left, heightOK V
		prox                     V // leading bits equal to the round anchor, at most 64
		eff                      V // effective stake
	}
	infos := make([]stakeInfo, N)
	for k := 0; k < N; k++ {
		st := ci.Stakes[k]
		ovHi := c.bits(st.OvHi, 128)
		c.rng(st.OvLo, 128)
		c.rng(st.Committed, StakeBits)
		c.rng(st.Potential, StakeBits)
		heightBits := c.bits(st.Height, 8)
		c.rng(st.LastUpdated, 64)
		commitments[k] = c.hash(
			api.Add(api.Mul(owners[k], shl(72)), api.Mul(st.Height, shl(64)), st.LastUpdated),
			st.OvHi, st.OvLo,
			api.Add(api.Mul(st.Committed, shl(StakeBits)), st.Potential),
			st.KeyX, st.KeyY)

		nz := c.not(api.IsZero(st.LastUpdated))
		eligible := api.And(api.And(nz, startOK), c.less(st.LastUpdated, threshold, 72))
		infos[k].eligible = eligible
		infos[k].left = api.And(api.And(active[k], c.not(eligible)), c.not(c.less(st.LastUpdated, roundStart, 72)))
		infos[k].heightOK = api.And(c.not(heightBits[6]), c.not(heightBits[7]))

		var prox, all V = 0, 1
		for b := 0; b < 64; b++ {
			same := c.not(api.Xor(ovHi[127-b], anchorHi[127-b]))
			all = api.And(all, same)
			prox = api.Add(prox, all)
		}
		infos[k].prox = prox

		committedBzz := api.Mul(api.Mul(c.pow2(heightBits[:6]), st.Committed), g[gStakePrice])
		infos[k].eff = api.Select(c.less(committedBzz, st.Potential, 192), committedBzz, st.Potential)
	}

	// ---------------------------------------------------------------- reveals
	R := P + F
	reveals := make([]Reveal, 0, R)
	reveals = append(reveals, ci.Reveals...)
	reveals = append(reveals, ci.ForcedReveals...)
	revHash := make([]V, R)
	revUsed := make([]V, R)
	revDepthOK := make([]V, R)
	revLeaves := make([]V, P)
	var forcedRevealsHash V = 0
	for r := 0; r < R; r++ {
		rv := reveals[r]
		c.rng(rv.Depth, 8)
		revHash[r] = c.hash(rv.OvHi, rv.OvLo, rv.Depth, rv.HHi, rv.HLo, rv.NHi, rv.NLo)
		revDepthOK[r] = c.not(c.less(rv.Depth, minDepth, 8))
		if r < P {
			revUsed[r] = c.less(r, g[gRevealCount], 16)
			revLeaves[r] = api.Mul(revUsed[r], revHash[r])
		} else {
			revUsed[r] = c.less(r-P, g[gForcedRevealCount], 16)
			forcedRevealsHash = api.Select(revUsed[r], c.compress(forcedRevealsHash, revHash[r]), forcedRevealsHash)
		}
	}
	revealsRoot := c.listRoot(revLeaves)

	// ---------------------------------------------------------------- entries: the first valid reveal of each
	isEntry := make([]V, N)
	revealed := make([]V, N)
	rDepth := make([]V, N)
	rHi := make([]V, N)
	rLo := make([]V, N)
	density := make([]V, N)
	for k := 0; k < N; k++ {
		st := ci.Stakes[k]
		isEntry[k] = api.And(active[k], infos[k].eligible)
		var found, depth, hi, lo, resp V = 0, 0, 0, 0, 0
		for r := 0; r < R; r++ {
			rv := reveals[r]
			m := api.And(revUsed[r], revDepthOK[r])
			m = api.And(m, c.eq(rv.OvHi, st.OvHi))
			m = api.And(m, c.eq(rv.OvLo, st.OvLo))
			m = api.And(m, c.eq(revHash[r], obfs[k]))
			ge := c.not(c.less(rv.Depth, st.Height, 8))
			rs := api.Select(ge, api.Sub(rv.Depth, st.Height), 255)
			m = api.And(m, c.not(c.less(infos[k].prox, rs, 9)))
			m = api.And(m, infos[k].heightOK)
			take := api.And(m, c.not(found))
			found = api.Or(found, m)
			depth = api.Add(depth, api.Mul(take, rv.Depth))
			hi = api.Add(hi, api.Mul(take, rv.HHi))
			lo = api.Add(lo, api.Mul(take, rv.HLo))
			resp = api.Add(resp, api.Mul(take, rs))
		}
		revealed[k] = api.And(isEntry[k], found)
		rDepth[k], rHi[k], rLo[k] = depth, hi, lo
		density[k] = api.Mul(infos[k].eff, c.pow2(c.bits(resp, 7)))
	}

	// ---------------------------------------------------------------- truth
	draw := func(tag int, n V) V {
		return c.low(c.hash(g[gSeedHi], g[gSeedLo], tag, n), DrawBits)
	}
	picked := func(random, sum, dens V) V {
		return c.less(api.Mul(random, sum), api.Mul(dens, shl(DrawBits)), 250)
	}
	var hasReveals, idx, sum, tHi, tLo, tDepth V = 0, 0, 0, 0, 0, 0
	for k := 0; k < N; k++ {
		hasReveals = api.Or(hasReveals, revealed[k])
		sum = api.Add(sum, api.Mul(revealed[k], density[k]))
		p := api.And(revealed[k], picked(draw(0, idx), sum, density[k]))
		tHi = api.Select(p, rHi[k], tHi)
		tLo = api.Select(p, rLo[k], tLo)
		tDepth = api.Select(p, rDepth[k], tDepth)
		idx = api.Add(idx, isEntry[k])
	}

	// ---------------------------------------------------------------- winner and freezes
	r64 := c.low(c.hash(g[gSeedHi], g[gSeedLo], 2), 64)
	qr, err := api.Compiler().NewHint(divModHint, 2, r64, 100)
	if err != nil {
		return err
	}
	c.rng(qr[0], 64)
	c.rng(qr[1], 8)
	api.AssertIsEqual(c.less(qr[1], 100, 8), 1)
	api.AssertIsEqual(api.Add(api.Mul(qr[0], 100), qr[1]), r64)
	lottery := c.less(qr[1], g[gPenRandom], 8)

	var winner, redundancy V = 0, 0
	sum = 0
	freeze := make([]V, N)
	for k := 0; k < N; k++ {
		isTruth := api.And(revealed[k], api.And(c.eq(rHi[k], tHi), api.And(c.eq(rLo[k], tLo), c.eq(rDepth[k], tDepth))))
		sum = api.Add(sum, api.Mul(isTruth, density[k]))
		p := api.And(isTruth, picked(draw(1, redundancy), sum, density[k]))
		winner = api.Select(p, owners[k], winner)
		redundancy = api.Add(redundancy, isTruth)
		disagree := api.And(api.And(revealed[k], c.not(isTruth)), lottery)
		silent := api.Or(api.And(isEntry[k], c.not(revealed[k])), infos[k].left)
		freeze[k] = api.Mul(hasReveals, api.Add(disagree, api.Mul(silent, 2)))
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
	cutBits := c.bits(ci.CutBlock, 64)
	c.rng(api.Sub(ci.CutBlock, lastCut), 64)
	c.rng(ci.PrevEventIndex, 64)

	evHash := append(c.beNum(ci.PrevEventHash[0], 128, 16), c.beNum(ci.PrevEventHash[1], 128, 16)...)
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

		kindBits := c.bits(kind, 8)
		idHiBits, idLoBits := c.bits(idHi, 128), c.bits(idLo, 128)
		depthBits := c.bits(depth, 8)
		valueBits := c.bits(value, 128)
		blockBits := c.bits(block, 64)
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
		var pre []uints.U8
		pre = append(pre, evHash...)
		pre = append(pre, c.be(kindBits, 1)...)
		pre = append(pre, c.be(idHiBits, 16)...)
		pre = append(pre, c.be(idLoBits, 16)...)
		pre = append(pre, c.be(depthBits, 1)...)
		pre = append(pre, c.be(valueBits, 16)...)
		pre = append(pre, c.be(blockBits, 8)...)
		next := c.sha256(pre)
		for i := range evHash {
			evHash[i] = c.by.ValueOf(api.Select(en, next[i].Val, evHash[i].Val))
		}
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

	// ---------------------------------------------------------------- public values
	fr32 := func(v V) []uints.U8 { return c.be(c.bits(v, 254), 32) }
	var pv []uints.U8
	add := func(b []uints.U8) { pv = append(pv, b...) }
	add(c.be(chainBits, 32))
	add(c.be(settlementBits, 20))
	add(c.be(roundBits, 8))
	add(c.be(anchorHi, 16))
	add(c.be(anchorLo, 16))
	add(c.be(seedHiBits, 16))
	add(c.be(seedLoBits, 16))
	add(fr32(commitsRoot))
	add(c.be(commitCountBits, 4))
	add(fr32(revealsRoot))
	add(c.be(revealCountBits, 4))
	add(fr32(forcedCommitsHash))
	add(c.be(fCommitCountBits, 4))
	add(fr32(forcedRevealsHash))
	add(c.be(fRevealCountBits, 4))
	add(c.be(lastClaimBits, 8))
	add(c.be(lwdBits, 1))
	add(c.be(pen1Bits, 1))
	add(c.be(pen2Bits, 1))
	add(c.be(penRBits, 1))
	add(c.be(ageBits, 1))
	add(c.be(priceBits, 4))
	add(fr32(prevStateHash))
	add(c.beNum(ci.PrevEventIndex, 64, 8))
	add(c.beNum(ci.PrevEventHash[0], 128, 16))
	add(c.beNum(ci.PrevEventHash[1], 128, 16))
	add(c.beNum(eventIndex, 64, 8))
	add(evHash)
	add(c.be(cutBits, 8))
	add(c.beNum(hasReveals, 1, 1))
	add(c.beNum(tHi, 128, 16))
	add(c.beNum(tLo, 128, 16))
	add(c.beNum(tDepth, 8, 1))
	add(c.beNum(winner, 160, 20))
	add(c.beNum(redundancy, 16, 2))
	add(c.be(feeBits, 20))
	add(fr32(newStateHash))
	add(c.beNum(pot, 200, 32))
	add(c.beNum(live, 72, 32))
	for k := 0; k < N; k++ {
		add(fr32(api.Mul(used[k], commitments[k])))
		add(c.beNum(freeze[k], 2, 1))
	}

	sum256 := c.sha256(pv)
	var dbits []V
	for i := 31; i >= 0; i-- {
		dbits = append(dbits, c.by.ToBits(sum256[i])...)
	}
	api.AssertIsEqual(api.FromBinary(dbits[:253]...), ci.Digest)
	return nil
}
