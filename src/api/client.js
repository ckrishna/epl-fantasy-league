// src/api/client.js
const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000/api';

export async function getStandings(gw = null, season = null) {
  try {
    const params = new URLSearchParams();
    if (gw) params.set('gw', gw);
    if (season) params.set('season', season);
    const query = params.toString();
    const url = query ? `${API_BASE}/standings?${query}` : `${API_BASE}/standings`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('getStandings error:', err);
    return { gameweek: gw, standings: [] };
  }
}

export async function getWinners(season = null) {
  try {
    const url = season ? `${API_BASE}/winners?season=${encodeURIComponent(season)}` : `${API_BASE}/winners`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('getWinners error:', err);
    return {
      active_gameweek: null,
      finished_gameweeks: [],
      last_updated: null
    };
  }
}

// Lists every season on record (not just the current one) -- powers the season dropdown.
export async function getSeasons() {
  try {
    const res = await fetch(`${API_BASE}/seasons`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.seasons || [];
  } catch (err) {
    console.error('getSeasons error:', err);
    return [];
  }
}

// Trends tab manager picker -- every real name with at least one fpl_entry_gameweek
// row, historical or live, deduped server-side.
export async function getTrendsManagers() {
  try {
    const res = await fetch(`${API_BASE}/trends/managers`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.managers || [];
  } catch (err) {
    console.error('getTrendsManagers error:', err);
    return [];
  }
}

// Pace-vs-history and season-by-season data for one manager, keyed by their real name
// (team_name -- see the naming-inversion note in DATA_MODEL.md). Returns null on
// failure so the page can show a friendly empty state instead of throwing.
export async function getTrends(managerTeamName) {
  try {
    const res = await fetch(`${API_BASE}/trends?manager=${encodeURIComponent(managerTeamName)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('getTrends error:', err);
    return null;
  }
}

// Same numeric FPL club codes as lambda/stats-api/handlers/manager-squad.mjs's
// CLUB_INFO (verified live against FPL's bootstrap-static + vaastav's 2025/26
// teams.csv -- see that file's comment). Only needed here to build crest URLs for the
// mock squad below; the real endpoint returns team_crest directly.
const CREST_CODE_BY_SHORT = {
  ARS: 3, AVL: 7, BOU: 91, BRE: 94, BHA: 36, BUR: 90, CHE: 8, CRY: 31, EVE: 11,
  FUL: 54, LEE: 2, LIV: 14, MCI: 43, MUN: 1, NEW: 4, NFO: 17, SUN: 56, TOT: 6,
  WHU: 21, WOL: 39
};
// Root-relative, not a live URL -- see manager-squad.mjs's clubCrestUrl comment. The
// crest PNGs live in public/badges/ (downloaded once via scripts/download-club-badges.sh),
// so this resolves against the app's own origin instead of hitting FPL's CDN at runtime.
function mockCrest(teamCode) {
  const code = CREST_CODE_BY_SHORT[teamCode];
  return code ? `/badges/t${code}.png` : null;
}

// Sample squad shown when /manager-squad isn't reachable yet -- the backend handler
// (lambda/stats-api/handlers/manager-squad.mjs) exists in the repo but hasn't been
// deployed via `aws lambda update-function-code` yet, and there's no API Gateway
// resource for it either (both manual steps the app owner runs themselves, see
// deploy instructions). This lets the new pitch-view squad feature be previewed with
// `npm run dev` right now instead of blocking on that deploy. Shaped identically to
// the real handler's response so swapping it out later is a no-op for ManagerSquad.
const MOCK_SQUAD = {
  season: '2026/27',
  gameweek: 4,
  entry_id: 0,
  // Gross = sum of every non-bench player's gw_points below (16 + 11 + 9 + 6 + 5 + 5 +
  // 2 + 2 + 2 + 2 + 0 -- bench excluded, matching the real handler). Net subtracts a
  // mocked 4-point hit (one extra paid transfer that gameweek) -- shown here so the
  // "gross vs net" distinction is visible in preview, not just when a real hit exists.
  team_gw_points_gross: 59,
  team_gw_points_net: 55,
  transfer_cost: 4,
  players: [
    { player_id: 1, name: 'Raya', position: 'GKP', team_code: 'ARS', squad_position: 1, is_captain: false, is_vice_captain: false, is_bench: false, form: 4.2, form_tag: 'neutral', gw_points: 2, fixtures: [{ gw: 5, opponent_code: 'BOU', is_home: true, difficulty: 2 }, { gw: 6, opponent_code: 'TOT', is_home: false, difficulty: 4 }] },
    { player_id: 2, name: 'Van Dijk', position: 'DEF', team_code: 'LIV', squad_position: 2, is_captain: false, is_vice_captain: false, is_bench: false, form: 4.8, form_tag: 'neutral', gw_points: 6, fixtures: [{ gw: 5, opponent_code: 'WHU', is_home: true, difficulty: 2 }, { gw: 6, opponent_code: 'BRE', is_home: true, difficulty: 2 }] },
    { player_id: 3, name: 'Trippier', position: 'DEF', team_code: 'NEW', squad_position: 3, is_captain: false, is_vice_captain: false, is_bench: false, form: 6.4, form_tag: 'hot', gw_points: 9, fixtures: [{ gw: 5, opponent_code: 'BHA', is_home: false, difficulty: 4 }, { gw: 6, opponent_code: 'SUN', is_home: true, difficulty: 2 }] },
    { player_id: 4, name: 'Tarkowski', position: 'DEF', team_code: 'EVE', squad_position: 4, is_captain: false, is_vice_captain: false, is_bench: false, form: 1.4, form_tag: 'cold', gw_points: 1, fixtures: [{ gw: 5, opponent_code: 'MCI', is_home: false, difficulty: 5 }, { gw: 6, opponent_code: 'WHU', is_home: true, difficulty: 3 }] },
    { player_id: 5, name: 'Gabriel', position: 'DEF', team_code: 'ARS', squad_position: 5, is_captain: false, is_vice_captain: false, is_bench: false, form: 3.6, form_tag: 'neutral', gw_points: 2, fixtures: [{ gw: 5, opponent_code: 'BOU', is_home: true, difficulty: 2 }, { gw: 6, opponent_code: 'TOT', is_home: false, difficulty: 4 }] },
    { player_id: 6, name: 'Palmer', position: 'MID', team_code: 'CHE', squad_position: 6, is_captain: false, is_vice_captain: false, is_bench: false, form: 4.4, form_tag: 'neutral', gw_points: 5, fixtures: [{ gw: 5, opponent_code: 'TOT', is_home: false, difficulty: 3 }, { gw: 6, opponent_code: 'FUL', is_home: true, difficulty: 2 }] },
    { player_id: 7, name: 'Saka', position: 'MID', team_code: 'ARS', squad_position: 7, is_captain: false, is_vice_captain: false, is_bench: false, form: 7.1, form_tag: 'hot', gw_points: 11, fixtures: [{ gw: 5, opponent_code: 'BOU', is_home: true, difficulty: 2 }, { gw: 6, opponent_code: 'TOT', is_home: false, difficulty: 4 }] },
    { player_id: 8, name: 'Semenyo', position: 'MID', team_code: 'BOU', squad_position: 8, is_captain: false, is_vice_captain: false, is_bench: false, form: 1.8, form_tag: 'cold', gw_points: 0, fixtures: [{ gw: 5, opponent_code: 'ARS', is_home: false, difficulty: 5 }, { gw: 6, opponent_code: 'CRY', is_home: true, difficulty: 3 }] },
    { player_id: 9, name: 'Rice', position: 'MID', team_code: 'ARS', squad_position: 9, is_captain: false, is_vice_captain: false, is_bench: false, form: 4.0, form_tag: 'neutral', gw_points: 2, fixtures: [{ gw: 5, opponent_code: 'BOU', is_home: true, difficulty: 2 }, { gw: 6, opponent_code: 'TOT', is_home: false, difficulty: 4 }] },
    { player_id: 10, name: 'Haaland', position: 'FWD', team_code: 'MCI', squad_position: 10, is_captain: true, is_vice_captain: false, is_bench: false, form: 8.2, form_tag: 'hot', gw_points: 16, fixtures: [{ gw: 5, opponent_code: 'EVE', is_home: true, difficulty: 2 }, { gw: 6, opponent_code: 'LIV', is_home: false, difficulty: 3 }] },
    { player_id: 11, name: 'Isak', position: 'FWD', team_code: 'NEW', squad_position: 11, is_captain: false, is_vice_captain: true, is_bench: false, form: 4.6, form_tag: 'neutral', gw_points: 5, fixtures: [{ gw: 5, opponent_code: 'BHA', is_home: false, difficulty: 4 }, { gw: 6, opponent_code: 'SUN', is_home: true, difficulty: 2 }] },
    { player_id: 12, name: 'Sa', position: 'GKP', team_code: 'WOL', squad_position: 12, is_captain: false, is_vice_captain: false, is_bench: true, form: 3.2, form_tag: 'neutral', gw_points: 0, fixtures: [{ gw: 5, opponent_code: 'CRY', is_home: true, difficulty: 2 }, { gw: 6, opponent_code: 'AVL', is_home: false, difficulty: 3 }] },
    { player_id: 13, name: 'Estupinan', position: 'DEF', team_code: 'BHA', squad_position: 13, is_captain: false, is_vice_captain: false, is_bench: true, form: 3.9, form_tag: 'neutral', gw_points: 0, fixtures: [{ gw: 5, opponent_code: 'NEW', is_home: true, difficulty: 3 }, { gw: 6, opponent_code: 'FUL', is_home: false, difficulty: 2 }] },
    { player_id: 14, name: 'Andreas', position: 'MID', team_code: 'FUL', squad_position: 14, is_captain: false, is_vice_captain: false, is_bench: true, form: 1.6, form_tag: 'cold', gw_points: 0, fixtures: [{ gw: 5, opponent_code: 'LIV', is_home: false, difficulty: 5 }, { gw: 6, opponent_code: 'BOU', is_home: true, difficulty: 2 }] },
    { player_id: 15, name: 'Wood', position: 'FWD', team_code: 'NFO', squad_position: 15, is_captain: false, is_vice_captain: false, is_bench: true, form: 4.1, form_tag: 'neutral', gw_points: 3, fixtures: [{ gw: 5, opponent_code: 'CHE', is_home: true, difficulty: 4 }, { gw: 6, opponent_code: 'BRE', is_home: false, difficulty: 2 }] }
  ]
};

// Current squad + form + next-two-fixtures for one manager (the Standings "click a
// manager" pitch view). Falls back to MOCK_SQUAD -- see its comment -- rather than an
// empty object, so the feature is previewable before the backend is deployed.
export async function getManagerSquad(entryId, gw = null) {
  try {
    const params = new URLSearchParams({ entry_id: entryId });
    if (gw) params.set('gw', gw);
    const res = await fetch(`${API_BASE}/manager-squad?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.players || data.players.length === 0) throw new Error('empty squad');
    return data;
  } catch (err) {
    console.warn('getManagerSquad falling back to sample data:', err.message);
    return {
      ...MOCK_SQUAD,
      entry_id: entryId,
      _isMock: true,
      players: MOCK_SQUAD.players.map((p) => ({ ...p, team_crest: mockCrest(p.team_code) }))
    };
  }
}

export async function getTrendingPlayers(gw = null, limit = 10) {
  try {
    const res = await fetch(`${API_BASE}/players/trending?gw=${gw}&limit=${limit}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('getTrendingPlayers error:', err);
    return { gameweek: gw, topScorers: [] };
  }
}

export async function queryStats(question, season = null) {
  try {
    const res = await fetch(`${API_BASE}/stats/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(season ? { question, season } : { question })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('queryStats error:', err);
    return { error: err.message };
  }
}

// Attaches thumbs-up/down feedback to a previously answered GenBI question, referenced
// by the query_id that queryStats() returned alongside the answer. Returns false (never
// throws) on failure so the UI can show "couldn't record that" without crashing --
// declining to save feedback isn't worth losing the answer already on screen for.
export async function submitFeedback(queryId, feedback) {
  try {
    const res = await fetch(`${API_BASE}/stats/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query_id: queryId, feedback })
    });
    return res.ok;
  } catch (err) {
    console.error('submitFeedback error:', err);
    return false;
  }
}

// Free-text feedback form on the Help page -- unrelated to submitFeedback() above
// (that's GenBI's thumbs-up/down on a specific answer). `website` is a honeypot field:
// always sent empty by the real form, just along for the ride so a bot filling in
// every input it sees trips it. Returns the server's actual error message on failure
// (e.g. rate-limited, invalid email) rather than a bare boolean, since the form should
// tell the manager *why* it didn't go through.
export async function submitAppFeedback({ message, email, website }) {
  try {
    const res = await fetch(`${API_BASE}/app-feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, email, website })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { success: false, error: data.error || `HTTP ${res.status}` };
    }
    return { success: true };
  } catch (err) {
    console.error('submitAppFeedback error:', err);
    return { success: false, error: 'Network error -- please try again.' };
  }
}
