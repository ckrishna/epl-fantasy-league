import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, getCurrentSeason, getCurrentSeasonInfo, getActiveGameweek } from '../utils/dynamodb.mjs';

const FPL_API = 'https://fantasy.premierleague.com/api';
const FPL_FETCH_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

// FPL's own 3-letter club code plus its numeric club `code` (the identifier FPL's
// crest CDN keys images by -- NOT the same as `teams.team_id`, which is just a
// per-season array index), keyed by full team name as stored on `teams`/
// `fpl_fixture_data` (team_h_name/team_a_name). Verified live against FPL's own
// bootstrap-static response and against vaastav/Fantasy-Premier-League's 2025/26
// teams.csv (both agree) rather than guessed from memory, since a wrong numeric code
// here would silently point at the wrong club's crest with no error to catch it.
// Not ingested anywhere ourselves -- `teams` only ever stored the full `name` field,
// never `short_name`/`code` -- so this is a small static lookup rather than a schema
// change. Falls back to a text-only badge (first 3 letters, uppercased, no crest URL)
// for any club not in this list, so a mid-season name we haven't seen yet still
// renders something reasonable instead of crashing.
// Burnley/West Ham/Wolves are kept here even though they're NOT in the live 2026/27
// top flight (confirmed live 2026-08-23 against bootstrap-static: this season's 20
// clubs are Arsenal/Aston Villa/Bournemouth/Brentford/Brighton/Chelsea/Coventry City/
// Crystal Palace/Everton/Fulham/Hull City/Ipswich Town/Leeds/Liverpool/Man City/
// Man Utd/Newcastle/Nott'm Forest/Spurs/Sunderland -- Burnley, West Ham, and Wolves
// were all relegated, replaced by the three newly-promoted clubs added below) --
// removing them would break crests/kit colors for anyone browsing a PAST season (the
// season dropdown, task #14) where those three clubs were still in the league. Only
// ADD promoted clubs here, never remove a relegated one.
const CLUB_INFO = {
  'Arsenal': { short: 'ARS', code: 3 }, 'Aston Villa': { short: 'AVL', code: 7 },
  'Bournemouth': { short: 'BOU', code: 91 }, 'Brentford': { short: 'BRE', code: 94 },
  'Brighton': { short: 'BHA', code: 36 }, 'Burnley': { short: 'BUR', code: 90 },
  'Chelsea': { short: 'CHE', code: 8 }, 'Crystal Palace': { short: 'CRY', code: 31 },
  'Everton': { short: 'EVE', code: 11 }, 'Fulham': { short: 'FUL', code: 54 },
  'Leeds': { short: 'LEE', code: 2 }, 'Liverpool': { short: 'LIV', code: 14 },
  'Man City': { short: 'MCI', code: 43 }, 'Man Utd': { short: 'MUN', code: 1 },
  'Newcastle': { short: 'NEW', code: 4 }, "Nott'm Forest": { short: 'NFO', code: 17 },
  'Sunderland': { short: 'SUN', code: 56 }, 'Spurs': { short: 'TOT', code: 6 },
  'West Ham': { short: 'WHU', code: 21 }, 'Wolves': { short: 'WOL', code: 39 },
  // Promoted for 2026/27 -- code/short_name verified live against bootstrap-static's
  // own teams array on 2026-08-23.
  'Coventry City': { short: 'COV', code: 9 }, 'Hull City': { short: 'HUL', code: 88 },
  'Ipswich Town': { short: 'IPS', code: 40 }
};

function clubCode(name) {
  if (!name) return '???';
  return CLUB_INFO[name]?.short || name.slice(0, 3).toUpperCase();
}

// A root-relative path, not a live URL -- the crest PNGs (downloaded once via
// scripts/download-club-badges.sh from FPL's own CDN) are checked into the frontend's
// public/badges/ folder and served by Cloudflare Pages alongside the rest of the app,
// so the browser resolves this against whatever origin the app itself is loaded from.
// No runtime dependency on resources.premierleague.com. Returns null (not a
// broken-image path) for any unrecognized club so the frontend can fall back to the
// text badge instead of rendering a missing-image icon.
function clubCrestUrl(name) {
  const code = CLUB_INFO[name]?.code;
  return code ? `/badges/t${code}.png` : null;
}

