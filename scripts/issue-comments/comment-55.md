Shipped in commit 6fcc26e. `getFullPlayerPool()` now captures `ict_index` and
`xgi_per_90` (`expected_goal_involvements_per_90`) per element -- both already
present on every bootstrap-static element, just not previously read into the
pool map. `suggestTransfer`'s candidate ranking (now the shared `scorePlayer()`
function) adds an `underlyingQualityBonus = xgi_per_90*6 + ict_index/40` on
top of the existing ep_next/form weighting, so a player whose underlying
output is strong gets ranked higher even before form/ep_next fully catch up.
Covered by dedicated tests in `squad-advisor.test.mjs`; full 293-test suite
green.
