// src/pages/GWWinners.jsx - Updated with compact summary
import { useEffect, useState } from 'react';
import { getWinners } from '../api/client';
import '../styles/GWWinners.css';

export default function GWWinners({ season = null } = {}) {
  const [winners, setWinners] = useState([]);
  const [activeGW, setActiveGW] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    getWinners(season).then(data => {
      const flatWinners = [];
      (data.finished_gameweeks || []).forEach(gwData => {
        gwData.winners.forEach(winner => {
          flatWinners.push({
            gameweek: gwData.gameweek,
            entry_id: winner.entry_id,
            manager_name: winner.manager_name,
            team_name: winner.team_name,
            gross_points: winner.gross_points,
            transfer_cost: winner.transfer_cost,
            net_points: winner.net_points
          });
        });
      });
      
      setWinners(flatWinners);
      setActiveGW(data.active_gameweek);
      setLoading(false);
    }).catch(err => {
      console.error('Error fetching winners:', err);
      setLoading(false);
    });
  }, [season]);

  if (loading) return <div className="loading">Loading weekly winners...</div>;

  const managerStats = {};
  winners.forEach(w => {
    if (!managerStats[w.entry_id]) {
      managerStats[w.entry_id] = {
        manager_name: w.manager_name,
        team_name: w.team_name,
        wins: 0,
        total_points: 0
      };
    }
    managerStats[w.entry_id].wins += 1;
    managerStats[w.entry_id].total_points += w.net_points;
  });

  const sortedStats = Object.values(managerStats)
    .sort((a, b) => b.wins - a.wins);

  return (
    <div className="gw-winners-page">
      <h2>Gameweek Winners</h2>
      <p>Weekly winner determined by highest net points (after transfer costs)</p>
      
      {/* Manager Wins Summary - Compact */}
      <div className="winners-dashboard">
        <h3>Top Winners</h3>
        <div className="stats-grid">
          {sortedStats.slice(0, 5).map((stat, idx) => (
            <div key={stat.manager_name} className="stat-card">
              <div className="stat-rank">#{idx + 1}</div>
              <div className="stat-team">{stat.team_name}</div>
              <div className="stat-manager">{stat.manager_name}</div>
              <div className="stat-wins">{stat.wins} <span>wins</span></div>
            </div>
          ))}
        </div>
      </div>

      {/* Full Table View */}
      <div className="winners-table-section">
        <h3>All Gameweek Winners</h3>
        <table className="winners-table">
          <thead>
            <tr>
              <th>GW</th>
              <th className="desktop-only">Team</th>
              <th>Manager</th>
              <th className="desktop-only">Gross Points</th>
              <th className="desktop-only">Transfer Cost</th>
              <th>Net Points</th>
            </tr>
          </thead>
          <tbody>
            {winners.map((w) => (
              <tr key={`${w.gameweek}-${w.entry_id}`}>
                <td className="gw-cell">{w.gameweek}</td>
                <td className="team-cell desktop-only">{w.team_name}</td>
                <td className="manager-cell">{w.manager_name}</td>
                <td className="gross-points desktop-only">{w.gross_points}</td>
                <td className="transfer-cost desktop-only">
                  {w.transfer_cost > 0 ? `-${w.transfer_cost}` : '—'}
                </td>
                <td className="net-points">
                  <strong>{w.net_points}</strong>
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