// GKP/DEF/MID/FWD -- FPL's own element_type IDs, stable across seasons. Not read from
// the (unread-elsewhere, per DATA_MODEL.md) `element_types` table for the same reason
// getManagerSeasonAggregates and friends don't bother querying it: this mapping never
// changes and querying it every request would just be an extra round trip for a
// constant.
const POSITION_LABELS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

// A player's rolling form (FPL's own 0-10ish scale, see player_event_stats.form) is
// bucketed into hot/cold/neutral for the pitch view's flame/snowflake indicators.
// Neutral (the common case) gets no icon at all -- see the mockup iteration history:
// the user explicitly asked for cold to read as more visually important than hot, and
// for hot/neutral to stay quiet by comparison.
function formTag(form) {
  const f = parseFloat(form);
  if (Number.isNaN(f)) return 'neutral';
  if (f <= 2) return 'cold';
  if (f >= 6) return 'hot';
  return 'neutral';
}

async function getTeamNameMap(seasonId) {
  try {
    const result = await dynamodb.send(new QueryCommand({
      TableName: 'teams',
      KeyConditionExpression: 'season_id = :sid',
      ExpressionAttributeValues: { ':sid': seasonId }
    }));
    return (result.Items || []).reduce((acc, t) => {
      acc[t.team_id] = t.name;
      return acc;
    }, {});
  } catch (err) {
    console.error('getTeamNameMap error:', err);
    return {};
  }
}

async function getPicksForGW(season, entryId, gw) {
  const result = await dynamodb.send(new QueryCommand({
    TableName: 'fpl_entry_picks',
    KeyConditionExpression: 'season_entry_gw = :k',
    ExpressionAttributeValues: { ':k': `${season}#${entryId}#${gw}` }
  }));
  return result.Items || [];
}

// Shared by handleManagerSquad and handleSquadAdvisor -- both need "the most recent
// gameweek this entry actually has picks for," walking backward from the requested/
// active gameweek since a manager who joined mid-season (or a gap in our own data)
// means the exact active gameweek may have nothing stored yet. Factored out rather
// than left duplicated in each handler, same reasoning as every other shared query
// helper in this file (getFormMap, getTeamNameMap, ...) -- two copies of a "walk
// backward until you find data" loop are exactly the kind of thing that quietly drifts
// out of sync when one gets a fix the other doesn't.
async function resolvePicksForEntry(season, entryId, requestedGw) {
  let gw = requestedGw;
  let picks = await getPicksForGW(season, entryId, gw);
  while ((!picks || picks.length === 0) && gw > 1) {
    gw -= 1;
    picks = await getPicksForGW(season, entryId, gw);
  }
  return { gw, picks };
}

async function getFormMap(seasonId, gw) {
  try {
    const result = await dynamodb.send(new QueryCommand({
      TableName: 'player_event_stats',
      KeyConditionExpression: 'season_id = :sid AND begins_with(gameweek_player, :gw)',
      ExpressionAttributeValues: { ':sid': seasonId, ':gw': `${gw}#` }
    }));
    return (result.Items || []).reduce((acc, row) => {
      acc[row.player_id] = row.form;
      return acc;
    }, {});
  } catch (err) {
    console.error('getFormMap error:', err);
    return {};
  }
}

// fpl_fixture_data's partition key embeds the fixture id itself (season_id#fixture_id),
// so there's no way to Query "every fixture from gameweek N onward" directly -- same
// scan-and-filter shape as every other multi-row read against this table family (see
// getOurLeaguePicks in genbi.mjs). 385 items total for a full season, so a full scan is
// cheap. Fetches the WHOLE season (not just from the active gameweek onward, like this
// used to) -- the fixture-detail popup's "recent form" needs the already-PLAYED
// fixtures too, and one full-season scan covers both needs instead of two separate
// ones. Every raw field on each item (kickoff_time, status, team_h_score/team_a_score,
// not just event/team_h/team_a/difficulty) is kept -- fixturesForPlayer below reads
// more of them now than it used to.
async function getSeasonFixtures(seasonId) {
  try {
    const result = await dynamodb.send(new ScanCommand({
      TableName: 'fpl_fixture_data',
      FilterExpression: 'season_id = :sid',
      ExpressionAttributeValues: { ':sid': seasonId }
    }));
    return (result.Items || []).sort((a, b) => a.event - b.event);
  } catch (err) {
    console.error('getSeasonFixtures error:', err);
    return [];
  }
}

