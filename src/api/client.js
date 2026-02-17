// src/api/client.js
const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000/api';

export async function getStandings(gw = 25) {
  try {
    const res = await fetch(`${API_BASE}/standings?gw=${gw}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('getStandings error:', err);
    return { gameweek: gw, standings: [] };
  }
}

export async function getWinners() {
  try {
    const res = await fetch(`${API_BASE}/winners`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('getWinners error:', err);
    return { 
      active_gameweek: 26,
      finished_gameweeks: [],
      last_updated: null 
    };
  }
}

export async function getTrendingPlayers(gw = 25, limit = 10) {
  try {
    const res = await fetch(`${API_BASE}/players/trending?gw=${gw}&limit=${limit}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('getTrendingPlayers error:', err);
    return { gameweek: gw, topScorers: [] };
  }
}

export async function queryStats(question) {
  try {
    const res = await fetch(`${API_BASE}/stats/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('queryStats error:', err);
    return { error: err.message };
  }
}
