// src/api/client.js
const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000/api';

// leagueId is optional and only matters once a second league shares a season -- the
// backend treats every row written before league_id existed as unambiguous (see
// queryLeagueStandings in dynamodb.mjs), so omitting it is always safe today.
export async function getStandings(gw = null, season = null, leagueId = null) {
  try {
    const params = new URLSearchParams();
    if (gw) params.set('gw', gw);
    if (season) params.set('season', season);
    if (leagueId) params.set('league_id', leagueId);
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

export async function getWinners(season = null, leagueId = null) {
  try {
    const params = new URLSearchParams();
    if (season) params.set('season', season);
    if (leagueId) params.set('league_id', leagueId);
    const query = params.toString();
    const url = query ? `${API_BASE}/winners?${query}` : `${API_BASE}/winners`;
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
// leagueId is optional -- see league-groups.mjs on the backend. Without it (or if the
// league isn't registered with a league_group_id yet), both endpoints below match
// against every season on record, exactly as before this existed.
export async function getTrendsManagers(leagueId = null) {
  try {
    const url = leagueId
      ? `${API_BASE}/trends/managers?league_id=${encodeURIComponent(leagueId)}`
      : `${API_BASE}/trends/managers`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.managers || [];
  } catch (err) {
    console.error('getTrendsManagers error:', err);
    return [];
  }
}

// Pace-vs-history and season-by-season data for one manager, keyed by their real name
// (real_name -- see the naming-inversion note in DATA_MODEL.md). Returns null on
// failure so the page can show a friendly empty state instead of throwing.
export async function getTrends(managerTeamName, leagueId = null) {
  try {
    const params = new URLSearchParams({ manager: managerTeamName });
    if (leagueId) params.set('league_id', leagueId);
    const res = await fetch(`${API_BASE}/trends?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('getTrends error:', err);
    return null;
  }
}

// Current squad + form + next-two-fixtures for one manager (the Standings "click a
// manager" pitch view). Live endpoint only -- no mock fallback. An earlier version of
// this silently returned sample data on any fetch failure, which meant a real backend
// outage looked identical to a working feature (see the "aren't these mocks?" mix-up
// once /manager-squad was actually deployed). Now a failure is a real thrown error
// that ManagerSquad.jsx surfaces as an explicit "couldn't load" message instead of
// quietly faking numbers.
export async function getManagerSquad(entryId, gw = null) {
  const params = new URLSearchParams({ entry_id: entryId });
  if (gw) params.set('gw', gw);
  const res = await fetch(`${API_BASE}/manager-squad?${params.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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

// leagueId (added 2026-08-15, task #143): threads through whichever league is currently
// on screen, same as getStandings/getTrends already do -- without it, the backend falls
// back to the season's own primary league_id (see genbi.mjs's handleGenBI), which is
// only actually different from "the league you're looking at" once a second league
// shares the same season (task #48).
export async function queryStats(question, season = null, leagueId = null) {
  try {
    const body = { question };
    if (season) body.season = season;
    if (leagueId) body.league_id = leagueId;
    const res = await fetch(`${API_BASE}/stats/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
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