// Full team rows (not just the id -> name lookup getTeamNameMap already does) --
// strength ratings, league position/points -- for the fixture-detail popup's opponent
// context. Same table getTeamNameMap already queries, just keeping every field instead
// of only `name`.
async function getTeamsMap(seasonId) {
  try {
    const result = await dynamodb.send(new QueryCommand({
      TableName: 'teams',
      KeyConditionExpression: 'season_id = :sid',
      ExpressionAttributeValues: { ':sid': seasonId }
    }));
    return (result.Items || []).reduce((acc, t) => {
      acc[t.team_id] = t;
      return acc;
    }, {});
  } catch (err) {
    console.error('getTeamsMap error:', err);
    return {};
  }
}

// 'W' | 'D' | 'L' from teamId's own perspective, or null if the fixture hasn't
// actually finished yet (no result to report) or teamId wasn't in it.
function resultForTeam(fixture, teamId) {
  if (fixture.status !== 'FINISHED') return null;
  const isHome = fixture.team_h === teamId;
  if (!isHome && fixture.team_a !== teamId) return null;
  const gf = isHome ? fixture.team_h_score : fixture.team_a_score;
  const ga = isHome ? fixture.team_a_score : fixture.team_h_score;
  if (typeof gf !== 'number' || typeof ga !== 'number') return null;
  if (gf > ga) return 'W';
  if (gf < ga) return 'L';
  return 'D';
}

// Last up to `count` FINISHED results for teamId, strictly before `beforeGw` (so every
// fixture pill on the card -- current gameweek's included -- shows form "coming into"
// that match, not form that includes it), oldest first so the frontend can lay them
// out left-to-right ending at "most recent" without re-sorting.
function recentFormForTeam(fixtures, teamId, beforeGw, count = 5) {
  return fixtures
    .filter((f) => f.event < beforeGw && (f.team_h === teamId || f.team_a === teamId))
    .sort((a, b) => a.event - b.event)
    .map((f) => resultForTeam(f, teamId))
    .filter((r) => r !== null)
    .slice(-count);
}

// Same table + fields Standings.jsx's net_points already reads (`fpl_league_standings`,
// keyed by season_event = "{season}#{gw}" + manager_id = entry_id) -- reusing this
// instead of a fresh guess at fpl_entry_gameweek's own transfer_cost field, so "net"
// here means exactly what Standings already calls net points, not a second slightly
// different definition of the same idea.
// Reads the chip played THIS gameweek (wildcard/freehit/bboost/3xc/manager, or null),
// stored on fpl_entry_gameweek by fpl-data-ingester's storeGameweekSummary -- a
// separate query this handler didn't previously make at all (see the note that used to
// sit where this function is now called). Needed because a chip changes how the whole
// squad should be read (bench boost means the bench counts too, triple captain triples
// instead of doubles) and, at minimum, managers want to see it flagged on their own
// squad view rather than only in the raw data.
async function getActiveChip(season, entryId, gw) {
  try {
    const result = await dynamodb.send(new QueryCommand({
      TableName: 'fpl_entry_gameweek',
      KeyConditionExpression: 'season_entry = :se AND gameweek = :gw',
      ExpressionAttributeValues: { ':se': `${season}#${entryId}`, ':gw': gw }
    }));
    return result.Items?.[0]?.active_chip || null;
  } catch (err) {
    console.error('getActiveChip error:', err);
    return null;
  }
}

async function getTransferCost(season, gw, entryId) {
  try {
    const result = await dynamodb.send(new QueryCommand({
      TableName: 'fpl_league_standings',
      KeyConditionExpression: 'season_event = :se AND manager_id = :mid',
      ExpressionAttributeValues: { ':se': `${season}#${gw}`, ':mid': entryId }
    }));
    return result.Items?.[0]?.transfer_cost || 0;
  } catch (err) {
    console.error('getTransferCost error:', err);
    return 0;
  }
}

