// src/pages/GWWinners.jsx - Updated
import { useEffect, useState } from 'react';
import { getWinners } from '../api/client';
import '../styles/GWWinners.css';

export default function GWWinners() {
  const [winners, setWinners] = useState([]);
  const [loading, setLoading] = useState(false);

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

  return (
    <div className="gw-winners-page">
      <h2>Gameweek Winners</h2>
      <p>Weekly winner determined by highest net points (after transfer costs)</p>
      
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

      {winners.length === 0 && (
        <p className="no-data">No winner data available</p>
      )}
    </div>
  );
}