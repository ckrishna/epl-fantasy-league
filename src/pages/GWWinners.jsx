// src/pages/GWWinners.jsx
import { useEffect, useState } from 'react';
import { getWinners } from '../api/client';
import '../styles/GWWinners.css';

export default function GWWinners() {
  const [winners, setWinners] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    getWinners(25).then(data => {
      setWinners(data.winners || []);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="loading">Loading weekly winners...</div>;

  // Group by gameweek
  const byGW = {};
  winners.forEach(w => {
    if (!byGW[w.gw]) byGW[w.gw] = [];
    byGW[w.gw].push(w);
  });

  return (
    <div className="gw-winners-page">
      <h2>Gameweek Winners</h2>
      <p>£5 per week to the highest scorer (split if tied)</p>

      <div className="winners-timeline">
        {Object.entries(byGW)
          .sort(([a], [b]) => parseInt(b) - parseInt(a))
          .map(([gw, gwWinners]) => (
            <div key={gw} className="gw-group">
              <h3>Gameweek {gw}</h3>
              <div className="winners-list">
                {gwWinners.map(w => (
                  <div key={`${gw}-${w.name}`} className="winner-card">
                    <p className="winner-name">{w.name}</p>
                    <p className="winner-points">{w.points} points</p>
                    <p className="winner-prize">£{w.prize.toFixed(2)}</p>
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
