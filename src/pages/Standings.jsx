// src/pages/Standings.jsx - Without Earnings
import { useEffect, useState } from 'react';
import { getStandings } from '../api/client';
import '../styles/Standings.css';

export default function Standings() {
  const [standings, setStandings] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    getStandings().then(data => {
      setStandings(data.standings || []);
      setLoading(false);
    }).catch(err => {
      console.error('Error fetching standings:', err);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="loading">Loading standings...</div>;

  return (
    <div className="standings-page">
      <table className="standings-table">
        <thead>
          <tr>
            <th>RANK</th>
            <th>MANAGER</th>
            <th>TEAM</th>
            <th>TOTAL POINTS</th>
            <th>THIS WEEK</th>
          </tr>
        </thead>
        <tbody>
          {standings.map((manager, idx) => (
            <tr key={manager.manager_id} className={idx < 3 ? 'top-three' : ''}>
              <td className="rank">{manager.rank}</td>
              <td className="manager-name">{manager.manager_name}</td>
              <td className="team-name">{manager.team_name}</td>
              <td className="points">{manager.total_points}</td>
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