import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }));
const FPL_API = 'https://fantasy.premierleague.com/api';

// Structured logging
const logger = {
  info: (msg, data = {}) => console.log(JSON.stringify({ level: 'INFO', timestamp: new Date().toISOString(), msg, ...data })),
  error: (msg, err = {}) => console.error(JSON.stringify({ level: 'ERROR', timestamp: new Date().toISOString(), msg, error: err.message })),
  metric: (name, value, unit = '') => console.log(JSON.stringify({ level: 'METRIC', timestamp: new Date().toISOString(), metric: name, value, unit }))
};

// Writes one row per invocation to ingestion_runs -- see fpl-bootstrap/index.mjs for
// the full rationale. `trigger` is derived from the Lambda event shape: EventBridge's
// scheduled invocations always carry `source: "aws.events"` (this is the
// `fpl-nightly-pull` rule specifically for this function) -- UNLESS the rule specifies
// a custom Input JSON (as the hourly live-check rule does, to pass the `mode` flag
// used below), in which case that custom JSON *completely replaces* the event
// EventBridge would otherwise send, `source` included. The live-check rule's Input
// must therefore explicitly include `"source": "aws.events"` itself, or every one of
// its runs would silently misreport as `trigger: "manual"` in ingestion_runs. See
// scripts/automate_fpl_livecheck_hourly.sh for where that's set (same gotcha,
// documented the same way, in lambda/fpl-global-stats-weekly/index.mjs).
async function recordIngestionRun({ event, startedAt, status, season, summary, errorMessage }) {
  try {
    await dynamodb.send(new PutCommand({
      TableName: 'ingestion_runs',
      Item: {
        function_name: 'fpl-data-ingester',
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - new Date(startedAt).getTime(),
        status,
        trigger: event?.source === 'aws.events' ? 'scheduled' : 'manual',
        season: season ?? null,
        summary: summary ?? {},
        error_message: errorMessage ?? null
      }
    }));
  } catch (err) {
    logger.error('Failed to record ingestion_runs entry', err);
  }
}

// Resolves the currently active season (and its league ID) from the shared `seasons`
// table -- the same pattern already used by fpl-bootstrap, fpl-global-stats-weekly,
// and the GenBI handler. Previously `season` was a hardcoded `const SEASON = '2025/26'`
// and `league_id` was a hardcoded `const LEAGUE_ID = ...`, neither of which anything
// would remind you to update. The real league ID already changed once (212889 ->
// 438107 for 2026/27, confirmed live 2026-07-30) and required a code change +
// redeploy to fix -- moving it here means the next change is just a data update.
// NOTE: the `seasons` table has two different season fields -- `season_id` (a numeric
// internal ID used to tag reference tables like `teams`/`players`/`events` in the
// fpl-bootstrap lambda, and now also `live_player_event_stats` below) and
// `season_string` (the human-readable "2025/26" used as the partition-key prefix for
// league tables like `fpl_entry_gameweek`). Both live on the same row, so returning
// both here is free -- callers just need to remember which family they're writing to.
async function getCurrentSeasonInfo() {
  const result = await dynamodb.send(new ScanCommand({
    TableName: 'seasons',
    FilterExpression: '#c = :curr',
    ExpressionAttributeNames: { '#c': 'current' },
    ExpressionAttributeValues: { ':curr': true }
  }));
  if (!result.Items || result.Items.length === 0) {
    throw new Error('No current season found in seasons table');
  }
  const item = result.Items[0];
  if (item.league_id === undefined || item.league_id === null) {
    throw new Error(`Current season row (${item.season_string}) has no league_id set -- add it to the ` +
      `seasons table before running the ingester.`);
  }
  return { season: item.season_string, seasonId: item.season_id, leagueId: item.league_id };
}

