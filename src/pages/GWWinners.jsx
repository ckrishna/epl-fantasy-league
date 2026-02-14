// src/pages/GWWinners.jsx
import { useEffect, useState } from 'react';
import { getWinners } from '../api/client';
import '../styles/GWWinners.css';

export default function GWWinners() {
  const [winners, setWinners] = useState([]);
  const [loading, setLoading] = useState(false);
  const [expandedManager, setExpandedManager] = useState(null);

  useEffect(() => {
    setLoading(true);
    getWinners().then(data => {
      setWinners(data.winners || []);
      setLoading(false);
    }).catch(err => {
      console.error('Error fetching winners:', err);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="loading">Loading weekly winners...</div>;

  // Calculate manager stats
  const managerStats = {};
  winners.forEach(w => {
    if (!managerStats[w.manager_id]) {
      managerStats[w.manager_id] = {
        manager_name: w.manager_name,
        team_name: w.team_name,
        wins: 0,
        total_points: 0,
        avg_points: 0
      };
    }
    managerStats[w.manager_id].wins += 1;
    managerStats[w.manager_id].total_points += w.points;
  });

  // Calculate averages and sort by wins
  const sortedStats = Object.values(managerStats)
    .map(stat => ({
      ...stat,
      avg_points: (stat.total_points / stat.wins).toFixed(1)
    }))
    .sort((a, b) => b.wins - a.wins);

  // Group winners by manager
  const winnersByManager = {};
  winners.forEach(w => {
    if (!winnersByManager[w.manager_id]) {
      winnersByManager[w.manager_id] = [];
    }
    winnersByManager[w.manager_id].push(w);
  });

  // Sort each manager's wins by gameweek descending
  Object.keys(winnersByManager).forEach(id => {
    winnersByManager[id].sort((a, b) => b.gameweek - a.gameweek);
  });

  return (
    <div className="gw-winners-page">
      <h2>Gameweek Winners</h2>
      <p>Weekly winner determined by highest net points (after transfer costs)</p>
      
      {/* Dashboard Summary */}
      <div className="winners-dashboard">
        <h3>Manager Wins Summary</h3>
        <div className="stats-grid">
          {sortedStats.map((stat, idx) => (
            <div key={stat.manager_id} className="stat-card">
              <div className="stat-rank">#{idx + 1}</div>
              <div className="stat-name">{stat.manager_name}</div>
              <div className="stat-wins">
                <span className="wins-number">{stat.wins}</span>
                <span className="wins-label">wins</span>
              </div>
              <div className="stat-avg">Avg: {stat.avg_points} pts</div>
            </div>
          ))}
        </div>
      </div>

      {/* Accordion View */}
      <div className="winners-accordion">
        <h3>Detailed Wins by Manager</h3>
        {sortedStats.map((stat) => (
          <div key={stat.manager_id} className="accordion-item">
            <button
              className="accordion-header"
              onClick={() => setExpandedManager(
                expandedManager === stat.manager_id ? null : stat.manager_id
              )}
            >
              <span className="accordion-title">
                {stat.manager_name} ({stat.wins} wins)
              </span>
              <span className="accordion-icon">
                {expandedManager === stat.manager_id ? '▼' : '▶'}
              </span>
            </button>

            {expandedManager === stat.manager_id && (
              <div className="accordion-content">
                <table className="mini-table">
                  <thead>
                    <tr>
                      <th>GW</th>
                      <th>Net Points</th>
                      <th>Gross Points</th>
                      <th>Transfer Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {winnersByManager[stat.manager_id].map(w => (
                      <tr key={`${w.gameweek}-${w.manager_id}`}>
                        <td className="gw-cell">{w.gameweek}</td>
                        <td className="net-points"><strong>{w.points}</strong></td>
                        <td>{w.gross_points}</td>
                        <td className="transfer-cost">
                          {w.transfer_cost > 0 ? `-${w.transfer_cost}` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Full Table View */}
      <div className="winners-table-section">
        <h3>All Gameweek Winners</h3>
        <table className="winners-table">
          <thead>
            <tr>
              <th>GW</th>
              <th>Manager</th>
              <th>Team</th>
              <th>Gross Points</th>
              <th>Transfer Cost</th>
              <th>Net Points</th>
            </tr>
          </thead>
          <tbody>
            {winners.map((w) => (
              <tr key={`${w.gameweek}-${w.manager_id}`}>
                <td className="gw-cell">{w.gameweek}</td>
                <td className="manager-cell">
                  <strong>{w.manager_name}</strong>
                </td>
                <td className="team-cell">{w.team_name}</td>
                <td className="gross-points">{w.gross_points}</td>
                <td className="transfer-cost">
                  {w.transfer_cost > 0 ? `-${w.transfer_cost}` : '—'}
                </td>
                <td className="net-points">
                  <strong>{w.points}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {winners.length === 0 && (
        <p className="no-data">No winner data available</p>
      )}
    </div>
  );
}