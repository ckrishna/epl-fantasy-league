Shipped in commit 6fcc26e. New `getFixtureRunMap(fixtures, fromGw, numGws)`
averages each team's fixture difficulty across a multi-gameweek window
(default 4 GWs), fed into `scorePlayer()`'s `fixtureRunBonus = (3 - avgDifficulty) * 1.5`
so a team with an easier-than-average run gets a positive score bonus, a
harder-than-average run a penalty. Used both by `suggestTransfer`'s
transfer-in ranking and the new `evaluateTripleCaptain`'s captain-pick
ranking. Pure function, unit-tested directly against hand-built fixture
arrays in `squad-advisor.test.mjs`.