async function getLeagueManagers(leagueId) {
  const startTime = Date.now();
  try {
    const response = await fetch(`${FPL_API}/leagues-classic/${leagueId}/standings/`, {
     headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    // FPL's classic-league API splits members into two buckets: `standings.results`
    // (established members -- appears to require at least one scored gameweek before
    // FPL merges someone in) and `new_entries.results` (just-joined managers not yet
    // merged). For a brand-new league, standings.results is a genuinely empty array
    // -- not missing, just empty -- so this used to silently report 0 managers despite
    // real members existing (caught live on 2026-07-30 with the new 2026/27 league,
    // id 438107: https://fantasy.premierleague.com/api/leagues-classic/438107/standings/).
    // Prefer standings.results whenever it has anyone in it; only fall back to
    // new_entries when standings is empty.
    const standingsResults = data.standings?.results;
    const newEntriesResults = data.new_entries?.results;

    let results;
    let source;
    if (Array.isArray(standingsResults) && standingsResults.length > 0) {
      results = standingsResults;
      source = 'standings';
    } else if (Array.isArray(newEntriesResults) && newEntriesResults.length > 0) {
      results = newEntriesResults;
      source = 'new_entries';
    } else if (Array.isArray(standingsResults) || Array.isArray(newEntriesResults)) {
      // Both present but genuinely empty -- nobody has joined yet, not an error.
      results = [];
      source = 'none';
    } else {
      throw new Error('Invalid response: missing both standings.results and new_entries.results');
    }

    const managers = results.map(m => ({
      entry_id: m.entry,
      // real_name/team_nickname (renamed 2026-08-14 from team_name/manager_name --
      // see DATA_MODEL.md's identity redesign notes on the naming-inversion fix).
      // FPL's own `entry_name` field is the squad NICKNAME; player_name (or
      // player_first_name + player_last_name on the new_entries shape) is the
      // manager's REAL name.
      team_nickname: m.entry_name,
      real_name: source === 'new_entries' ? `${m.player_first_name} ${m.player_last_name}`.trim() : m.player_name
    }));

    logger.info('Fetched league managers', { count: managers.length, source, duration_ms: Date.now() - startTime });
    return managers;
  } catch (err) {
    logger.error('Failed to fetch league managers', err);
    throw err;
  }
}

// Resolves every league this ingestion run needs to cover (task #48) -- not just the
// season's single primary league_id. primaryLeagueId (Carpe Diem, from the `seasons`
// table) is always included even though it was never "registered" via
// scripts/add-league.mjs -- it's the original, implicit default this whole schema was
// built around, not a second-class citizen among registered leagues. Anything else
// comes from the `leagues` table (see league-validation.mjs/add-league.mjs in
// stats-api), scoped to this season and status 'active'.
//
// Falls back to just [primaryLeagueId] on any failure reading `leagues` -- a
// registration-table hiccup should degrade to "ingest what we always ingested", not
// take down the whole run.
async function getRegisteredLeagueIds(season, primaryLeagueId) {
  try {
    const result = await dynamodb.send(new ScanCommand({
      TableName: 'leagues',
      FilterExpression: 'season_string = :s AND #st = :active',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':s': season, ':active': 'active' }
    }));
    const registered = (result.Items || []).map((item) => item.league_id);
    return Array.from(new Set([primaryLeagueId, ...registered]));
  } catch (err) {
    logger.error('Failed to fetch registered leagues, falling back to primary league only', err);
    return [primaryLeagueId];
  }
}

// Computes today's live-fixture window from OUR OWN already-ingested fpl_fixture_data
// -- a local DynamoDB Scan, zero FPL API calls -- so the hourly live-check rule (see
// the `mode === 'live-check'` gate in the handler below) can decide whether to bother
// running at all before it ever touches FPL's API. Window is [earliest kickoff today +
// 30 min, latest kickoff today + 4 hours]: the 30-minute head start avoids checking
// before any game has even kicked off, and the 4-hour tail covers a ~105-minute match
// plus the 1-2 hour lag before FPL finalizes bonus points, so even the last match of
// the day has time to settle before the window closes. Returns null if there are no
// fixtures today at all (the common case most days).
//
// fpl_fixture_data's partition key is season_fixture ("{season_id}#{fixture_id}"), not
// something a Query can range over by date -- but the table is tiny (385 items for a
// full season), so a Scan filtered by season_id is cheap and simpler than adding a GSI
// just for this.
//
// Fails OPEN, not closed: if the scan itself errors, this returns an always-passes
// window rather than silently skipping what might be a real game day -- same
// resilience convention used everywhere else in this codebase (see
// getAvailabilityMap in stats-api for another example). A live-check run that
// couldn't determine the window just behaves like a normal, ungated run instead.
async function getTodaysFixtureWindow(seasonId) {
  try {
    const result = await dynamodb.send(new ScanCommand({
      TableName: 'fpl_fixture_data',
      FilterExpression: 'season_id = :sid',
      ExpressionAttributeValues: { ':sid': seasonId }
    }));

    const todayStr = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD', UTC
    const todaysKickoffs = (result.Items || [])
      .map((item) => item.kickoff_time)
      .filter((kt) => typeof kt === 'string' && kt.slice(0, 10) === todayStr)
      .map((kt) => new Date(kt).getTime())
      .filter((t) => !Number.isNaN(t));

    if (todaysKickoffs.length === 0) return null;

    const earliest = Math.min(...todaysKickoffs);
    const latest = Math.max(...todaysKickoffs);
    return {
      start: earliest + 30 * 60 * 1000,
      end: latest + 4 * 60 * 60 * 1000
    };
  } catch (err) {
    logger.error('Failed to compute today\'s fixture window -- failing open, will run normally', err);
    return { start: -Infinity, end: Infinity };
  }
}

async function getBootstrapStatic() {
  const startTime = Date.now();
  try {
const response = await fetch(`${FPL_API}/bootstrap-static/`, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  }
});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    
    logger.info('Fetched bootstrap data', { 
      players: data.elements?.length || 0,
      gameweeks: data.events?.length || 0,
      duration_ms: Date.now() - startTime 
    });
    return data;
  } catch (err) {
    logger.error('Failed to fetch bootstrap', err);
    throw err;
  }
}

