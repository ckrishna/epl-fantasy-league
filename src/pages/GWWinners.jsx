// src/pages/GWWinners.jsx - Updated with compact summary
import { useEffect, useMemo, useState } from 'react';
import { getWinners, getStandings } from '../api/client';
import '../styles/GWWinners.css';

// Shared by both tables on this page (the drill-down GWDetail table and the main "All
// Gameweek Winners" table) -- click a header to sort by that column, click again to
// flip direction. `accessor` pulls the comparable value off a row; `defaultDir` picks
// which direction feels natural on a column's FIRST click (numbers high-to-low, names
// A-to-Z), separately from whatever direction it's currently sorted in.
function useSortableRows(rows, columns, defaultKey, defaultDir = 'desc') {
  const [sortKey, setSortKey] = useState(defaultKey);
  const [sortDir, setSortDir] = useState(defaultDir);

  const sorted = useMemo(() => {
    const column = columns.find((c) => c.key === sortKey);
    if (!column) return rows;
    const copy = rows.slice();
    copy.sort((a, b) => {
      const av = column.accessor(a);
      const bv = column.accessor(b);
      if (typeof av === 'string' || typeof bv === 'string') {
        const cmp = String(av).localeCompare(String(bv), undefined, { sensitivity: 'base' });
        return sortDir === 'asc' ? cmp : -cmp;
      }
      const an = av ?? 0;
      const bn = bv ?? 0;
      return sortDir === 'asc' ? an - bn : bn - an;
    });
    return copy;
  }, [rows, columns, sortKey, sortDir]);

  const onSort = (key) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDir(columns.find((c) => c.key === key)?.defaultDir || 'desc');
  };

  return { sorted, sortKey, sortDir, onSort };
}

function SortableTh({ column, sortKey, sortDir, onSort }) {
  const isActive = sortKey === column.key;
  return (
    <th
      className={`${column.className || ''} sortable-th`.trim()}
      onClick={() => onSort(column.key)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSort(column.key);
        }
      }}
      role="button"
      tabIndex={0}
      aria-sort={isActive ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {column.label}
      <span className={`sort-arrow ${isActive ? 'active' : ''}`} aria-hidden="true">
        {isActive ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
      </span>
    </th>
  );
}

const DETAIL_COLUMNS = [
  { key: 'rank', label: 'Rank', className: 'gw-cell', accessor: (m) => m.rank, defaultDir: 'asc' },
  { key: 'manager', label: 'Manager', className: 'team-cell desktop-only', accessor: (m) => m.real_name || '', defaultDir: 'asc' },
  { key: 'team', label: 'Team', className: 'manager-cell', accessor: (m) => m.team_nickname || m.real_name || '', defaultDir: 'asc' },
  { key: 'gross', label: 'Gross Points', className: 'gross-points desktop-only', accessor: (m) => m.points_this_week ?? 0, defaultDir: 'desc' },
  { key: 'transfer', label: 'Transfer Cost', className: 'transfer-cost desktop-only', accessor: (m) => m.transfer_cost ?? 0, defaultDir: 'desc' },
  { key: 'net', label: 'Net Total', className: 'net-points', accessor: (m) => m.net_points ?? 0, defaultDir: 'desc' }
];