// Distinguishes "this manager has a real gap in our data" from "nobody has picks yet
// because the season hasn't kicked off" -- confirmed live 2026-08-12 against entry
// 728477 (this app's own test manager): FPL's bootstrap-static showed every 2026/27
// gameweek with is_current: false and finished: false, GW1's deadline nine days out,
// and the entry itself had entered_events: []. Our own ingester correctly finds
// nothing to store in that state (there's nothing on FPL's side to fetch), so the
// empty-squad response needs to say so plainly instead of reading like a bug. Fails
// "open" (returns true, i.e. "assume started") on any fetch error -- a transient FPL
// outage shouldn't make the UI falsely claim the season hasn't begun.
async function hasSeasonStarted() {
  try {
    const response = await fetch(`${FPL_API}/bootstrap-static/`, { headers: FPL_FETCH_HEADERS });
    if (!response.ok) return true;
    const data = await response.json();
    return (data.events || []).some((e) => e.is_current || e.finished);
  } catch (err) {
    console.error('hasSeasonStarted error:', err);
    return true;
  }
}

// Player availability (doubtful/injured/suspended/unavailable, plus FPL's own
// chance-of-playing percentages and free-text team news) fetched LIVE from
// bootstrap-static rather than read from the `players` DynamoDB table -- deliberately
// the same choice as getSeasonFixtures's kickoff_time-over-status lesson: `players` is
// only written by fpl-bootstrap, which runs once a WEEK, but a player's fitness/news
// can change daily (sometimes hourly close to a deadline). Reading it from a
// once-a-week-refreshed table would silently show stale "doubtful" or "fully fit"
// status for days. bootstrap-static itself is one lightweight call (same endpoint
// hasSeasonStarted already hits), so this fetches it fresh on every request instead.
// Fails "open" (empty map, meaning every player reads as available) on any fetch
// error -- a transient FPL outage shouldn't make every single player wrongly show a
// red/yellow flag.
async function getAvailabilityMap() {
  try {
    const response = await fetch(`${FPL_API}/bootstrap-static/`, { headers: FPL_FETCH_HEADERS });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const map = new Map();
    for (const el of data.elements || []) {
      map.set(el.id, {
        status: el.status || 'a',
        chance_of_playing_this_round: typeof el.chance_of_playing_this_round === 'number' ? el.chance_of_playing_this_round : null,
        chance_of_playing_next_round: typeof el.chance_of_playing_next_round === 'number' ? el.chance_of_playing_next_round : null,
        news: el.news || null,
        news_added: el.news_added || null
      });
    }
    return map;
  } catch (err) {
    console.error('getAvailabilityMap error:', err);
    return new Map();
  }
}

// getSeasonFixtures now returns the WHOLE season (not just from the active gameweek
// onward, like this used to work), so the current gameweek's own fixture -- if this
// team has one; a blank gameweek means it won't -- has to be picked out explicitly
// with event === gw rather than just being whatever's first in the list. Splitting it
// out into its own `current` field is what lets the frontend show it as a distinct
// pill next to the points tablet instead of it silently occupying one of the two
// "upcoming" slots unlabeled.
//
// Each pill also now carries everything the fixture-detail popup needs when a player
// taps it: kickoff_time/status/scores straight off the fixture row, plus an `opponent`
// object built from teamsMap -- league position/points, this opponent's attack/defence
// strength for the SIDE THEY'RE ACTUALLY PLAYING ON in this fixture (their away
// strength if the player's own team is at home, home strength otherwise -- not a
// blanket "their strength" that ignores venue), and recent form (last 5 results,
// oldest first) computed from every fixture strictly before the active gameweek so
// it's the opponent's form coming INTO this match, not results that include it.
// Labels like "Weak"/"Strong" for the raw strength numbers are left to the frontend,
// same reasoning as difficulty tiers/colors already being a frontend concern -- this
// just supplies the real numbers.
function fixturesForPlayer(fixtures, teamId, gw, teamsMap, teamNames) {
  const toPill = (f) => {
    const isHome = f.team_h === teamId;
    const opponentId = isHome ? f.team_a : f.team_h;
    const opponentTeam = teamsMap[opponentId];
    return {
      gw: f.event,
      opponent_code: clubCode(isHome ? f.team_a_name : f.team_h_name),
      is_home: isHome,
      difficulty: isHome ? f.team_h_difficulty : f.team_a_difficulty,
      kickoff_time: f.kickoff_time || null,
      status: f.status || 'PENDING',
      team_h_score: typeof f.team_h_score === 'number' ? f.team_h_score : null,
      team_a_score: typeof f.team_a_score === 'number' ? f.team_a_score : null,
      opponent: opponentTeam ? {
        name: teamNames[opponentId] || (isHome ? f.team_a_name : f.team_h_name),
        code: clubCode(isHome ? f.team_a_name : f.team_h_name),
        crest: clubCrestUrl(isHome ? f.team_a_name : f.team_h_name),
        position: opponentTeam.position ?? null,
        points: opponentTeam.points ?? null,
        // Opponent is playing AWAY when the player's own team is at home, and vice
        // versa -- these are already the correct venue-side numbers for THIS fixture.
        strength_attack: (isHome ? opponentTeam.strength_attack_away : opponentTeam.strength_attack_home) ?? null,
        strength_defence: (isHome ? opponentTeam.strength_defence_away : opponentTeam.strength_defence_home) ?? null,
        form: recentFormForTeam(fixtures, opponentId, gw)
      } : null
    };
  };
  const teamFixtures = fixtures
    .filter((f) => f.team_h === teamId || f.team_a === teamId)
    .sort((a, b) => a.event - b.event);
  const current = teamFixtures.find((f) => f.event === gw);
  return {
    current: current ? toPill(current) : null,
    fixtures: teamFixtures.filter((f) => f.event > gw).slice(0, 2).map(toPill)
  };
}