// Returns { data, status } instead of just the parsed body -- a bare `null` used to
// mean both "FPL says this manager genuinely has no picks yet" (a normal 404, e.g. a
// manager who joined mid-season) AND "FPL is rejecting/erroring on this request" (429
// rate-limited, or a 5xx), with zero way for the caller to tell them apart. That
// silently swallowed real rate-limit hits as if they were routine empty results (see
// DATA_MODEL.md's ingester rate-limit-visibility notes, 2026-08-15).
//
// Retries ONCE on a 429 after a short backoff -- a single manager getting rate-limited
// shouldn't have to wait for the next scheduled run to recover. Nothing else is
// retried: a 404 is FPL's normal, expected "nothing here yet" response, and retrying a
// persistent 5xx would just burn time without fixing anything.
async function getManagerPicksForGW(entryId, gw, { retryOn429 = true } = {}) {
  try {
    const response = await fetch(`${FPL_API}/entry/${entryId}/event/${gw}/picks/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (response.status === 429 && retryOn429) {
      logger.error('Rate limited fetching picks, retrying once', { entry_id: entryId, gw });
      await new Promise(resolve => setTimeout(resolve, 5000));
      return getManagerPicksForGW(entryId, gw, { retryOn429: false });
    }

    if (!response.ok) return { data: null, status: response.status };
    const data = await response.json();
    return { data, status: response.status };
  } catch (err) {
    logger.error(`Failed to fetch picks for entry ${entryId} GW ${gw}`, err);
    return { data: null, status: null };
  }
}

// Persists the FULL per-player detail FPL's live endpoint returns (minutes, goals,
// assists, bonus, bps, ICT components, expected-stats, dreamteam/played flags) --
// getLiveGameweekStats below used to throw all of this away and keep only
// total_points, which is all our own manager-points math needs. Everything else is
// genuinely useful (GenBI player context, GH issue #24 "live_player_event_stats never
// got an ingestion Lambda") and costs nothing extra to capture, since the API call
// already happened for the points -- this is a pure side effect on data already in
// hand, not a new fetch.
//
// Field names (other than the key) deliberately mirror `player_event_stats` (the
// weekly-authoritative table fpl-global-stats-weekly writes from a completely
// different endpoint, `element-summary`) so the two are easy to compare. This table is
// the fresher-but-provisional view during/shortly after a gameweek; player_event_stats
// remains the long-term authoritative one once that weekly job catches up and
// overwrites with FPL's fully-settled values. `bonus_finalized` (from the live
// response's top-level `modified` flag) lets a reader tell "still live" apart from
// "FPL has confirmed bonus" without needing to reason about kickoff/full-time timing
// itself.
//
// Sort key is `gw_player_timestamp` (S, "{gw}#{player_id}#{ISO timestamp}") -- NOT
// gameweek_player as an earlier version of this comment assumed. The table already
// existed (created 2026-02-17, before this Lambda was ever written) with that exact
// key shape, confirmed live via `aws dynamodb describe-table` on 2026-08-23: someone
// had already built the time-series design GH issue #24 describes ("Key format:
// season_id#gameweek#player_id + timestamp SK", "keep last 24 hours only"), just never
// wrote the Lambda to populate it. So this is deliberately APPEND-only -- every run
// adds new snapshot rows rather than overwriting the last one -- which also means it
// naturally captures how a player's bonus/bps evolve over the course of a live match,
// not just their current value. `ttl` (epoch seconds, now + 24h) is set on every item
// so DynamoDB's own TTL can auto-expire old snapshots once enabled on the table (see
// DATA_MODEL.md) -- keeps this bounded regardless of how often the ingester runs.
// Keyed by `season_id` (numeric), matching player_event_stats' own convention for this
// reference-table family -- NOT `season_string`, see getCurrentSeasonInfo's note on
// the two season fields.
async function storeLiveGameweekPlayerStats(gw, seasonId, elements, playerMap, teamMap, positionMap) {
  if (!seasonId) {
    logger.error('storeLiveGameweekPlayerStats skipped: no seasonId resolved', {});
    return;
  }

  // Shared by every item in this run so a single ingestion run produces one coherent
  // snapshot (same instant across all ~700 players) rather than a slightly different
  // timestamp per item.
  const snapshotTime = new Date();
  const snapshotIso = snapshotTime.toISOString();
  const ttl = Math.floor(snapshotTime.getTime() / 1000) + 24 * 60 * 60;

  const batch = [];
  for (const el of elements) {
    const stats = el.stats || {};
    const player = playerMap ? playerMap[el.id] : null;

    batch.push({
      PutRequest: {
        Item: {
          season_id: seasonId,
          gw_player_timestamp: `${gw}#${el.id}#${snapshotIso}`,
          player_id: el.id,
          gameweek: gw,
          name: player ? player.web_name : 'Unknown',
          team_id: player ? player.team : null,
          team_name: player ? ((teamMap && teamMap[player.team]) || '') : '',
          position: player ? ((positionMap && positionMap[player.element_type]) || '') : '',
          now_cost: player ? (player.now_cost || 0) : 0,
          total_points: stats.total_points || 0,
          minutes: stats.minutes || 0,
          goals_scored: stats.goals_scored || 0,
          assists: stats.assists || 0,
          clean_sheets: stats.clean_sheets || 0,
          goals_conceded: stats.goals_conceded || 0,
          own_goals: stats.own_goals || 0,
          penalties_saved: stats.penalties_saved || 0,
          penalties_missed: stats.penalties_missed || 0,
          yellow_cards: stats.yellow_cards || 0,
          red_cards: stats.red_cards || 0,
          saves: stats.saves || 0,
          bonus: stats.bonus || 0,
          bps: stats.bps || 0,
          influence: stats.influence || '0',
          creativity: stats.creativity || '0',
          threat: stats.threat || '0',
          ict_index: stats.ict_index || '0',
          clearances_blocks_interceptions: stats.clearances_blocks_interceptions || 0,
          recoveries: stats.recoveries || 0,
          tackles: stats.tackles || 0,
          defensive_contribution: stats.defensive_contribution || 0,
          starts: stats.starts || 0,
          expected_goals: stats.expected_goals || '0',
          expected_assists: stats.expected_assists || '0',
          expected_goal_involvements: stats.expected_goal_involvements || '0',
          expected_goals_conceded: stats.expected_goals_conceded || '0',
          in_dreamteam: stats.in_dreamteam || false,
          played: stats.played || false,
          bonus_finalized: el.modified || false,
          selected_by_percent: player ? (player.selected_by_percent || 0) : 0,
          form: player ? (player.form || 0) : 0,
          ttl,
          last_synced: snapshotIso
        }
      }
    });
  }

  for (let i = 0; i < batch.length; i += 25) {
    try {
      await dynamodb.send(new BatchWriteCommand({
        RequestItems: { 'live_player_event_stats': batch.slice(i, i + 25) }
      }));
    } catch (err) {
      logger.error('Failed to store live_player_event_stats batch', err);
    }
  }

  logger.metric('live_player_event_stats_stored', batch.length, 'players');
}