// Clicking a row in "All Gameweek Winners" swaps in the full manager listing for that
// specific gameweek, ranked by THAT week's net points (leader on top) rather than the
// season-long total Standings itself sorts by. Reuses the existing /standings endpoint
// with an explicit gw param -- queryLeagueStandings(gw, season) already returns every
// manager's points_this_week/transfer_cost/net_points for an arbitrary past gameweek
// (it's the same data Standings' own walk-back logic reads), so this needed no backend
// change at all.
function GWDetail({ gameweek, season, leagueId }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // See Standings.jsx's main fetch effect for why this guard exists -- same
    // stale-response risk any time `season` can change shortly after mount.
    let cancelled = false;
    setLoading(true);
    getStandings(gameweek, season, leagueId).then((data) => {
      if (cancelled) return;
      const sorted = (data.standings || [])
        .slice()
        .sort((a, b) => (b.net_points ?? 0) - (a.net_points ?? 0))
        .map((m, idx) => ({ ...m, rank: idx + 1 }));
      setRows(sorted);
      setLoading(false);
    }).catch((err) => {
      if (cancelled) return;
      console.error('Error fetching GW detail standings:', err);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [gameweek, season, leagueId]);

  const { sorted, sortKey, sortDir, onSort } = useSortableRows(rows, DETAIL_COLUMNS, 'rank', 'asc');

  if (loading) return <div className="loading">Loading Gameweek {gameweek}...</div>;

  return (
    <div className="winners-table-section">
      <h3>Gameweek {gameweek} &mdash; Full Standings</h3>
      <table className="winners-table">
        <thead>
          <tr>
            {DETAIL_COLUMNS.map((col) => (
              <SortableTh key={col.key} column={col} sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((m) => (
            <tr key={m.manager_id} className={m.rank === 1 ? 'top-1' : ''}>
              <td className="gw-cell">{m.rank}</td>
              <td className="team-cell desktop-only">{m.real_name}</td>
              <td className="manager-cell">{m.team_nickname || m.real_name}</td>
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

const WINNERS_COLUMNS = [
  { key: 'gameweek', label: 'GW', className: 'gw-cell', accessor: (w) => w.gameweek, defaultDir: 'desc' },
  { key: 'manager', label: 'Manager', className: 'team-cell desktop-only', accessor: (w) => w.real_name || '', defaultDir: 'asc' },
  { key: 'team', label: 'Team', className: 'manager-cell', accessor: (w) => w.team_nickname || w.real_name || '', defaultDir: 'asc' },
  { key: 'gross', label: 'Gross Points', className: 'gross-points desktop-only', accessor: (w) => w.gross_points ?? 0, defaultDir: 'desc' },
  { key: 'transfer', label: 'Transfer Cost', className: 'transfer-cost desktop-only', accessor: (w) => w.transfer_cost ?? 0, defaultDir: 'desc' },
  { key: 'net', label: 'Net Total', className: 'net-points', accessor: (w) => w.net_points ?? 0, defaultDir: 'desc' }
];

export default function GWWinners({ season = null, seasonLabel = null, resetKey = 0, leagueId = null, seasonPicker = null } = {}) {
  const [winners, setWinners] = useState([]);
  const [activeGW, setActiveGW] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selectedGW, setSelectedGW] = useState(null);
  // Clicking a "Top Winners" card filters the table below to just that manager's wins
  // (click again, or the Clear button, to go back to everyone). Not a link to anywhere
  // else -- the earlier always-on highlight on #1 implied the cards were clickable when
  // they weren't; now they actually are, and only the one you've selected gets called
  // out visually.
  const [filterEntryId, setFilterEntryId] = useState(null);

  // Re-clicking the "GW Winners" nav tab while already on this page should return from
  // a gameweek's full listing back to the summary -- App.jsx bumps resetKey on every
  // GW Winners tab click (even when it's already the active tab), same pattern as
  // Standings' manager-squad view.
  useEffect(() => {
    setSelectedGW(null);
    setFilterEntryId(null);
  }, [resetKey]);

  // Switching seasons via the dropdown while a gameweek's full listing is open would
  // otherwise keep showing that GW number under the newly-selected season -- close it
  // back to the summary instead. Same for a manager filter -- entry_ids aren't
  // guaranteed to mean the same manager across seasons.
  useEffect(() => {
    setSelectedGW(null);
    setFilterEntryId(null);
  }, [season]);

  useEffect(() => {
    // See Standings.jsx's main fetch effect for why this guard exists -- same
    // stale-response risk any time `season` can change shortly after mount (URL
    // routing resolving a leagueId asynchronously, not just a dropdown click).
    let cancelled = false;
    setLoading(true);
    getWinners(season, leagueId).then(data => {
      if (cancelled) return;
      const flatWinners = [];
      (data.finished_gameweeks || []).forEach(gwData => {
        // More than one winner for this gameweek means it was a tie (see winners.mjs
        // -- ties are already handled server-side by listing every co-winner, not
        // picking one arbitrarily). Computed once here per gameweek rather than in the
        // render loop, since it only depends on this one gwData.winners array.
        const isTied = gwData.winners.length > 1;
        gwData.winners.forEach(winner => {
          flatWinners.push({
            gameweek: gwData.gameweek,
            entry_id: winner.entry_id,
            team_nickname: winner.team_nickname,
            real_name: winner.real_name,
            gross_points: winner.gross_points,
            transfer_cost: winner.transfer_cost,
            net_points: winner.net_points,
            isTied
          });
        });
      });

      setWinners(flatWinners);
      setActiveGW(data.active_gameweek);
      setLoading(false);
    }).catch(err => {
      if (cancelled) return;
      console.error('Error fetching winners:', err);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [season, leagueId]);

  const managerStats = {};
  winners.forEach(w => {
    if (!managerStats[w.entry_id]) {
      managerStats[w.entry_id] = {
        entry_id: w.entry_id,
        team_nickname: w.team_nickname,
        real_name: w.real_name,
        wins: 0,
        total_points: 0
      };
    }
    managerStats[w.entry_id].wins += 1;
    managerStats[w.entry_id].total_points += w.net_points;
  });

  const sortedStats = Object.values(managerStats)
    .sort((a, b) => b.wins - a.wins);

  const filteredWinners = filterEntryId
    ? winners.filter((w) => w.entry_id === filterEntryId)
    : winners;

  // Defaults to GW descending -- most recent gameweek on top, same order the "TIED"
  // examples get spotted in most often (per direct feedback).
  const { sorted: sortedWinners, sortKey, sortDir, onSort } =
    useSortableRows(filteredWinners, WINNERS_COLUMNS, 'gameweek', 'desc');

  if (loading) return <div className="loading">Loading weekly winners...</div>;

  if (selectedGW) {
    return (
      <div className="gw-winners-page">
        <div className="page-title-row">
          <h2>GW Winners</h2>
          {seasonPicker}
        </div>
        {/* Same affordance as ManagerSquad's "Back to standings" button -- re-clicking
            the GW Winners nav tab does the same thing (see the resetKey effect above),
            but with no on-screen cue for that most people won't discover it. The
            "GW{n} Standings" bit after it is plain context, not part of the control --
            only "Back to GW Winners" itself is clickable (per direct feedback). */}
        <div className="winners-back-row">
          <button type="button" className="winners-back-btn" onClick={() => setSelectedGW(null)}>
            <span aria-hidden="true">&larr;</span> Back to GW Winners
          </button>
          <span className="winners-back-context">(GW{selectedGW} Standings)</span>
        </div>
        <GWDetail gameweek={selectedGW} season={season} leagueId={leagueId} />
      </div>
    );
  }

  const filteredManagerName = filterEntryId ? managerStats[filterEntryId]?.real_name : null;

  return (
    <div className="gw-winners-page">
      <div className="page-title-row">
        <h2>GW Winners</h2>
        {seasonPicker}
      </div>

      {/* Manager Wins Summary - Compact */}
      <div className="winners-dashboard">
        <h3>Top Winners</h3>
        <div className="stats-grid">
          {sortedStats.slice(0, 5).map((stat, idx) => {
            const isActive = filterEntryId === stat.entry_id;
            return (
              <button
                type="button"
                key={stat.entry_id}
                className={`stat-card ${isActive ? 'active' : ''}`}
                aria-pressed={isActive}
                onClick={() => setFilterEntryId((prev) => (prev === stat.entry_id ? null : stat.entry_id))}
                title={`Show only ${stat.real_name}'s gameweek wins`}
              >
                <div className="stat-rank">#{idx + 1}</div>
                <div className="stat-team">{stat.real_name}</div>
                {/* Historical seasons only have a real name on record, no team
                    nickname -- team_nickname is null for those rows. */}
                {stat.team_nickname && <div className="stat-manager">{stat.team_nickname}</div>}
                <div className="stat-wins">{stat.wins} <span>wins</span></div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Full Table View -- each row belongs to one gameweek; clicking it opens the
          full manager listing for that gameweek (GWDetail above), ranked by that
          week's net points with the leader on top. Headers sort the table; clicking a
          "Top Winners" card above filters it down to one manager. */}
      <div className="winners-table-section">
        <div className="winners-table-heading">
          <h3>All Gameweek Winners</h3>
          {filterEntryId && (
            <div className="winners-filter-banner">
              <span>Showing wins by {filteredManagerName}</span>
              <button type="button" className="winners-filter-clear" onClick={() => setFilterEntryId(null)}>
                Show all
              </button>
            </div>
          )}
        </div>
        <table className="winners-table">
          <thead>
            <tr>
              {WINNERS_COLUMNS.map((col) => (
                <SortableTh key={col.key} column={col} sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedWinners.map((w) => (
              <tr
                key={`${w.gameweek}-${w.entry_id}`}
                className={`winners-row-link ${w.isTied ? 'winners-row-tied' : ''}`}
                onClick={() => setSelectedGW(w.gameweek)}
                title={w.isTied ? `Tied for the win in GW${w.gameweek} -- view full standings` : `View full GW${w.gameweek} standings`}
              >
                <td className="gw-cell">{w.gameweek}</td>
                <td className="team-cell desktop-only">{w.real_name}</td>
                <td className="manager-cell">{w.team_nickname || w.real_name}</td>
                <td className="gross-points desktop-only">{w.gross_points}</td>
                <td className="transfer-cost desktop-only">
                  {w.transfer_cost > 0 ? `-${w.transfer_cost}` : '—'}
                </td>
                <td className="net-points">
                  {w.isTied && <span className="tied-badge">Tied</span>}
                  <strong>{w.net_points}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {filteredWinners.length === 0 && winners.length > 0 && (
          <p className="no-data">No wins for this manager yet</p>
        )}
      </div>

      {winners.length === 0 && (
        <p className="no-data">No winner data available</p>
      )}
    </div>
  );
}
