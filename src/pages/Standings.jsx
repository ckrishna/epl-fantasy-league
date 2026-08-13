// src/pages/Standings.jsx
import { useEffect, useState } from 'react';
import { getStandings } from '../api/client';
import ScopeNote from '../components/ScopeNote';
import ManagerSquad from '../components/ManagerSquad';
import '../styles/Standings.css';

export default function Standings({ season = null, seasonLabel = null, resetKey = 0 } = {}) {
  const [standings, setStandings] = useState([]);
  const [loading, setLoading] = useState(false);
const [activeGW, setActiveGW] = useState(null);
const [displayGW, setDisplayGW] = useState(null);  // ← ADD THIS
const [selectedManager, setSelectedManager] = useState(null); // { entryId, teamName, managerName }

// Re-clicking the "Standings" nav tab while already on this page should return from
// the squad view to the list -- App.jsx bumps resetKey on every Standings tab click
// (even when it's already the active tab) specifically so this effect can catch that.
useEffect(() => {
  setSelectedManager(null);
}, [resetKey]);


useEffect(() => {
  setLoading(true);

  // Fetch standings with no GW param (will use active_gameweek from API), scoped to
  // whichever season is selected (null = current season, handled server-side).
  getStandings(null, season).then(data => {
    // Set activeGW from the API response
    if (data.active_gameweek) {
      setActiveGW(data.active_gameweek);
    }
    if (data.gameweek) {
      setDisplayGW(data.gameweek);  // ← ADD THIS
    }
    
    const sorted = (data.standings || [])
      .sort((a, b) => b.total_points - a.total_points)
      .map((manager, idx) => ({
        ...manager,
        rank: idx + 1
      }));
    setStandings(sorted);
    setLoading(false);
  }).catch(err => {
    console.error('Error fetching standings:', err);
    setLoading(false);
  });
}, [season]);

  if (loading) return <div className="loading">Loading standings...</div>;

  if (selectedManager) {
    return (
      <div className="standings-page">
        <ManagerSquad
          entryId={selectedManager.entryId}
          teamName={selectedManager.teamName}
          managerName={selectedManager.managerName}
          onClose={() => setSelectedManager(null)}
        />
      </div>
    );
  }

  return (
    <div className="standings-page">
      <h2>League Standings <span className="page-title-note">(Net Points)</span></h2>
      <ScopeNote season={seasonLabel} />

      {/* Mobile Card View */}
      <div className="standings-cards">
        {standings.map((manager) => (
          <div key={manager.manager_id} className={`standings-card ${manager.rank === 1 ? 'top-1' : ''}`}>
            <div className="card-rank">
              <span className="rank-badge">{manager.rank}</span>
            </div>
            <div className="card-info">
              <button
                type="button"
                className="card-team card-team-link"
                onClick={() => setSelectedManager({ entryId: manager.manager_id, teamName: manager.team_name, managerName: manager.manager_name })}
              >
                {manager.team_name}
              </button>
              {/* Historical (pre-2025/26) seasons only have a manager's real name on
                  record, no separate team nickname -- manager_name is null for those
                  rows rather than a blank/duplicate line. */}
              {manager.manager_name && <p className="card-manager">{manager.manager_name}</p>}
            </div>
            <div className="card-stats">
              <div className="stat">
                <span className="stat-label">GW {displayGW || activeGW}</span>
                <span className="stat-value">{manager.points_this_week}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Total</span>
                <span className="stat-value">{manager.total_points}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Desktop Table View */}
      <table className="standings-table">
        <thead>
          <tr>
            <th>RANK</th>
            <th>TEAM & MANAGER</th>
            <th>GW {displayGW || activeGW}</th>
            <th>TOTAL POINTS</th>
          </tr>
        </thead>
        <tbody>
          {standings.map((manager) => (
            <tr key={manager.manager_id} className={manager.rank === 1 ? 'top-1' : ''}>
              <td className="rank">{manager.rank}</td>
              <td className="team-manager">
                <button
                  type="button"
                  className="team-name team-name-link"
                  onClick={() => setSelectedManager({ entryId: manager.manager_id, teamName: manager.team_name, managerName: manager.manager_name })}
                >
                  {manager.team_name}
                </button>
                {manager.manager_name && <div className="manager-name">{manager.manager_name}</div>}
              </td>
              <td className="week-points">{manager.points_this_week}</td>
              <td className="points">{manager.total_points}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {standings.length === 0 && (
        <p className="no-data">No standings data available</p>
      )}
    </div>
  );
}
