Shipped in commit 6fcc26e. `selected_by_percent` was already being fetched
into the player pool and simply never used -- `scorePlayer()` now applies a
small subtractive `differentialBonus = -(selected_by_percent/20)`, a
tie-breaker that nudges toward the lower-owned candidate when other scoring
inputs are close, without letting a marginal differential beat a genuinely
better heavily-owned player. Covered by a dedicated test in
`squad-advisor.test.mjs`.
