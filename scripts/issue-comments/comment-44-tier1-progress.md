Progress update: 2 of the 4 Advisor cards are now real, not mock.

- Squad Change (the transfer suggestion) has been real since an earlier
  pass, and its ranking now also factors in underlying stats (xGI/ICT,
  #55), a light ownership-differential nudge (#56), and multi-gameweek
  fixture-run difficulty (#57) -- all shipped in commit 6fcc26e.
- Chip Watch is now real too: it compares all 4 timing chips (Bench Boost,
  Triple Captain, Free Hit, Wildcard) against the manager's actual
  squad/fixtures and surfaces whichever one genuinely looks strongest this
  week (or says plainly when nothing stands out), instead of always
  defaulting to a hand-written Bench Boost suggestion. Also fixes a bug
  caught live: the old Chip Watch reason named a specific real player who
  wasn't even that manager's bench player.

Still mock: Captain Pick and Differential Pick, both blocked on top-100-
overall ingestion (#43/#59-64, not started).
