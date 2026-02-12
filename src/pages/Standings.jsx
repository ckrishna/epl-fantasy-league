// src/pages/Standings.jsx
import { useEffect, useState } from 'react';
import { getStandings } from '../api/client';
import '../styles/Standings.css';

export default function Standings() {
  const [standings, setStandings] = useState([]);
  const [gw, setGw] = useState(25);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    getStandings(gw).then(data => {
      setStandings(data.standings || []);
      setLoading(false);
    });
  }, [gw]);

  if (loading) return <div className="loading">Loading standings...</div>;

  return (
    <div className="standings-page">
      <div className="gw-selector">
        <label>Gameweek: </label>
        <input 
          type="number" 
          min="1" 
          max="38" 
          value={gw}
          onChange={(e) => setGw(parseInt(e.target.value))}
        />
      </div>

      <table className="standings-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Manager</th>
            <th>Team</th>
            <th>Total Points</th>
            <th>This Week</th>
            <th>Earnings</th>
          </tr>
        </thead>
        <tbody>
          {standings.map((manager, idx) => (
            <tr key={manager.manager_id} className={idx < 3 ? 'top-three' : ''}>
              <td className="rank">
                {idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : idx + 1}
              </td>
              <td className="manager-name">{manager.manager_name}</td>
              <td className="team-name">{manager.team_name}</td>
              <td className="points bold">{manager.total_points}</td>
              <td className="week-points">{manager.points_this_week}</td>
              <td className="earnings">£{manager.earnings?.toFixed(2) || '0.00'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {standings.length === 0 && (
        <p className="no-data">No data available for GW {gw}</p>
      )}
    </div>
  );
}