// Powers the "click a manager in Standings" squad view: current picks (starters +
// bench) with each player's own club code, hot/cold form tag, and next two fixtures
// with FPL's standard 1-5 difficulty rating. Only supports the current season -- the
// feature is about upcoming form/fixtures, which has no meaning for a past season
// someone's browsing in the season dropdown.
export async function handleManagerSquad(queryParams, corsHeaders) {
  const entryId = parseInt(queryParams.entry_id, 10);
  if (!entryId) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'entry_id is required' }) };
  }

  const season = await getCurrentSeason();
  const { seasonId } = await getCurrentSeasonInfo();
  const requestedGw = queryParams.gw ? parseInt(queryParams.gw, 10) : await getActiveGameweek();
  const { gw, picks } = await resolvePicksForEntry(season, entryId, requestedGw);

  if (!picks || picks.length === 0) {
    const seasonStarted = await hasSeasonStarted();
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        season,
        gameweek: gw,
        players: [],
        reason: seasonStarted ? 'no_data' : 'season_not_started'
      })
    };
  }

  const [formMap, teamNames, teamsMap, fixtures, transferCost, activeChip, availabilityMap] = await Promise.all([
    getFormMap(seasonId, gw),
    getTeamNameMap(seasonId),
    getTeamsMap(seasonId),
    getSeasonFixtures(seasonId),
    getTransferCost(season, gw, entryId),
    getActiveChip(season, entryId, gw),
    getAvailabilityMap()
  ]);

  // Triple Captain (3xc) triples the captain's score instead of the normal double --
  // everyone else's multiplier is unaffected by any chip.
  const captainMultiplier = activeChip === '3xc' ? 3 : 2;

  const players = picks
    .sort((a, b) => a.squad_position - b.squad_position)
    .map((p) => {
      const { current, fixtures: upcoming } = fixturesForPlayer(fixtures, p.player_team, gw, teamsMap, teamNames);
      // Defaults to fully available ('a', no percentages, no news) when the live
      // bootstrap-static fetch failed or this player_id genuinely isn't in it (a data
      // mismatch) -- same "fail open, don't wrongly flag everyone" reasoning as
      // getAvailabilityMap's own fallback.
      const availability = availabilityMap.get(p.player_id) || { status: 'a', chance_of_playing_this_round: null, chance_of_playing_next_round: null, news: null, news_added: null };
      return {
        player_id: p.player_id,
        name: p.player_name,
        position: POSITION_LABELS[p.player_position] || '???',
        team_code: clubCode(teamNames[p.player_team]),
        team_crest: clubCrestUrl(teamNames[p.player_team]),
        squad_position: p.squad_position,
        is_captain: !!p.is_captain,
        is_vice_captain: !!p.is_vice_captain,
        is_bench: !!p.is_bench,
        form: formMap[p.player_id] ?? null,
        form_tag: formTag(formMap[p.player_id]),
        // FPL's own single-letter code: 'a' available, 'd' doubtful, 'i' injured,
        // 's' suspended, 'u' unavailable (e.g. left the club), 'n' not available for
        // some other reason. Frontend treats anything other than 'a' as worth
        // flagging -- see availabilityTier in ManagerSquad.jsx.
        availability_status: availability.status,
        chance_of_playing_this_round: availability.chance_of_playing_this_round,
        chance_of_playing_next_round: availability.chance_of_playing_next_round,
        news: availability.news,
        // This gameweek's own fixture (null on a blank gameweek for this team), shown
        // as its own pill next to the points tablet -- separate from `fixtures` below,
        // which is strictly the two fixtures AFTER this one now that it's split out.
        current_fixture: current,
        fixtures: upcoming,
        // Each player's own raw gameweek score (doubled for the captain, tripled if
        // Triple Captain is active), shown on every card including the bench -- a
        // benched player's real score is exactly what #39 Phase 1 calls "bench points
        // wasted" elsewhere in this app, so it's useful to see here too, not just
        // hidden. What does NOT count is handled separately below (team totals sum
        // starters only, unless Bench Boost is active). Derived from is_captain rather
        // than the stored `multiplier` field -- fpl-data-ingester writes
        // `multiplier: pick.multiplier || 1`, and FPL's bench multiplier is legitimately
        // 0, which that `|| 1` silently coerces back to 1, so it can't be trusted here.
        gw_points: (p.points ?? 0) * (p.is_captain ? captainMultiplier : 1)
      };
    });

  // Gross total for the gameweek: sum of each STARTER's already-multiplied score --
  // UNLESS Bench Boost is active, in which case the bench counts too (that's the whole
  // point of the chip). Now that getActiveChip actually queries fpl_entry_gameweek
  // (previously not fetched at all here), this accounts for it instead of always
  // excluding the bench regardless of chip.
  const teamGwPointsGross = players
    .filter((p) => activeChip === 'bboost' || !p.is_bench)
    .reduce((sum, p) => sum + p.gw_points, 0);

  // Net = gross minus the points lost to any paid transfers ("hits") that gameweek --
  // this is the headline number the squad view shows, matching what "Net Points"
  // already means on the Standings page rather than a second, different definition.
  const teamGwPointsNet = teamGwPointsGross - transferCost;

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      season,
      gameweek: gw,
      entry_id: entryId,
      team_gw_points_gross: teamGwPointsGross,
      team_gw_points_net: teamGwPointsNet,
      transfer_cost: transferCost,
      active_chip: activeChip,
      players
    })
  };
}

