#!/usr/bin/env bash
# Downloads all 20 Premier League club crests from FPL's own crest CDN into
# public/badges/, named t{code}.png -- matching the numeric `code` field FPL assigns
# each club (see CLUB_INFO in lambda/stats-api/handlers/manager-squad.mjs and
# CREST_CODE_BY_SHORT in src/api/client.js, both of which were verified live against
# FPL's bootstrap-static API before being hardcoded).
#
# Run this once from the repo root:
#   bash scripts/download-club-badges.sh
#
# Once the files exist locally, tell Claude and it'll switch the app to reference
# /badges/t{code}.png instead of the live resources.premierleague.com URL, removing
# the runtime dependency on that CDN entirely.

set -euo pipefail

OUT_DIR="public/badges"
mkdir -p "$OUT_DIR"

# name:code pairs. Includes both the live 2026/27 roster AND the three clubs relegated
# out of it (burnley/west-ham/wolves) -- those three are kept here (and in CLUB_INFO)
# so crests still resolve when browsing a past season via the season dropdown, since
# they were in the top flight then. Coventry/hull/ipswich were added 2026-08-23 after
# being confirmed live against bootstrap-static as this season's promoted clubs.
CLUBS=(
  "arsenal:3"
  "aston-villa:7"
  "bournemouth:91"
  "brentford:94"
  "brighton:36"
  "burnley:90"
  "chelsea:8"
  "coventry:9"
  "crystal-palace:31"
  "everton:11"
  "fulham:54"
  "hull:88"
  "ipswich:40"
  "leeds:2"
  "liverpool:14"
  "man-city:43"
  "man-utd:1"
  "newcastle:4"
  "nottm-forest:17"
  "sunderland:56"
  "spurs:6"
  "west-ham:21"
  "wolves:39"
)

FAILED=()

for entry in "${CLUBS[@]}"; do
  name="${entry%%:*}"
  code="${entry##*:}"
  url="https://resources.premierleague.com/premierleague/badges/70/t${code}.png"
  dest="${OUT_DIR}/t${code}.png"

  echo "Downloading ${name} (code ${code})..."
  if curl -sfL "$url" -o "$dest"; then
    echo "  saved -> $dest"
  else
    echo "  FAILED: $url"
    FAILED+=("$name ($code)")
  fi
done

echo ""
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "All ${#CLUBS[@]} crests downloaded successfully into $OUT_DIR/"
else
  echo "Done, but ${#FAILED[@]} crest(s) failed to download:"
  printf '  - %s\n' "${FAILED[@]}"
  echo "Re-run this script to retry, or download those ones manually."
fi
