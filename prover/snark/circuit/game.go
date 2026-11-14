package circuit

import (
	tedwards "github.com/consensys/gnark-crypto/ecc/twistededwards"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/algebra/native/twistededwards"
	stdmimc "github.com/consensys/gnark/std/hash/mimc"
	"github.com/consensys/gnark/std/signature/eddsa"
)

// Indices of GameCircuit.G.
const (
	gChainID = iota
	gSettlement
	gRound
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

// GameCircuit proves the game of one round: commits, reveals, truth, winner and freezes.
//
// Public inputs (Settlement builds the same values, see `_gameInputs`):
//
//	0  chainId << 160 | settlement
//	1  round << 160 | lastClaimRound << 96 | commitCount << 80 | revealCount << 64 |
//	   forcedCommitCount << 48 | forcedRevealCount << 32 | stakePrice
//	2  lastWinnerDepth << 217 | penaltyDisagreement << 209 | penaltyNonRevealed << 201 |
//	   penaltyRandomFactor << 193 | stakeAgeRounds << 185 | hasReveals << 184 | truthDepth << 176 |
//	   redundancy << 160 | winner
//	3  the selection seed, low 253 bits
//	4  (top 64 bits of the round anchor) << 160 | feeRecipient
//	5  commitsRoot    6  revealsRoot    7  forcedCommitsHash    8  forcedRevealsHash
//	9  truthHash, high half    10  truthHash, low half
//	11 freeze codes: 2 bits for each entry, entry k at bit 2k
//	12.. the stake commitment of each entry: P anchored, then F forced (zero for unused entries)
type GameCircuit struct {
	Pub []V `gnark:",public"`

	G             [gLen]V
	Seed          V
	Anchor64      V
	Commits       []Commit
	Forced        []FCommit
	Stakes        []Stake // P for the anchored commits, then F for the forced commits
	Reveals       []Reveal
	ForcedReveals []Reveal
}

// NewGame returns a game circuit of this size, for compilation or as an empty assignment.
func NewGame(c Caps) *GameCircuit {
	return &GameCircuit{
		Pub:           make([]V, GamePublic+c.P+c.F),
		Commits:       make([]Commit, c.P),
		Forced:        make([]FCommit, c.F),
		Stakes:        make([]Stake, c.P+c.F),
		Reveals:       make([]Reveal, c.P),
		ForcedReveals: make([]Reveal, c.F),
	}
}

func (ci *GameCircuit) Define(api frontend.API) error {
	c, err := newCtx(api)
	if err != nil {
		return err
	}
	P, F := len(ci.Commits), len(ci.Forced)
	N := P + F
	g := ci.G

	// ---------------------------------------------------------------- globals
	c.rng(g[gChainID], 64)
	c.rng(g[gSettlement], 160)
	c.rng(g[gRound], 64)
	for _, i := range []int{gCommitCount, gRevealCount, gForcedCommitCount, gForcedRevealCount} {
		c.rng(g[i], 16)
	}
	c.rng(g[gLastClaimRound], 64)
	for _, i := range []int{gLastWinnerDepth, gPenDisagreement, gPenNonRevealed, gPenRandom, gStakeAge} {
		c.rng(g[i], 8)
	}
	c.rng(g[gStakePrice], 32)
	c.rng(g[gFeeRecipient], 160)
	anchor64 := c.bits(ci.Anchor64, 64)
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
			same := c.not(api.Xor(ovHi[127-b], anchor64[63-b]))
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
		return c.low(c.hash(ci.Seed, tag, n), DrawBits)
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
	r64 := c.low(c.hash(ci.Seed, 2), 64)
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

	// ---------------------------------------------------------------- public inputs
	c.rng(tHi, 128)
	c.rng(tLo, 128)
	c.rng(tDepth, 8)
	c.rng(winner, 160)
	c.rng(redundancy, 16)
	pack := func(parts ...V) V { // value, shift, value, shift, ...
		var r V = 0
		for i := 0; i < len(parts); i += 2 {
			r = api.Add(r, api.Mul(parts[i], shl(uint(parts[i+1].(int)))))
		}
		return r
	}
	eq := api.AssertIsEqual
	eq(ci.Pub[0], pack(g[gChainID], 160, g[gSettlement], 0))
	eq(ci.Pub[1], pack(g[gRound], 160, g[gLastClaimRound], 96, g[gCommitCount], 80, g[gRevealCount], 64,
		g[gForcedCommitCount], 48, g[gForcedRevealCount], 32, g[gStakePrice], 0))
	eq(ci.Pub[2], pack(g[gLastWinnerDepth], 217, g[gPenDisagreement], 209, g[gPenNonRevealed], 201,
		g[gPenRandom], 193, g[gStakeAge], 185, hasReveals, 184, tDepth, 176, redundancy, 160, winner, 0))
	eq(ci.Pub[3], ci.Seed)
	eq(ci.Pub[4], pack(ci.Anchor64, 160, g[gFeeRecipient], 0))
	eq(ci.Pub[5], commitsRoot)
	eq(ci.Pub[6], revealsRoot)
	eq(ci.Pub[7], forcedCommitsHash)
	eq(ci.Pub[8], forcedRevealsHash)
	eq(ci.Pub[9], tHi)
	eq(ci.Pub[10], tLo)
	var freezePack V = 0
	for k := 0; k < N; k++ {
		freezePack = api.Add(freezePack, api.Mul(freeze[k], shl(uint(2*k))))
		eq(ci.Pub[GamePublic+k], api.Mul(used[k], commitments[k]))
	}
	eq(ci.Pub[11], freezePack)
	return nil
}
