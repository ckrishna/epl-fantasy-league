import { getAllGwRows, normName } from '../utils/trends-data.mjs';
import { getCurrentSeason, getActiveGameweek, queryLeagueStandings } from '../utils/dynamodb.mjs';

// Reference gameweek for the "hot start vs strong finish" comparison -- arbitrary but
// consistent, chosen because GW10 is far enough in that early-season noise has settled
// a bit, and early enough that most seasons (even ones that ended early/were disrupted)
// have data for it.
const MID_SEASON_GAMEWEEK = 10;

// Powers the manager picker on the Trends tab. WHO'S CURRENTLY IN THE LEAGUE, and
// their team/nickname, both come straight from fpl_league_standings via the same
// source and walk-back logic handleStandings() already uses for its "current season,
// no gw param" default view -- queryLeagueStandings(), which the ingester populates
// from the live FPL roster on every run (including a snapshot before a season's first
// real gameweek, so this is populated even pre-season).
//
// Deliberately NOT joined against fpl_entry_gameweek at all (an earlier version of
// this function was): that table only has a row once a manager has actually played a
// gameweek, so a manager who's brand new to the league this season -- in the roster,
// but with zero gameweek history anywhere -- would never get an entry if the list were
// built by walking fpl_entry_gameweek and merely checking roster membership. Caught
// live: a new 2026/27 joiner was correctly excluded from `currentNames` filtering logic
// but never made it into the output at all, since nothing ever created a Map entry for
// them. fpl_league_standings already carries both team_name and manager_name directly
// (the ingester writes both), so it's a sufficient source on its own -- no join needed.
export async function handleTrendsManagers(corsHeaders) {
  const currentSeason = await getCurrentSeason();

  let gw = await getActiveGameweek();
  let standings = await queryLeagueStandings(gw, currentSeason);
  while ((!standings || standings.length === 0) && gw > 1) {
    gw -= 1;
    standings = await queryLeagueStandings(gw, currentSeason);
  }

  const managers = (standings || [])
    .map((s) => ({ team_name: normName(s.team_name), manager_name: s.manager_name || null }))
    .filter((m) => m.team_name)
    .sort((a, b) => a.team_name.localeCompare(b.team_name));

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ managers })
  };
}

// Ranks `requestedName` among everyone who has a row at that exact (season, gameweek),
// by points_total (cumulative net points-to-date) descending. Returns null rather than
// guessing if either the gameweek or the manager isn't present in it.
function rankAt(bySeasonGw, requestedName, season, gameweek) {
  const rows = bySeasonGw.get(season)?.get(gameweek);
  if (!rows || rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => (b.points_total || 0) - (a.points_total || 0));
  const idx = sorted.findIndex((r) => normName(r.team_name) === requestedName);
  return idx === -1 ? null : idx + 1;
}

// Whoever had the most cumulative points at that exact (season, gameweek) -- used to
// compute "how far behind the season winner did you finish" at a season's final
// gameweek. Returns null under the same conditions rankAt does (nothing recorded for
// that gameweek), so a missing value reads as "unknown" rather than a false 0-point gap.
function leaderPointsAt(bySeasonGw, season, gameweek) {
  const rows = bySeasonGw.get(season)?.get(gameweek);
  if (!rows || rows.length === 0) return null;
  return Math.max(...rows.map((r) => r.points_total || 0));
}

