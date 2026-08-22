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
  'West Ham': { short: 'WHU', code: 21 }, 'Wolves': { short: 'WOL', code: 39 }
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
  let gw = queryParams.gw ? parseInt(queryParams.gw, 10) : await getActiveGameweek();

  let picks = await getPicksForGW(season, entryId, gw);
  while ((!picks || picks.length === 0) && gw > 1) {
    gw -= 1;
    picks = await getPicksForGW(season, entryId, gw);
  }

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

  const [formMap, teamNames, teamsMap, fixtures, transferCost, activeChip] = await Promise.all([
    getFormMap(seasonId, gw),
    getTeamNameMap(seasonId),
    getTeamsMap(seasonId),
    getSeasonFixtures(seasonId),
    getTransferCost(season, gw, entryId),
    getActiveChip(season, entryId, gw)
  ]);

  // Triple Captain (3xc) triples the captain's score instead of the normal double --
  // everyone else's multiplier is unaffected by any chip.
  const captainMultiplier = activeChip === '3xc' ? 3 : 2;

  const players = picks
    .sort((a, b) => a.squad_position - b.squad_position)
    .map((p) => {
      const { current, fixtures: upcoming } = fixturesForPlayer(fixtures, p.player_team, gw, teamsMap, teamNames);
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
