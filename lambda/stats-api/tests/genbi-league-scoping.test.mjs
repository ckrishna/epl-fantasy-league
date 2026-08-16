// EVAL: GenBI's season-wide aggregates (manager_season_stats, top_captain_picks,
// our_league_picks/ownership_aggregates, total_season_summary, current_standings) never
// took a league at all -- fpl_entry_gameweek/fpl_entry_picks carry no league_id column
// (see DATA_MODEL.md's "Multi-league targeted fix": a manager's raw GW score is the same
// fact regardless of which league is asking), so every one of these Scans was
// season-wide with no way to exclude a second league's managers.
//
// This was a latent, harmless gap for as long as exactly one league (Carpe Diem) had
// ever been ingested. It stopped being harmless the moment a second league (616920,
// "BETSBANTSSPORT") got registered (task #48) -- once its managers' picks/gameweek data
// is backfilled into the same shared tables, every GenBI aggregate above would silently
// blend both leagues' rosters together.
//
// Fixed by resolving a per-league roster (the set of entry_ids belonging to a
// league_id+season, sourced from fpl_league_standings -- the one table that already
// carries league_id) and filtering every one of the four season-wide scans against it
// before aggregating. league_id itself resolves from an explicit request field first,
// falling back to the season's own primary league_id (from the seasons table) --
// preserving default behavior for every existing caller that never sends one.
//
// Run BEFORE the fix: expect FAIL on tests marked "current gap".
// Run AFTER the fix: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installDynamoMock } from './helpers/mock-dynamo.mjs';
import { installBedrockMock, systemText } from './helpers/mock-bedrock.mjs';
import { handleGenBI } from '../handlers/genbi.mjs';

const CARPE_DIEM = 438107;
const BETSBANTSSPORT = 616920;

// entry_id 101 ("Da Movement") is deliberately a member of BOTH leagues, mirroring the
// real scenario that prompted this fix -- Kojo belongs to two leagues this season.
// entry_id 102 ("Suberox") is Carpe Diem-only; entry_id 201 ("BetsGuy") is
// BETSBANTSSPORT-only.
function standingsRow({ gw, managerId, leagueId }) {
  return { season_event: `2025/26#${gw}`, manager_id: managerId, league_id: leagueId, total_points: 100, points_this_week: 10 };
}

function entryGwRow({ entryId, name, gw }) {
  return {
    entry_id: entryId,
    season: '2025/26',
    real_name: name,
    team_nickname: null,
    gameweek: gw,
    points_this_week: 50,
    points_total: 50 * gw,
    transfers_made: 0,
    transfer_cost: 0,
    active_chip: null
  };
}

function pickRow({ entryId, gw }) {
  return { season: '2025/26', entry_id: entryId, gameweek: gw, is_captain: true, is_bench: false, multiplier: 2, points: 20 };
}

function baseDynamoRouter({ seasonsRow, standings = [] } = {}) {
  return (command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;
    if (table === 'genbi-usage-daily' && type === 'GetCommand') return { Item: undefined };
    if (table === 'genbi-usage-daily' && type === 'UpdateCommand') return {};
    if (table === 'seasons' && type === 'ScanCommand') {
      if (command.input.FilterExpression) return { Items: [{ season_id: 2, season_string: '2026/27', current: true }] };
      return { Items: [seasonsRow, { season_id: 2, season_string: '2026/27', current: true }] };
    }
    if (table === 'fpl_league_standings' && type === 'ScanCommand') return { Items: standings };
    if (table === 'fpl_league_standings' && type === 'QueryCommand') return { Items: [] };
    if (table === 'gw-winners-cache' && type === 'ScanCommand') return { Items: [] };
    if (table === 'player_season_totals' && type === 'QueryCommand') return { Items: [] };
    if (table === 'player_event_stats' && type === 'QueryCommand') return { Items: [] };
    if (table === 'teams' && type === 'QueryCommand') return { Items: [] };
    if (table === 'genbi-query-log' && type === 'PutCommand') return {};
    if (table === 'fpl_entry_gameweek' && type === 'ScanCommand') {
      return {
        Items: [
          entryGwRow({ entryId: 101, name: 'Da Movement', gw: 1 }),
          entryGwRow({ entryId: 102, name: 'Suberox', gw: 1 }),
          entryGwRow({ entryId: 201, name: 'BetsGuy', gw: 1 })
        ]
      };
    }
    if (table === 'fpl_entry_picks' && type === 'ScanCommand') {
      return {
        Items: [
          pickRow({ entryId: 101, gw: 1 }),
          pickRow({ entryId: 102, gw: 1 }),
          pickRow({ entryId: 201, gw: 1 })
        ]
      };
    }
    return undefined;
  };
}

