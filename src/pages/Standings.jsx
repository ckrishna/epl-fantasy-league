// src/pages/Standings.jsx - Updated with medal icons
import { useEffect, useState } from 'react';
import { getStandings } from '../api/client';
import '../styles/Standings.css';

export default function Standings() {
  const [standings, setStandings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeGW, setActiveGW] = useState(26);

  useEffect(() => {
    setLoading(true);
    getStandings(activeGW).then(data => {
      if (data.active_gameweek) {
        setActiveGW(data.active_gameweek);
      }
      
      const sorted = (data.standings || [])
        .sort((a, b) => b.points_total - a.points_total)
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
  }, []);

  // Get medal for rank
  const getMedal = (rank) => {
    if (rank === 1) return '🥇';
    if (rank === 2) return '🥈';
    if (rank === 3) return '🥉';
    return null;
  };

  if (loading) return <div className="loading">Loading standings...</div>;

  return (
    <div className="standings-page">
      <h2>League Standings</h2>
      <p className="subtitle">Ranked by total season points</p>

      {/* Mobile Card View */}
      <div className="standings-cards">
        {standings.map((manager) => (
          <div key={manager.entry_id} className={`standings-card ${manager.rank <= 3 ? `top-${manager.rank}` : ''}`}>
            <div className="card-rank">
              <span className="rank-badge">
                {getMedal(manager.rank) || manager.rank}
              </span>
            </div>
            <div className="card-info">
              <h3 className="card-team">{manager.team_name}</h3>
              <p className="card-manager">{manager.manager_name}</p>
            </div>
            <div className="card-stats">
              <div className="stat">
                <span className="stat-label">GW {activeGW}</span>
                <span className="stat-value">{manager.points_this_week}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Total</span>
                <span className="stat-value">{manager.points_total}</span>
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
            <th>GW {activeGW}</th>
            <th>TOTAL POINTS</th>
          </tr>
        </thead>
        <tbody>
          {standings.map((manager) => (
            <tr key={manager.entry_id} className={manager.rank <= 3 ? `top-${manager.rank}` : ''}>
              <td className="rank">
                {getMedal(manager.rank) ? (
                  <span className="medal">{getMedal(manager.rank)}</span>
                ) : (
                  manager.rank
                )}
              </td>
              <td className="team-manager">
                <div className="team-name">{manager.team_name}</div>
                <div className="manager-name">{manager.manager_name}</div>
              </td>
              <td className="week-points">{manager.points_this_week}</td>
              <td className="points">{manager.points_total}</td>
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
