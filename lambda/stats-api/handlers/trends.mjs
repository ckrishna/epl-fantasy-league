import { getAllGwRows, normName } from '../utils/trends-data.mjs';
import { getCurrentSeason } from '../utils/dynamodb.mjs';

// Reference gameweek for the "hot start vs strong finish" comparison -- arbitrary but
// consistent, chosen because GW10 is far enough in that early-season noise has settled
// a bit, and early enough that most seasons (even ones that ended early/were disrupted)
// have data for it.
const MID_SEASON_GAMEWEEK = 10;

// Powers the manager picker on the Trends tab. Built from fpl_entry_gameweek directly
// (not a dedicated "managers" table -- there isn't one) so it reflects exactly who has
// data, historical or live, with no separate list to keep in sync.
export async function handleTrendsManagers(corsHeaders) {
  const rows = await getAllGwRows();

  const byName = new Map();
  for (const row of rows) {
    const name = normName(row.team_name);
    if (!name) continue;
    if (!byName.has(name)) {
      byName.set(name, { team_name: name, manager_name: row.manager_name || null });
    } else if (!byName.get(name).manager_name && row.manager_name) {
      byName.get(name).manager_name = row.manager_name;
    }
  }

  const managers = [...byName.values()].sort((a, b) => a.team_name.localeCompare(b.team_name));

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
      return {
        season,
        is_current: season === currentSeason,
        final_gameweek: finalRow.gameweek,
        final_points: finalRow.points_total,
        final_rank: rankAt(bySeasonGw, requestedName, season, finalRow.gameweek),
        mid_gameweek: MID_SEASON_GAMEWEEK,
        mid_rank: midRow ? rankAt(bySeasonGw, requestedName, season, MID_SEASON_GAMEWEEK) : null
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
      seasons
    })
  };
}
