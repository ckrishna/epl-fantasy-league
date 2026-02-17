// src/pages/GWWinners.jsx - Updated for new API response
import { useEffect, useState } from 'react';
import { getWinners } from '../api/client';
import '../styles/GWWinners.css';

export default function GWWinners() {
  const [winners, setWinners] = useState([]);
  const [activeGW, setActiveGW] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    getWinners().then(data => {
      // Flatten the nested structure: finished_gameweeks[].winners[] -> flat array
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
      
      // API already returns newest first
      setWinners(flatWinners);
      setActiveGW(data.active_gameweek);
      setLastUpdated(data.last_updated);
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
    if (!managerStats[w.entry_id]) {
      managerStats[w.entry_id] = {
        manager_name: w.manager_name,
        team_name: w.team_name,
        wins: 0,
        total_points: 0,
        avg_points: 0
      };
    }
    managerStats[w.entry_id].wins += 1;
    managerStats[w.entry_id].total_points += w.net_points;
  });

  // Calculate averages and sort by wins
  const sortedStats = Object.values(managerStats)
    .map(stat => ({
      ...stat,
      avg_points: (stat.total_points / stat.wins).toFixed(1)
    }))
    .sort((a, b) => b.wins - a.wins);

  // Format last updated timestamp with both timezones
  const formatTime = (isoString) => {
    if (!isoString) return 'N/A';
    const date = new Date(isoString);
    
    // Pacific time (local)
    const pacificTime = date.toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
    
    // UTC time
    const utcTime = date.toLocaleString('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
    
    return {
      pacific: pacificTime,
      utc: utcTime
    };
  };

  const timeInfo = formatTime(lastUpdated);

  return (
    <div className="gw-winners-page">
      <h2>Gameweek Winners</h2>
      <p>Weekly winner determined by highest net points (after transfer costs)</p>
      
      {/* Info bar - improved spacing */}
      <div className="winners-info-bar">
        <div className="info-item">
          <span className="info-label">Active GW:</span>
          <span className="info-value">{activeGW}</span>
        </div>
        <div className="info-item">
          <span className="info-label">Last Updated:</span>
          <div className="time-display">
            <div className="time-row">
              <span className="tz-label">Pacific:</span>
              <span className="tz-time">{timeInfo.pacific}</span>
            </div>
            <div className="time-row">
              <span className="tz-label">UTC:</span>
              <span className="tz-time">{timeInfo.utc}</span>
            </div>
          </div>
        </div>
      </div>
      
      {/* Dashboard Summary */}
      <div className="winners-dashboard">
        <h3>Manager Wins Summary (Top 5)</h3>
        <div className="stats-grid">
          {sortedStats.slice(0, 5).map((stat, idx) => (
            <div key={stat.manager_name} className="stat-card">
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

      {/* Full Table View */}
      <div className="winners-table-section">
        <h3>All Gameweek Winners (Latest First)</h3>
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
              <tr key={`${w.gameweek}-${w.entry_id}`}>
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