// ---- Squad Advisor (GH #44 -- "suggest squad moves using league + global FPL data") ----
// First real (non-mock) piece: a single transfer suggestion. Captain and fixture-
// outlook suggestions are still the hand-written MOCK_ADVISOR content in
// ManagerSquad.jsx's AdvisorModal -- deliberately scoped down to just transfers for
// this pass (direct instruction), not because the other two are harder.

// Full ~700-player pool, live from bootstrap-static -- deliberately NOT read from the
// `players` DynamoDB table (written once a WEEK by fpl-bootstrap), same reasoning as
// getAvailabilityMap above: form/price/ownership/availability can all move daily, and a
// transfer suggestion built on week-old numbers is worse than not suggesting one.
// Returns a Map keyed by element id (== player_id everywhere else in this file) so
// callers can do O(1) lookups for both squad members (to find their OWN price/form)
// and pool candidates. Fails open to an EMPTY map, not a thrown error -- the caller
// (handleSquadAdvisor) treats an empty pool as "can't suggest anything right now"
// rather than a 500, same fail-open convention as every other live bootstrap-static
// read in this file.
async function getFullPlayerPool() {
  try {
    const response = await fetch(`${FPL_API}/bootstrap-static/`, { headers: FPL_FETCH_HEADERS });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const pool = new Map();
    for (const el of data.elements || []) {
      pool.set(el.id, {
        id: el.id,
        web_name: el.web_name,
        team: el.team,
        // FPL's own element_type (1 GKP / 2 DEF / 3 MID / 4 FWD) -- the SAME numeric
        // id already stored as player_position on every fpl_entry_picks row, so no
        // label mapping/reverse-lookup needed to compare a pool candidate's position
        // against a squad player's position.
        element_type: el.element_type,
        // Tenths of a million (FPL's own convention, e.g. 125 = £12.5m) -- kept in
        // this unit throughout the advisor logic, NOT converted to whole £m, since
        // fpl_entry_gameweek's bank/value are the odd one out here (see
        // getBankTenths below, which converts TO this unit instead).
        now_cost: typeof el.now_cost === 'number' ? el.now_cost : null,
        form: el.form,
        selected_by_percent: el.selected_by_percent,
        // FPL's own forward-looking projection for the next gameweek -- used as the
        // primary suggestion signal (see suggestTransfer) precisely because it's
        // forward-looking, unlike `form` which is a backward-looking rolling average.
        ep_next: el.ep_next,
        status: el.status || 'a'
      });
    }
    return pool;
  } catch (err) {
    console.error('getFullPlayerPool error:', err);
    return new Map();
  }
}

