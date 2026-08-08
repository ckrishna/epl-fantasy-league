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