// FPL's `/entry/{id}/event/{gw}/picks/` endpoint -- the one storePicks() reads from --
// never includes a per-pick `points` field. It only ever has `element`, `position`,
// `multiplier`, `is_captain`, `is_vice_captain`. Per-player gameweek points live on a
// completely different endpoint, keyed by player element ID, not by manager. Reading
// `pick.points` (as storePicks used to) is *always* undefined, so `pick.points || 0`
// silently wrote 0 for every single pick, every gameweek, since this table's inception
// -- confirmed against live data for both GW20 and GW38 of 2025/26 (every one of 3,144
// scanned rows had points: 0). This is a single per-gameweek fetch (not per-manager),
// so it's called once per gameweek in gwsToFetch, not once per manager per gameweek.
//
// `liveContext` (seasonId/playerMap/teamMap/positionMap) is optional and only used for
// the storeLiveGameweekPlayerStats side effect above -- callers that don't pass it
// (e.g. older/simpler tests) still get the points-only behavior this function always
// had.
async function getLiveGameweekStats(gw, liveContext = {}) {
  try {
    const response = await fetch(`${FPL_API}/event/${gw}/live/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    const pointsByElement = new Map();
    for (const el of data.elements || []) {
      pointsByElement.set(el.id, el.stats?.total_points || 0);
    }

    const { seasonId, playerMap, teamMap, positionMap } = liveContext;
    if (seasonId) {
      await storeLiveGameweekPlayerStats(gw, seasonId, data.elements || [], playerMap, teamMap, positionMap);
    }

    return pointsByElement;
  } catch (err) {
    logger.error(`Failed to fetch live stats for GW ${gw}`, err);
    // Empty map -- storePicks falls back to 0 per pick, same as the pre-fix behavior,
    // rather than failing the whole ingestion run over one gameweek's live-stats call.
    return new Map();
  }
}

async function storeGameweekSummary(manager, picksData, gw, season, livePoints = new Map()) {
  const entryHistory = picksData.entry_history;

  // active_chip lives on the TOP-LEVEL picks response (picksData.active_chip), read
  // here (not just down in the `item` below) because the live-points computation right
  // below ALSO needs to know it -- see the pointsThisWeek comment.
  const activeChip = picksData.active_chip || null;

  // entryHistory.points/total_points come from FPL's own per-entry "picks" endpoint,
  // which does NOT update live during a match -- confirmed live on 2026-08-21 (GW1
  // kickoff day): entry_history.points sat at 0 for over 40 minutes into a match in
  // which this entry's captain had already scored and picked up bonus points, while
  // FPL's separate per-player `/event/{gw}/live/` endpoint (the same one
  // getLiveGameweekStats/livePoints already pulls, and that storePicks below already
  // uses for fpl_entry_picks.points) had the goal recorded within a couple of minutes
  // of it happening. FPL only rolls entry_history up later (after full-time, sometimes
  // only once bonus points are finalized) -- so any table sourced from entry_history
  // alone (fpl_league_standings, gw-winners-cache, both downstream of this function's
  // output) would show 0 for an entire live gameweek even as the Manager Squad view
  // (which reads fpl_entry_picks.points directly) already shows the real score. Fixed
  // by computing the gameweek score ourselves from the same live per-player feed,
  // exactly the way handleManagerSquad already does (team_gw_points_gross): sum each
  // STARTER's live points, doubled for the captain, bench excluded. This makes
  // Standings/GW-Winners agree with Manager Squad in real time instead of only after
  // FPL finishes its own rollup.
  //
  // Chip-aware as of the fix below -- confirmed live 2026-08-22 (GW1, entry 1836232,
  // "Da Movement"): FPL's own app showed 56 points with Bench Boost active, while this
  // function's un-chip-aware version (bench always excluded, captain always just
  // doubled) computed 34 -- a 22-point undercount exactly matching that entry's bench
  // contribution. Bench Boost counts the bench too; Triple Captain triples the
  // captain instead of doubling -- both already handled correctly in
  // handleManagerSquad, just missing here until now.
  const captainMultiplier = activeChip === '3xc' ? 3 : 2;
  const pointsThisWeek = picksData.picks
    .filter((p) => activeChip === 'bboost' || p.position <= 11)
    .reduce((sum, p) => sum + (livePoints.get(p.element) ?? 0) * (p.is_captain ? captainMultiplier : 1), 0);

  // total_points (season cumulative) has the same lag baked in, since it's just
  // "previous total + this week's points" on FPL's side. Patched the same way: drop
  // FPL's still-stale contribution for the current week and replace it with the
  // live-computed one, leaving every already-settled prior week untouched.
  const pointsTotal = (entryHistory.total_points || 0) - (entryHistory.points || 0) + pointsThisWeek;

  const item = {
    season_entry: `${season}#${manager.entry_id}`,
    gameweek: gw.id,
    entry_id: manager.entry_id,
    season,
    real_name: manager.real_name,
    team_nickname: manager.team_nickname,
    points_this_week: pointsThisWeek,
    points_gross: pointsThisWeek,
    transfer_cost: entryHistory.event_transfers_cost || 0,
    points_total: pointsTotal,
    transfers_made: entryHistory.event_transfers || 0,
    transfers_remaining: entryHistory.transfers_left || 0,
    // active_chip lives on the TOP-LEVEL picks response (picksData.active_chip), not
    // nested inside entry_history -- confirmed via FPL's real API shape, and by the
    // live data itself: every one of 396 existing fpl_entry_gameweek rows had
    // active_chip: null, which isn't plausible across 11 managers and up to 38
    // gameweeks each (wildcard/bench-boost/triple-captain/free-hit are near-universally
    // used at least once per season). entryHistory.active_chip was always undefined,
    // silently masked by `|| null`. Same bug family as the fpl_entry_picks.points
    // fix -- a field read from the wrong place on an external API response, defaulting
    // to a plausible-looking value instead of erroring.
    active_chip: picksData.active_chip || null,
    bank: (entryHistory.bank || 0) / 10,
    value: (entryHistory.value || 0) / 10,
    gw_winner: false,
    last_synced: new Date().toISOString(),
    data_version: 'v1'
  };
  
  try {
    await dynamodb.send(new PutCommand({
      TableName: 'fpl_entry_gameweek',
      Item: item
    }));
    logger.metric('gameweek_summary_stored', 1);
  } catch (err) {
    logger.error('Failed to store gameweek summary', err);
  }
}

async function storePicks(manager, picksData, playerMap, gw, season, livePoints = new Map()) {
  const picks = picksData.picks;
  const batch = [];

  for (const pick of picks) {
    const player = playerMap[pick.element];

    const item = {
      season_entry_gw: `${season}#${manager.entry_id}#${gw.id}`,
      position_player: `${pick.position}#${pick.element}`,
      season,
      entry_id: manager.entry_id,
      gameweek: gw.id,
      player_id: pick.element,
      player_name: player ? player.web_name : 'Unknown',
      player_position: player ? player.element_type : null,
      player_team: player ? player.team : null,
      squad_position: pick.position,
      is_captain: pick.is_captain || false,
      is_vice_captain: pick.is_vice_captain || false,
      multiplier: pick.multiplier || 1,
      // Raw points that PLAYER scored this gameweek, independent of squad role --
      // deliberately NOT multiplied by `multiplier` here, so a benched player's real
      // (wasted) score stays visible and downstream captain math can apply the
      // multiplier explicitly wherever it needs to. Sourced from the live per-gameweek
      // stats endpoint (joined by element id), not pick.points -- see
      // getLiveGameweekStats for why pick.points itself never worked.
      points: livePoints.get(pick.element) ?? 0,
      is_starter: pick.position <= 11,
      is_bench: pick.position > 11,
      last_synced: new Date().toISOString()
    };
    
    batch.push({
      PutRequest: { Item: item }
    });
  }
  
  for (let i = 0; i < batch.length; i += 25) {
    try {
      await dynamodb.send(new BatchWriteCommand({
        RequestItems: {
          'fpl_entry_picks': batch.slice(i, i + 25)
        }
      }));
    } catch (err) {
      logger.error('Failed to store picks batch', err);
    }
  }
  
  logger.metric('picks_stored', picks.length, 'players');
}

export async function handler(event) {
  const runStartTime = Date.now();
  const startedAt = new Date(runStartTime).toISOString();
  let apiCallCount = 0;
  let dbWriteCount = 0;
  // Captured as structured events (not just a running count) so ingestion_runs alone
  // is enough to answer "when did this happen, and which manager/gameweek caused it" --
  // without that, a count tells you a rate limit happened SOMEWHERE in an 11-minute
  // run across N managers, but not where, which is exactly what you'd need to know to
  // tell "one flaky request" apart from "FPL is rejecting everything from here on".
  // rateLimited* is still-429-after-retry; unexpectedStatus* is any other non-ok,
  // non-404 status (5xx, 403, etc.) -- also not FPL's normal empty result, but not the
  // specific rate-limit case either.
  //
  // Count and event list are tracked separately on purpose, NOT derived from
  // events.length -- the event list is capped (see MAX_STORED_FAILURE_EVENTS below) so
  // a worst-case outage can't blow up the DynamoDB item, but the count must stay
  // accurate even past that cap. (First attempt at this used a `.overflow` property
  // hung directly off the array instead of a real counter -- DynamoDB's marshaling
  // only walks an Array's numeric indices, so that property would've silently
  // vanished on write. Caught before it ever got deployed.)
  let rateLimitedCount = 0;
  let unexpectedStatusCount = 0;
  const rateLimitedEvents = [];
  const unexpectedStatusEvents = [];
  // DynamoDB items cap out at 400KB. Under normal operation these arrays are empty or
  // tiny (this is meant to catch anomalies, not routine data), but a total FPL outage
  // could in principle fail every manager -- cap what actually gets WRITTEN so a
  // worst-case run can't blow up the item. rateLimitedCount/unexpectedStatusCount
  // above are never capped, only these sample lists of which ones.
  // Env-overridable (same pattern as league-validation.mjs's MAX_LEAGUE_ENTRIES) --
  // mainly so a test can exercise the cap-and-keep-counting-accurately path without
  // needing 25+ real managers to do it.
  const MAX_STORED_FAILURE_EVENTS = Number(process.env.MAX_STORED_FAILURE_EVENTS) || 25;
  // Declared outside the try block so the catch handler can still report which
  // season a failed run was for, if it got far enough to resolve one.
  let season;

  logger.info('Starting nightly FPL data ingestion', { run_id: event.requestContext?.requestId || 'manual' });

  try {
    // Resolve the currently active season and league ID up front (single source of
    // truth: the shared `seasons` table), so a season rollover or league-ID change is
    // a data change, not a redeploy.
    let leagueId;
    let seasonId;
    ({ season, seasonId, leagueId } = await getCurrentSeasonInfo());
    logger.info('Resolved current season', { season, seasonId, leagueId });

    // live-check mode (the hourly rule, distinct from the unconditional nightly one)
    // -- bail out here, before any FPL API call, if today isn't a game day or we're
    // outside today's fixture window. See getTodaysFixtureWindow's own comment for
    // the window math. Checked before getBootstrapStatic() specifically so a genuine
    // off-day costs one local DynamoDB Scan and nothing else -- no FPL calls at all.
    if (event?.mode === 'live-check') {
      const window = await getTodaysFixtureWindow(seasonId);
      const now = Date.now();
      if (!window || now < window.start || now > window.end) {
        const reason = window ? 'outside_fixture_window' : 'no_fixtures_today';
        logger.info('live-check: skipping run', { reason, window });
        await recordIngestionRun({ event, startedAt, status: 'success', season, summary: { mode: 'live-check', skipped: true, reason } });
        return { statusCode: 200, body: JSON.stringify({ success: true, skipped: true, reason, timestamp: new Date().toISOString() }) };
      }
      logger.info('live-check: inside fixture window, proceeding', { window });
    }

    // Fetch bootstrap
    const bootstrap = await getBootstrapStatic();
    apiCallCount += 1;

    const playerMap = {};
    for (const player of bootstrap.elements) {
      playerMap[player.id] = player;
    }
    // team_id -> name and element_type -> position label, same lookups
    // fpl-global-stats-weekly already builds for player_event_stats -- needed here so
    // storeLiveGameweekPlayerStats can stamp the same identity fields onto its rows.
    const teamMap = {};
    for (const team of bootstrap.teams) {
      teamMap[team.id] = team.name;
    }
    const positionMap = {};
    for (const pos of bootstrap.element_types) {
      positionMap[pos.id] = pos.singular_name;
    }
    const gameweeks = bootstrap.events;

    // Determine the active gameweek. If FPL marks one as current, use it (normal
    // in-season case). Otherwise -- which is exactly what happens for the entire
    // off-season once a season concludes -- fall back to the most recent *finished*
    // gameweek instead of a hardcoded number. A hardcoded fallback here is what
    // previously caused the ingester to get stuck re-fetching only GW25/26 forever
    // once the season ended, instead of ever reaching GW38.
    const currentEvent = bootstrap.events.find(e => e.is_current);
    let activeGW;
    if (currentEvent) {
      activeGW = currentEvent.id;
    } else {
      const finishedEvents = bootstrap.events.filter(e => e.finished);
      activeGW = finishedEvents.length > 0 ? Math.max(...finishedEvents.map(e => e.id)) : 1;
    }
    const gwsToFetch = gameweeks.filter(gw => gw.id >= activeGW - 1 && gw.id <= activeGW);

    logger.info('Determined gameweeks to fetch', {
      active_gw: activeGW,
      gws_to_fetch: gwsToFetch.map(g => g.id)
    });

    // Fetch each gameweek's live per-player points ONCE here (not once per manager --
    // this is the same handful of gameweeks regardless of how many managers there are,
    // and the per-manager loop below would otherwise redundantly re-fetch it for every
    // single manager). See getLiveGameweekStats for why this call exists at all: the
    // picks endpoint itself never carries a points field. Passing seasonId/playerMap/
    // teamMap/positionMap lets it also persist the full per-player detail via
    // storeLiveGameweekPlayerStats as a side effect of this same fetch.
    const livePointsByGW = new Map();
    for (const gw of gwsToFetch) {
      livePointsByGW.set(gw.id, await getLiveGameweekStats(gw.id, { seasonId, playerMap, teamMap, positionMap }));
      apiCallCount += 1;
    }

    // Fetch managers from every registered league for this season (task #48) -- the
    // season's own primary league_id is always included; any additional leagues come
    // from the `leagues` table. A manager can belong to more than one league (e.g. a
    // manager in both Carpe Diem and a second league this season) -- entry_id is the
    // same FPL account either way, so their gameweek/picks data below is fetched
    // exactly ONCE regardless of how many leagues they're in (see the shared-tables
    // reasoning in DATA_MODEL.md's "Multi-league targeted fix"). leagueIdsByEntryId
    // tracks which league(s) each manager belongs to -- needed below to write one
    // fpl_league_standings/gw-winners-cache row PER LEAGUE a manager is in, not just
    // one row total.
    const leagueIds = await getRegisteredLeagueIds(season, leagueId);
    logger.info('Resolved registered leagues for this season', { leagueIds });

    const managersByEntryId = new Map();
    const leagueIdsByEntryId = new Map();
    for (const lid of leagueIds) {
      const leagueManagers = await getLeagueManagers(lid);
      apiCallCount += 1;
      for (const m of leagueManagers) {
        if (!managersByEntryId.has(m.entry_id)) managersByEntryId.set(m.entry_id, m);
        if (!leagueIdsByEntryId.has(m.entry_id)) leagueIdsByEntryId.set(m.entry_id, new Set());
        leagueIdsByEntryId.get(m.entry_id).add(lid);
      }
    }
    const managers = Array.from(managersByEntryId.values());

    logger.info('Processing managers', { count: managers.length, leagues: leagueIds.length });

    // Process each manager
    for (const manager of managers) {
      logger.info(`Starting manager: ${manager.team_nickname}`);

      for (const gw of gwsToFetch) {
        const { data: picksData, status } = await getManagerPicksForGW(manager.entry_id, gw.id);
        apiCallCount += 1;

        if (!picksData || !picksData.entry_history) {
          // Three distinct cases, previously all logged identically as "no data":
          // still-429-after-retry (a real rate-limit hit), some other unexpected
          // non-ok status (5xx/403/etc.), or FPL's normal 404 "nothing here yet".
          // The pause below now ALWAYS runs regardless of which branch this takes --
          // it used to be skipped entirely on any failure (this `continue` used to
          // come before the throttle delay), which meant a rate-limited run would
          // speed up instead of backing off. Longest pause on a still-failing 429.
          if (status === 429) {
            rateLimitedCount += 1;
            const evt = { entry_id: manager.entry_id, manager: manager.team_nickname, gw: gw.id, timestamp: new Date().toISOString() };
            if (rateLimitedEvents.length < MAX_STORED_FAILURE_EVENTS) rateLimitedEvents.push(evt);
            logger.error('Still rate limited after retry', evt);
            await new Promise(resolve => setTimeout(resolve, 5000));
          } else if (status !== 404 && status !== null) {
            unexpectedStatusCount += 1;
            const evt = { entry_id: manager.entry_id, manager: manager.team_nickname, gw: gw.id, status, timestamp: new Date().toISOString() };
            if (unexpectedStatusEvents.length < MAX_STORED_FAILURE_EVENTS) unexpectedStatusEvents.push(evt);
            logger.error(`Unexpected status ${status} fetching picks`, evt);
            await new Promise(resolve => setTimeout(resolve, 1000));
          } else {
            logger.info(`No data for GW ${gw.id}`, { manager: manager.team_nickname, status });
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          continue;
        }

        await storeGameweekSummary(manager, picksData, gw, season, livePointsByGW.get(gw.id));
        dbWriteCount += 1;

        await storePicks(manager, picksData, playerMap, gw, season, livePointsByGW.get(gw.id));
        dbWriteCount += picksData.picks.length;

        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Calculate winners (scoped to the current season -- an unfiltered scan here would
    // start mixing last season's and this season's gameweek winners together the
    // moment a new season's data lands in the same table)
    logger.info('Calculating winners from stored data');
    const allGWResult = await dynamodb.send(new ScanCommand({
      TableName: 'fpl_entry_gameweek',
      FilterExpression: 'season = :s',
      ExpressionAttributeValues: { ':s': season }
    }));
    
    const gwsWithData = {};
    for (const item of allGWResult.Items || []) {
      if (!gwsWithData[item.gameweek]) {
        gwsWithData[item.gameweek] = [];
      }
      gwsWithData[item.gameweek].push(item);
    }
    
    // Winners are computed PER LEAGUE (task #48/#146), not once across every manager
    // ingested for the season -- the "winner" of a gameweek depends on which roster
    // you're comparing within, and two leagues can legitimately have different winners
    // for the same gameweek. gwsWithData[gw] already holds every manager regardless of
    // league (fpl_entry_gameweek is deliberately unscoped -- see the "Multi-league
    // targeted fix" reasoning), so each league's subset is filtered from it via
    // leagueIdsByEntryId rather than a second fetch. gameweek_league is the new
    // composite sort key (see migrate-composite-standings-key.mjs) -- gameweek/
    // league_id stay as ordinary flat attributes too, unchanged for any reader.
    let winnersCount = 0;
    for (const [gw, managersList] of Object.entries(gwsWithData)) {
      for (const lid of leagueIds) {
        const leagueManagersList = managersList.filter((m) => leagueIdsByEntryId.get(m.entry_id)?.has(lid));
        if (leagueManagersList.length === 0) continue;

        const maxNetPoints = Math.max(...leagueManagersList.map(m => m.points_this_week - m.transfer_cost));
        const winners = leagueManagersList.filter(m => m.points_this_week - m.transfer_cost === maxNetPoints);

        await dynamodb.send(new PutCommand({
          TableName: 'gw-winners-cache',
          Item: {
            season,
            gameweek: parseInt(gw),
            gameweek_league: `${gw}#${lid}`,
            league_id: lid,
            winners: winners.map(w => ({
              entry_id: w.entry_id,
              real_name: w.real_name,
              team_nickname: w.team_nickname,
              net_points: w.points_this_week - w.transfer_cost,
              gross_points: w.points_this_week,
              transfer_cost: w.transfer_cost
            })),
            is_current: false,
            last_synced: new Date().toISOString()
          }
        }));
        winnersCount += 1;
        dbWriteCount += 1;
      }
    }

    logger.info('Winners cached', { gameweeks: winnersCount });

    // Calculate and store cumulative standings
    logger.info('Calculating league standings...');
let standingsCount = 0;

for (const manager of managers) {
  try {
    // Query all gameweek records for this manager -- done ONCE per manager regardless
    // of how many leagues they're in (task #48), since the underlying fact (their
    // latest total_points) doesn't depend on which league is asking.
    const result = await dynamodb.send(new ScanCommand({
      TableName: 'fpl_entry_gameweek',
      FilterExpression: 'season_entry = :se',
      ExpressionAttributeValues: { ':se': `${season}#${manager.entry_id}` }
    }));

     // Get LATEST gameweek only (don't sum all GWs!)
    const latestRecord = (result.Items || [])
      .sort((a, b) => {
        const aGW = a.gameweek?.N ? parseInt(a.gameweek.N) : (a.gameweek || 0);
        const bGW = b.gameweek?.N ? parseInt(b.gameweek.N) : (b.gameweek || 0);
        return bGW - aGW;
      })[0];

    const totalPoints = latestRecord
      ? parseInt(latestRecord.points_total?.N || latestRecord.points_total || 0)
      : 0;

    // One row PER LEAGUE this manager belongs to (task #48/#145) -- league_manager is
    // the new composite sort key ({league_id}#{entry_id}, see
    // migrate-composite-standings-key.mjs), so a manager in two leagues gets two rows
    // instead of one row whose league_id got overwritten by whichever league synced
    // last. manager_id/league_id stay as ordinary flat attributes too, unchanged for
    // any reader (queryLeagueStandings never conditions on the sort key value itself).
    const managerLeagueIds = leagueIdsByEntryId.get(manager.entry_id) || new Set([leagueId]);
    for (const lid of managerLeagueIds) {
      await dynamodb.send(new PutCommand({
        TableName: 'fpl_league_standings',
        Item: {
          season_event: `${season}#${activeGW}`,
          league_manager: `${lid}#${manager.entry_id}`,
          manager_id: manager.entry_id,
          real_name: manager.real_name,
          team_nickname: manager.team_nickname,
          league_id: lid,
          total_points: totalPoints,
          points_this_week: latestRecord ? parseInt(latestRecord.points_this_week || 0) : 0,
          transfer_cost: latestRecord ? parseInt(latestRecord.transfer_cost || 0) : 0,
          last_synced: new Date().toISOString()
        }
      }));

      standingsCount += 1;
      dbWriteCount += 1;
    }
  } catch (err) {
    logger.error(`Failed to calculate standings for ${manager.team_nickname}`, err);
  }
}

logger.info('Standings calculated and stored', { count: standingsCount });


    const totalDuration = Date.now() - runStartTime;
    
    logger.info('✅ Data ingestion complete', {
      duration_ms: totalDuration,
      api_calls: apiCallCount,
      db_writes: dbWriteCount,
      managers: managers.length,
      leagues_processed: leagueIds.length,
      gameweeks: gwsToFetch.length,
  standings: standingsCount,  // ← Add this
      rate_limited: rateLimitedCount,
      unexpected_status: unexpectedStatusCount
    });

    logger.metric('ingestion_duration', totalDuration, 'ms');
    logger.metric('api_calls_total', apiCallCount, 'requests');
    logger.metric('db_writes_total', dbWriteCount, 'items');
    if (rateLimitedCount > 0) {
      logger.metric('rate_limited_total', rateLimitedCount, 'requests');
    }

    await recordIngestionRun({
      event,
      startedAt,
      status: 'success',
      season,
      summary: {
        mode: event?.mode === 'live-check' ? 'live-check' : 'full',
        api_calls: apiCallCount,
        db_writes: dbWriteCount,
        managers: managers.length,
        leagues_processed: leagueIds.length,
        gameweeks: gwsToFetch.length,
        standings: standingsCount,
        // Counts default to 0 on every run (not omitted when zero) so a glance at
        // ingestion_runs never has to distinguish "never checked" from "checked, zero
        // hits". Event lists carry entry_id/manager/gw/timestamp (and status, for
        // unexpected ones) so a single ingestion_runs row is enough on its own to
        // answer "when did this happen and which manager/gameweek caused it" --
        // without a CloudWatch Logs search. Capped at MAX_STORED_FAILURE_EVENTS (25);
        // the counts above are the uncapped source of truth if a run somehow exceeds
        // that. See the ingester rate-limit-visibility notes in DATA_MODEL.md.
        rate_limited_count: rateLimitedCount,
        rate_limited_events: rateLimitedEvents,
        unexpected_status_count: unexpectedStatusCount,
        unexpected_status_events: unexpectedStatusEvents
      }
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: 'Data ingestion completed',
        timestamp: new Date().toISOString(),
        metrics: {
          duration_ms: totalDuration,
          api_calls: apiCallCount,
          db_writes: dbWriteCount
        }
      })
    };

  } catch (err) {
    logger.error('Fatal error in data ingestion', err);
    await recordIngestionRun({ event, startedAt, status: 'failure', season, errorMessage: err.message });
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: err.message
      })
    };
  }
}