// fpl_entry_gameweek.bank is stored in whole £m (fpl-data-ingester's
// storeGameweekSummary divides FPL's raw tenths by 10 before writing it) -- the
// opposite convention from bootstrap-static's now_cost (tenths). Converted back to
// tenths here (rounded, since floating-point £m math like 1.5 * 10 can land on
// 14.999999999998) so every price comparison in this file's advisor logic can stay in
// one consistent unit instead of mixing two. Fails open to 0 (no spare budget) rather
// than throwing -- assuming zero bank on an error is the safe direction: it can only
// make the suggestion MORE conservative (fewer affordable candidates), never suggest
// something the manager genuinely can't afford.
async function getBankTenths(season, entryId, gw) {
  try {
    const result = await dynamodb.send(new QueryCommand({
      TableName: 'fpl_entry_gameweek',
      KeyConditionExpression: 'season_entry = :se AND gameweek = :gw',
      ExpressionAttributeValues: { ':se': `${season}#${entryId}`, ':gw': gw }
    }));
    const bank = result.Items?.[0]?.bank;
    return typeof bank === 'number' ? Math.round(bank * 10) : 0;
  } catch (err) {
    console.error('getBankTenths error:', err);
    return 0;
  }
}

// FPL's own single-letter availability code -> a short, user-facing reason clause.
// Mirrors AVAILABILITY_STATUS_LABEL in ManagerSquad.jsx (kept as a separate constant
// here rather than shared/imported -- this is backend response text, that one's
// frontend UI copy, and they're allowed to drift independently even though they
// currently say the same things).
const AVAILABILITY_REASON = {
  d: 'is a doubt',
  i: 'is injured',
  s: 'is suspended',
  u: 'is unavailable',
  n: 'is not available'
};

