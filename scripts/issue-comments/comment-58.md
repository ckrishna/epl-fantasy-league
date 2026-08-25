Shipped in commit 6fcc26e. New `getUpcomingChipWindows(fixtures, fromGw, numGws)`
scans a gameweek window and flags, per gameweek, which teams have zero
fixtures (blank) or 2+ fixtures (double). Exposed on the
`/manager-squad/advisor` response as `upcoming_chip_windows`. The same-day
`evaluateChipOptions` work (see #44) went further and used the single-gameweek
version of this (`numGws=1`) to power `evaluateFreeHit`'s blank-starter
detection directly, rather than leaving this purely informational.
