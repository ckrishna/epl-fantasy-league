// src/pages/GWWinners.jsx - Updated with compact summary
import { useEffect, useState } from 'react';
import { getWinners, getStandings } from '../api/client';
import '../styles/GWWinners.css';

// Clicking a row in "All Gameweek Winners" swaps in the full manager listing for that
// specific gameweek, ranked by THAT week's net points (leader on top) rather than the
// season-long total Standings itself sorts by. Reuses the existing /standings endpoint
// with an explicit gw param -- queryLeagueStandings(gw, season) already returns every
// manager's points_this_week/transfer_cost/net_points for an arbitrary past gameweek
// (it's the same data Standings' own walk-back logic reads), so this needed no backend
// change at all.
function GWDetail({ gameweek, season }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getStandings(gameweek, season).then((data) => {
      const sorted = (data.standings || [])
        .slice()
        .sort((a, b) => (b.net_points ?? 0) - (a.net_points ?? 0))
        .map((m, idx) => ({ ...m, rank: idx + 1 }));
      setRows(sorted);
      setLoading(false);
    }).catch((err) => {
      console.error('Error fetching GW detail standings:', err);
      setLoading(false);
    });
  }, [gameweek, season]);

  if (loading) return <div className="loading">Loading Gameweek {gameweek}...</div>;

  return (
    <div className="winners-table-section">
      <h3>Gameweek {gameweek} &mdash; Full Standings</h3>
      <table className="winners-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th className="desktop-only">Team</th>
            <th>Manager</th>
            <th className="desktop-only">Gross Points</th>
            <th className="desktop-only">Transfer Cost</th>
            <th>Net Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.manager_id} className={m.rank === 1 ? 'top-1' : ''}>
              <td className="gw-cell">{m.rank}</td>
              <td className="team-cell desktop-only">{m.team_name}</td>
              <td className="manager-cell">{m.manager_name || m.team_name}</td>
              <td className="gross-points desktop-only">{m.points_this_week}</td>
              <td className="transfer-cost desktop-only">
                {m.transfer_cost > 0 ? `-${m.transfer_cost}` : '—'}
              </td>
              <td className="net-points">
                <strong>{m.net_points}</strong>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {rows.length === 0 && (
        <p className="no-data">No standings data available for this gameweek</p>
      )}
    </div>
  );
}

export default function GWWinners({ season = null, seasonLabel = null, resetKey = 0 } = {}) {
  const [winners, setWinners] = useState([]);
  const [activeGW, setActiveGW] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selectedGW, setSelectedGW] = useState(null);

  // Re-clicking the "GW Winners" nav tab while already on this page should return from
  // a gameweek's full listing back to the summary -- App.jsx bumps resetKey on every
  // GW Winners tab click (even when it's already the active tab), same pattern as
  // Standings' manager-squad view.
  useEffect(() => {
    setSelectedGW(null);
  }, [resetKey]);

  // Switching seasons via the dropdown while a gameweek's full listing is open would
  // otherwise keep showing that GW number under the newly-selected season -- close it
  // back to the summary instead.
  useEffect(() => {
    setSelectedGW(null);
  }, [season]);

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

  if (selectedGW) {
    return (
      <div className="gw-winners-page">
        <h2>Gameweek Winners{seasonLabel && <span className="page-title-note">({seasonLabel})</span>}</h2>
        <GWDetail gameweek={selectedGW} season={season} />
      </div>
    );
  }

  const managerStats = {};
  winners.forEach(w => {
    if (!managerStats[w.entry_id]) {
      managerStats[w.entry_id] = {
        entry_id: w.entry_id,
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
      <h2>Gameweek Winners{seasonLabel && <span className="page-title-note">({seasonLabel})</span>}</h2>

      {/* Manager Wins Summary - Compact */}
      <div className="winners-dashboard">
        <h3>Top Winners</h3>
        <div className="stats-grid">
          {sortedStats.slice(0, 5).map((stat, idx) => (
            <div key={stat.entry_id} className={`stat-card ${idx === 0 ? 'top-1' : ''}`}>
              <div className="stat-rank">#{idx + 1}</div>
              <div className="stat-team">{stat.team_name}</div>
              {/* Historical seasons only have a real name on record, no team
                  nickname -- manager_name is null for those rows. */}
              {stat.manager_name && <div className="stat-manager">{stat.manager_name}</div>}
              <div className="stat-wins">{stat.wins} <span>wins</span></div>
            </div>
          ))}
        </div>
      </div>

      {/* Full Table View -- each row belongs to one gameweek; clicking it opens the
          full manager listing for that gameweek (GWDetail above), ranked by that
          week's net points with the leader on top. */}
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
              <th>Net Total</th>
            </tr>
          </thead>
          <tbody>
            {winners.map((w) => (
              <tr
                key={`${w.gameweek}-${w.entry_id}`}
                className="winners-row-link"
                onClick={() => setSelectedGW(w.gameweek)}
                title={`View full GW${w.gameweek} standings`}
              >
                <td className="gw-cell">{w.gameweek}</td>
                <td className="team-cell desktop-only">{w.team_name}</td>
                <td className="manager-cell">{w.manager_name || w.team_name}</td>
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
