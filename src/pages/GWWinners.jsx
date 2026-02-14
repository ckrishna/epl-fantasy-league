// src/pages/GWWinners.jsx
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

  // Group by gameweek
  const byGW = {};
  winners.forEach(w => {
    if (!byGW[w.gameweek]) byGW[w.gameweek] = [];
    byGW[w.gameweek].push(w);
  });

  return (
    <div className="gw-winners-page">
      <h2>Gameweek Winners</h2>
      <p>Weekly winner - highest net points after transfers</p>
      <div className="winners-timeline">
        {Object.entries(byGW)
          .sort(([a], [b]) => parseInt(b) - parseInt(a))
          .map(([gw, gwWinners]) => (
            <div key={gw} className="gw-group">
              <h3>Gameweek {gw}</h3>
              <div className="winners-list">
                {gwWinners.map(w => (
                  <div key={`${gw}-${w.manager_id}`} className="winner-card">
                    <p className="winner-name">{w.manager_name}</p>
                    <p className="winner-team" style={{fontSize: '0.85rem', color: '#666', marginBottom: '0.5rem'}}>{w.team_name}</p>
                    <p className="winner-points">{w.points} pts</p>
                    <p style={{fontSize: '0.75rem', color: '#999'}}>
                      {w.transfer_cost > 0 ? `(${w.gross_points} - ${w.transfer_cost})` : 'No deductions'}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
      </div>
      {winners.length === 0 && (
        <p className="no-data">No winner data available</p>
      )}
    </div>
  );
}