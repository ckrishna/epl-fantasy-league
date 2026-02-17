// src/pages/Standings.jsx - Updated for new API response
import { useEffect, useState } from 'react';
import { getStandings } from '../api/client';
import '../styles/Standings.css';

export default function Standings() {
  const [standings, setStandings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [gw, setGw] = useState(25);

  useEffect(() => {
    setLoading(true);
    getStandings(gw).then(data => {
      // Sort by total points (season ranking), not this week's points
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
  }, [gw]);

  if (loading) return <div className="loading">Loading standings...</div>;

  return (
    <div className="standings-page">
      <h2>League Standings</h2>
      <p className="subtitle">Ranked by total season points</p>

      {/* Mobile Card View */}
      <div className="standings-cards">
        {standings.map((manager) => (
          <div key={manager.entry_id} className="standings-card">
            <div className="card-rank">
              <span className="rank-badge">{manager.rank}</span>
            </div>
            <div className="card-info">
              <h3 className="card-manager">{manager.manager_name}</h3>
              <p className="card-team">{manager.team_name}</p>
            </div>
            <div className="card-stats">
              <div className="stat">
                <span className="stat-label">Total</span>
                <span className="stat-value">{manager.points_total}</span>
              </div>
              <div className="stat">
                <span className="stat-label">This Week</span>
                <span className="stat-value">{manager.points_this_week}</span>
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
            <th>MANAGER</th>
            <th>TEAM</th>
            <th>TOTAL POINTS</th>
            <th>GW {gw} POINTS</th>
          </tr>
        </thead>
        <tbody>
          {standings.map((manager) => (
            <tr key={manager.entry_id} className={manager.rank <= 3 ? 'top-three' : ''}>
              <td className="rank">{manager.rank}</td>
              <td className="manager-name">{manager.manager_name}</td>
              <td className="team-name">{manager.team_name}</td>
              <td className="points">{manager.points_total}</td>
              <td className="week-points">{manager.points_this_week}</td>
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