async function askManagerStats({ leagueId, seasonLeagueId, standings }) {
  const dynamoMock = installDynamoMock(baseDynamoRouter({
    seasonsRow: { season_id: 1, season_string: '2025/26', league_id: seasonLeagueId },
    standings
  }));
  const bedrockMock = installBedrockMock('ok');
  try {
    const body = { question: 'How many transfers has each manager made?', season: '2025/26' };
    if (leagueId !== undefined) body.league_id = leagueId;
    await handleGenBI(body, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = systemText(payload).match(/<context>([\s\S]*?)<\/context>/)[1];
    return JSON.parse(contextBlock.match(/<manager_season_stats>(.*?)<\/manager_season_stats>/)[1]);
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
}

test('[current gap] an explicit league_id scopes manager_season_stats to that league\'s roster only', async () => {
  const stats = await askManagerStats({
    leagueId: CARPE_DIEM,
    seasonLeagueId: CARPE_DIEM,
    standings: [
      standingsRow({ gw: 1, managerId: 101, leagueId: CARPE_DIEM }),
      standingsRow({ gw: 1, managerId: 102, leagueId: CARPE_DIEM }),
      standingsRow({ gw: 1, managerId: 101, leagueId: BETSBANTSSPORT }),
      standingsRow({ gw: 1, managerId: 201, leagueId: BETSBANTSSPORT })
    ]
  });

  const names = stats.map((m) => m.manager).sort();
  assert.deepStrictEqual(names, ['Da Movement', 'Suberox'], 'Expected Carpe Diem\'s own two managers, not BetsGuy from the other league');
});

test('[current gap] with no explicit league_id, the season\'s own primary league_id is used as the default', async () => {
  const stats = await askManagerStats({
    // leagueId omitted entirely -- must fall back to seasonLeagueId
    seasonLeagueId: CARPE_DIEM,
    standings: [
      standingsRow({ gw: 1, managerId: 101, leagueId: CARPE_DIEM }),
      standingsRow({ gw: 1, managerId: 102, leagueId: CARPE_DIEM }),
      standingsRow({ gw: 1, managerId: 101, leagueId: BETSBANTSSPORT }),
      standingsRow({ gw: 1, managerId: 201, leagueId: BETSBANTSSPORT })
    ]
  });

  const names = stats.map((m) => m.manager).sort();
  assert.deepStrictEqual(names, ['Da Movement', 'Suberox'], 'Expected the default (season-level) league_id to scope exactly like an explicit one would');
});

test('[current gap] a shared manager (member of both leagues) is included correctly under either league, with the other league\'s exclusive manager excluded', async () => {
  const stats = await askManagerStats({
    leagueId: BETSBANTSSPORT,
    seasonLeagueId: CARPE_DIEM,
    standings: [
      standingsRow({ gw: 1, managerId: 101, leagueId: CARPE_DIEM }),
      standingsRow({ gw: 1, managerId: 102, leagueId: CARPE_DIEM }),
      standingsRow({ gw: 1, managerId: 101, leagueId: BETSBANTSSPORT }),
      standingsRow({ gw: 1, managerId: 201, leagueId: BETSBANTSSPORT })
    ]
  });

  const names = stats.map((m) => m.manager).sort();
  assert.deepStrictEqual(names, ['BetsGuy', 'Da Movement'], 'Expected BETSBANTSSPORT\'s two managers (including the shared one), not Suberox');
});

test('[regression] a season with no resolvable league_id at all stays fully unscoped, exactly as before this fix', async () => {
  const stats = await askManagerStats({
    seasonLeagueId: null,
    standings: []
  });

  const names = stats.map((m) => m.manager).sort();
  assert.deepStrictEqual(names, ['BetsGuy', 'Da Movement', 'Suberox'], 'Expected every manager, unscoped -- no league_id was resolvable to scope by');
});

test('[safety] a resolved league_id with zero matching standings rows falls back to unscoped rather than excluding everyone', async () => {
  // League_id resolves (season default), but nothing in fpl_league_standings actually
  // carries it yet -- e.g. a freshly-registered league before its first backfill. This
  // must NOT silently zero out manager_season_stats for the league everyone actually uses.
  const stats = await askManagerStats({
    seasonLeagueId: CARPE_DIEM,
    standings: [] // nothing stamped with any league_id yet
  });

  const names = stats.map((m) => m.manager).sort();
  assert.deepStrictEqual(names, ['BetsGuy', 'Da Movement', 'Suberox'], 'An empty roster resolution must fall back to unscoped, not exclude every manager');
});

test('[current gap] total_season_summary (derived from gw-winners-cache) is also scoped by the resolved league_id', async () => {
  const dynamoMock = installDynamoMock((command) => {
    const table = command.input.TableName;
    const type = command.constructor.name;
    if (table === 'genbi-usage-daily' && type === 'GetCommand') return { Item: undefined };
    if (table === 'genbi-usage-daily' && type === 'UpdateCommand') return {};
    if (table === 'seasons' && type === 'ScanCommand') {
      if (command.input.FilterExpression) return { Items: [{ season_id: 2, season_string: '2026/27', current: true }] };
      return { Items: [{ season_id: 1, season_string: '2025/26', league_id: CARPE_DIEM }, { season_id: 2, season_string: '2026/27', current: true }] };
    }
    if (table === 'fpl_league_standings' && type === 'ScanCommand') return { Items: [] };
    if (table === 'fpl_league_standings' && type === 'QueryCommand') return { Items: [] };
    if (table === 'fpl_entry_gameweek' && type === 'ScanCommand') return { Items: [] };
    if (table === 'fpl_entry_picks' && type === 'ScanCommand') return { Items: [] };
    if (table === 'player_season_totals' && type === 'QueryCommand') return { Items: [] };
    if (table === 'player_event_stats' && type === 'QueryCommand') return { Items: [] };
    if (table === 'teams' && type === 'QueryCommand') return { Items: [] };
    if (table === 'genbi-query-log' && type === 'PutCommand') return {};
    if (table === 'gw-winners-cache' && type === 'ScanCommand') {
      return {
        Items: [
          { season: '2025/26', gameweek: 1, league_id: CARPE_DIEM, winners: [{ real_name: 'Da Movement' }] },
          { season: '2025/26', gameweek: 1, league_id: BETSBANTSSPORT, winners: [{ real_name: 'BetsGuy' }] }
        ]
      };
    }
    return undefined;
  });
  const bedrockMock = installBedrockMock('ok');

  try {
    await handleGenBI({ question: 'Who has won the most gameweeks this season?', season: '2025/26' }, {});
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const contextBlock = systemText(payload).match(/<context>([\s\S]*?)<\/context>/)[1];
    const summary = JSON.parse(contextBlock.match(/<total_season_summary>(.*?)<\/total_season_summary>/)[1]);

    assert.deepStrictEqual(Object.keys(summary), ['Da Movement'], 'Expected only Carpe Diem\'s own winner, not BETSBANTSSPORT\'s');
  } finally {
    dynamoMock.restore();
    bedrockMock.restore();
  }
});