export async function handleTrends(queryParams, corsHeaders) {
  const requestedName = normName(queryParams.manager || '');
  if (!requestedName) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'manager query param is required' })
    };
  }

  const [allRows, currentSeason] = await Promise.all([getAllGwRows(), getCurrentSeason()]);

  const managerRows = allRows.filter((r) => normName(r.team_name) === requestedName);
  if (managerRows.length === 0) {
    return {
      statusCode: 404,
      headers: corsHeaders,
      body: JSON.stringify({ error: `No data found for "${requestedName}"` })
    };
  }

  const managerName = managerRows.find((r) => r.manager_name)?.manager_name || null;

  // Index EVERY manager's rows by season -> gameweek, so rankAt() can compare this
  // manager against their peers at any point in any season.
  const bySeasonGw = new Map();
  for (const row of allRows) {
    if (!bySeasonGw.has(row.season)) bySeasonGw.set(row.season, new Map());
    const gwMap = bySeasonGw.get(row.season);
    if (!gwMap.has(row.gameweek)) gwMap.set(row.gameweek, []);
    gwMap.get(row.gameweek).push(row);
  }

  // This manager's own rows, grouped by season and sorted by gameweek ascending.
  const bySeason = new Map();
  for (const row of managerRows) {
    if (!bySeason.has(row.season)) bySeason.set(row.season, []);
    bySeason.get(row.season).push(row);
  }
  for (const seasonRows of bySeason.values()) {
    seasonRows.sort((a, b) => a.gameweek - b.gameweek);
  }

  // Season strings are "YYYY/YY" -- lexicographic sort already matches chronological
  // order (same convention TARGET_SEASONS in import-historical-seasons.mjs relies on).
  const seasons = [...bySeason.entries()]
    .map(([season, seasonRows]) => {
      const finalRow = seasonRows[seasonRows.length - 1];
      const midRow = seasonRows.find((r) => r.gameweek === MID_SEASON_GAMEWEEK);
      const leaderPoints = leaderPointsAt(bySeasonGw, season, finalRow.gameweek);
      return {
        season,
        is_current: season === currentSeason,
        final_gameweek: finalRow.gameweek,
        final_points: finalRow.points_total,
        final_rank: rankAt(bySeasonGw, requestedName, season, finalRow.gameweek),
        mid_gameweek: MID_SEASON_GAMEWEEK,
        mid_rank: midRow ? rankAt(bySeasonGw, requestedName, season, MID_SEASON_GAMEWEEK) : null,
        // Rounded to 1 decimal -- final_points is already net (gross minus hits), so
        // this reads as "average net points per gameweek" matching every other net
        // figure this app shows, not a second gross-based average.
        avg_points_per_gw: finalRow.gameweek > 0
          ? Math.round((finalRow.points_total / finalRow.gameweek) * 10) / 10
          : null,
        // Points behind whoever actually won that season (0 if this manager was the
        // winner). Null rather than 0 if the season's final gameweek has no data at
        // all for anyone -- an absent value, not a false "tied for first".
        gap_to_first: leaderPoints !== null ? leaderPoints - finalRow.points_total : null,
        // Sum of every gameweek's transfer_cost that season -- points given up to paid
        // ("hit") transfers, not a count of transfers made. Same field Standings/GW
        // Winners already read per-gameweek, just totaled across the season here.
        total_transfer_cost: seasonRows.reduce((sum, r) => sum + (r.transfer_cost || 0), 0)
      };
    })
    .sort((a, b) => a.season.localeCompare(b.season));

  const currentSeasonRows = bySeason.get(currentSeason) || [];
  const currentGameweek = currentSeasonRows.length > 0
    ? Math.max(...currentSeasonRows.map((r) => r.gameweek))
    : null;

  const thisSeasonPace = currentSeasonRows.map((r) => ({ gameweek: r.gameweek, points: r.points_total }));

  // Historical envelope: for every OTHER season this manager has data for, look up
  // their cumulative points at each gameweek number, then fold those into a per-GW
  // average/min/max -- aligned by gameweek number, not calendar date, since that's
  // what "ahead of/behind your usual pace" actually means.
  const historicalSeasons = [...bySeason.entries()].filter(([season]) => season !== currentSeason);
  const maxGw = historicalSeasons.length > 0
    ? Math.max(...historicalSeasons.flatMap(([, seasonRows]) => seasonRows.map((r) => r.gameweek)))
    : 0;

  const historyEnvelope = [];
  for (let gw = 1; gw <= maxGw; gw++) {
    const valuesAtGw = historicalSeasons
      .map(([, seasonRows]) => seasonRows.find((r) => r.gameweek === gw)?.points_total)
      .filter((v) => typeof v === 'number');
    if (valuesAtGw.length === 0) continue;
    historyEnvelope.push({
      gameweek: gw,
      avg: Math.round(valuesAtGw.reduce((a, b) => a + b, 0) / valuesAtGw.length),
      min: Math.min(...valuesAtGw),
      max: Math.max(...valuesAtGw)
    });
  }

  const envelopeAtCurrentGw = currentGameweek
    ? historyEnvelope.find((e) => e.gameweek === currentGameweek) || null
    : null;
  const thisSeasonAtCurrentGw = currentGameweek
    ? (currentSeasonRows.find((r) => r.gameweek === currentGameweek)?.points_total ?? null)
    : null;

  const atCurrentGw = (envelopeAtCurrentGw && thisSeasonAtCurrentGw !== null)
    ? {
        this_season: thisSeasonAtCurrentGw,
        avg: envelopeAtCurrentGw.avg,
        min: envelopeAtCurrentGw.min,
        max: envelopeAtCurrentGw.max,
        diff: thisSeasonAtCurrentGw - envelopeAtCurrentGw.avg
      }
    : null;

  // "Vs the field" worm graph: every manager's cumulative points by gameweek, for the
  // CURRENT season only (unlike pace/seasons above, which deliberately span every
  // season on record). Reuses the same bySeasonGw index already built for ranking, so
  // no extra scan or pass over allRows is needed.
  const field = [];
  const currentSeasonAllRows = bySeasonGw.get(currentSeason);
  if (currentSeasonAllRows) {
    const byManager = new Map(); // normalized name -> { team_name, manager_name, points: Map(gw -> points_total) }
    for (const [gw, rowsAtGw] of currentSeasonAllRows) {
      for (const row of rowsAtGw) {
        const key = normName(row.team_name);
        if (!byManager.has(key)) {
          byManager.set(key, { team_name: key, manager_name: row.manager_name || null, points: new Map() });
        }
        const entry = byManager.get(key);
        if (!entry.manager_name && row.manager_name) entry.manager_name = row.manager_name;
        entry.points.set(gw, row.points_total);
      }
    }

    // Leader = whoever has the most points at the current gameweek specifically (not
    // just whoever's ahead on some other week) -- matches what "leader" means anywhere
    // else in this app.
    let leaderKey = null;
    let leaderPoints = -Infinity;
    if (currentGameweek) {
      for (const [key, entry] of byManager) {
        const pts = entry.points.get(currentGameweek);
        if (typeof pts === 'number' && pts > leaderPoints) {
          leaderPoints = pts;
          leaderKey = key;
        }
      }
    }

    for (const [key, entry] of byManager) {
      field.push({
        team_name: entry.team_name,
        manager_name: entry.manager_name,
        is_you: key === requestedName,
        // If the requested manager IS the leader, only is_you should read true -- the
        // frontend highlights on is_you OR is_leader, and a manager only needs one
        // highlighted line even when both are true.
        is_leader: key !== requestedName && key === leaderKey,
        points: [...entry.points.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([gameweek, points]) => ({ gameweek, points }))
      });
    }
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      manager: { team_name: requestedName, manager_name: managerName },
      current_season: currentSeason,
      current_gameweek: currentGameweek,
      pace: {
        this_season: thisSeasonPace,
        history_envelope: historyEnvelope,
        at_current_gw: atCurrentGw
      },
      seasons,
      field
    })
  };
}