// Pure -- no I/O, no DynamoDB/fetch calls -- so this can be unit tested directly
// against hand-built picks/pool fixtures without any mock-fetch/mock-dynamo
// scaffolding. Takes the manager's raw picks (from fpl_entry_picks, NOT the enriched
// `players` array handleManagerSquad builds -- this needs player_id/player_position
// only, both already present on the raw pick rows) plus the live player pool and
// budget, and returns either a real suggestion or a clear "why not" reason -- never
// throws, never returns something silently wrong for the frontend to render as if it
// were a real number.
export function suggestTransfer(picks, poolMap, bankTenths) {
  if (!picks || picks.length === 0 || !poolMap || poolMap.size === 0) {
    return { found: false, reason: 'no_data' };
  }

  // Which of the manager's OWN 15 is the best candidate to transfer OUT. Availability
  // trumps form entirely -- an injured/suspended player who can't even play is a much
  // stronger "get rid of this" signal than merely cold form, so anyone not fully
  // available ('a') is scored far below the worst possible form value, guaranteeing
  // they're picked first if more than one player on the squad has an issue. Among
  // players who ARE all available, plain current form (lower = weaker) breaks the tie.
  // Considers the WHOLE 15, not just starters -- a transfer applies to the whole
  // squad, and an unavailable bench player is just as worth flagging as a starter.
  let outCandidate = null;
  let outScore = Infinity;
  for (const pick of picks) {
    const live = poolMap.get(pick.player_id);
    if (!live) continue; // pool/picks mismatch (stale player_id) -- skip, don't crash
    const available = live.status === 'a';
    const form = parseFloat(live.form);
    const score = available ? (Number.isNaN(form) ? 0 : form) : -1000;
    if (score < outScore) {
      outScore = score;
      outCandidate = { pick, live };
    }
  }
  if (!outCandidate) {
    return { found: false, reason: 'no_data' };
  }

  const ownedIds = new Set(picks.map((p) => p.player_id));
  const outNowCost = outCandidate.live.now_cost ?? 0;
  const budgetCeiling = outNowCost + (bankTenths || 0);

  // Same position, actually available to play, not already on the squad, and
  // affordable with the outgoing player's own price plus whatever's left in the bank
  // -- a "suggestion" the manager can't actually afford isn't useful advice.
  const candidates = [...poolMap.values()].filter((el) =>
    el.element_type === outCandidate.pick.player_position &&
    el.status === 'a' &&
    !ownedIds.has(el.id) &&
    typeof el.now_cost === 'number' &&
    el.now_cost <= budgetCeiling
  );

  if (candidates.length === 0) {
    return {
      found: false,
      reason: 'no_affordable_upgrade',
      out: { player_id: outCandidate.pick.player_id, name: outCandidate.live.web_name }
    };
  }

  // ep_next (forward-looking) weighted above form (backward-looking) rather than
  // either alone -- ep_next is FPL's own next-gameweek projection, the more directly
  // relevant number for "who should I bring in NOW", but it can be a thin, noisy
  // single-gameweek estimate early in a run of fixtures; blending in current form as a
  // secondary signal favors an in-form player over a pure one-gameweek FPL projection
  // when the two disagree, without ignoring the projection entirely.
  const score = (el) => (parseFloat(el.ep_next) || 0) * 2 + (parseFloat(el.form) || 0);
  candidates.sort((a, b) => score(b) - score(a));
  const inCandidate = candidates[0];

  const epOut = parseFloat(outCandidate.live.ep_next) || 0;
  const epIn = parseFloat(inCandidate.ep_next) || 0;
  const deltaPts = Math.round((epIn - epOut) * 10) / 10;

  const priceIn = (inCandidate.now_cost / 10).toFixed(1);
  const priceOut = (outNowCost / 10).toFixed(1);

  const reasonParts = [];
  if (outCandidate.live.status !== 'a') {
    reasonParts.push(`${outCandidate.live.web_name} ${AVAILABILITY_REASON[outCandidate.live.status] || 'is unavailable'}`);
  } else {
    reasonParts.push(`${outCandidate.live.web_name} has cooled off (form ${outCandidate.live.form ?? '0.0'})`);
  }
  reasonParts.push(`${inCandidate.web_name} is projected ${epIn.toFixed(1)} pts next gameweek at £${priceIn}m, vs £${priceOut}m for ${outCandidate.live.web_name}`);

  return {
    found: true,
    out: {
      player_id: outCandidate.pick.player_id,
      name: outCandidate.live.web_name,
      price: Number(priceOut),
      form: outCandidate.live.form ?? null,
      ep_next: epOut,
      availability_status: outCandidate.live.status
    },
    in: {
      player_id: inCandidate.id,
      name: inCandidate.web_name,
      price: Number(priceIn),
      form: inCandidate.form ?? null,
      ep_next: epIn
    },
    delta_pts: deltaPts,
    reason: reasonParts.join('. ') + '.'
  };
}

// Powers the Advisor modal's real transfer suggestion (see AdvisorModal in
// ManagerSquad.jsx). Deliberately a SEPARATE endpoint from /manager-squad rather than
// an extra field bolted onto that response -- the advisor needs its own live
// bootstrap-static fetch (full player pool, not just this manager's 15) and its own
// fpl_entry_gameweek query (bank), neither of which the plain squad view needs, so
// folding them in would make every ordinary squad-view load pay for work only the
// advisor modal actually uses.
export async function handleSquadAdvisor(queryParams, corsHeaders) {
  const entryId = parseInt(queryParams.entry_id, 10);
  if (!entryId) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'entry_id is required' }) };
  }

  const season = await getCurrentSeason();
  const requestedGw = queryParams.gw ? parseInt(queryParams.gw, 10) : await getActiveGameweek();
  const { gw, picks } = await resolvePicksForEntry(season, entryId, requestedGw);

  if (!picks || picks.length === 0) {
    const seasonStarted = await hasSeasonStarted();
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        season,
        gameweek: gw,
        entry_id: entryId,
        transfer: { found: false, reason: seasonStarted ? 'no_data' : 'season_not_started' }
      })
    };
  }

  const [poolMap, bankTenths] = await Promise.all([
    getFullPlayerPool(),
    getBankTenths(season, entryId, gw)
  ]);

  const transfer = suggestTransfer(picks, poolMap, bankTenths);

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ season, gameweek: gw, entry_id: entryId, transfer })
  };
}
