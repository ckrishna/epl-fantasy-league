// src/pages/Standings.jsx
import { useEffect, useState } from 'react';
import { getStandings, getWinners } from '../api/client';
import ManagerSquad from '../components/ManagerSquad';
import { computeLeagueFinances } from '../utils/leagueFinances';
import '../styles/Standings.css';

// Rounded to whole dollars -- these are already a projection (see the effect above), so
// showing cents would read as more precise than the figure actually is.
function MoneyBadge({ net }) {
  if (typeof net !== 'number') return null;
  const rounded = Math.round(net);
  const positive = rounded >= 0;
  return (
    <span className={`money-badge ${positive ? 'money-badge-positive' : 'money-badge-negative'}`}>
      {positive ? '+' : '−'}${Math.abs(rounded)}
    </span>
  );
}

export default function Standings({ season = null, seasonLabel = null, resetKey = 0, leagueId = null } = {}) {
  const [standings, setStandings] = useState([]);
  const [loading, setLoading] = useState(false);
const [activeGW, setActiveGW] = useState(null);
const [displayGW, setDisplayGW] = useState(null);  // ← ADD THIS
const [selectedManager, setSelectedManager] = useState(null); // { entryId, teamName, managerName }

// Real-money prize-pool feature -- opt-in per league. `money_config` comes back on
// the standings response itself (null unless the backend resolves a league that's
// actually had scripts/set-league-money-config.mjs run against it -- see
// getMoneyConfigForLeagueId in stats-api). No separate flag or query param: a league
// with no config just never gets one back, and the whole feature is a no-op for it.
const [moneyConfig, setMoneyConfig] = useState(null);
const [finances, setFinances] = useState(new Map()); // manager_id (string) -> {totalWon, net}

// Re-clicking the "Standings" nav tab while already on this page should return from
// the squad view to the list -- App.jsx bumps resetKey on every Standings tab click
// (even when it's already the active tab) specifically so this effect can catch that.
useEffect(() => {
  setSelectedManager(null);
}, [resetKey]);


useEffect(() => {
  // Guards against a stale response overwriting a newer one. Matters now that `season`
  // can change automatically right after mount (URL routing resolves a leagueId to a
  // season asynchronously -- see App.jsx), not just from a user's deliberate dropdown
  // click like before: landing on /212889 fires a first fetch for season=null (current),
  // then almost immediately a second fetch for season="2025/26" once the URL resolves.
  // Without this guard, whichever response happened to arrive LAST wins regardless of
  // which request was newer -- confirmed live 2026-08-14, the current-season (all-zero,
  // pre-season) response occasionally landed after the real 2025/26 one and overwrote it.
  let cancelled = false;
  setLoading(true);

  // Fetch standings with no GW param (will use active_gameweek from API), scoped to
  // whichever season is selected (null = current season, handled server-side).
  getStandings(null, season, leagueId).then(data => {
    if (cancelled) return;
    // Set activeGW from the API response
    if (data.active_gameweek) {
      setActiveGW(data.active_gameweek);
    }
    if (data.gameweek) {
      setDisplayGW(data.gameweek);  // ← ADD THIS
    }
    setMoneyConfig(data.money_config || null);

    const sorted = (data.standings || [])
      .sort((a, b) => b.total_points - a.total_points)
      .map((manager, idx) => ({
        ...manager,
        rank: idx + 1
      }));
    setStandings(sorted);
    setLoading(false);
  }).catch(err => {
    if (cancelled) return;
    console.error('Error fetching standings:', err);
    setLoading(false);
  });

  return () => { cancelled = true; };
}, [season, leagueId]);

// Only runs when the backend actually resolved a money_config for this league (see
// above) and only for the current season (a past/historical season has no meaningful
// "live projection" -- the backend already only returns a config for non-historical
// requests, but this stays defensive rather than trusting that invariant silently).
// Recomputes whenever the underlying standings change so the green/red figures always
// reflect wherever the season actually stands right now -- explicitly a live
// projection assuming today's standings are final, not a "confirmed money only" figure
// (app owner's choice).
useEffect(() => {
  if (!moneyConfig || season || standings.length === 0) {
    setFinances(new Map());
    return;
  }
  let cancelled = false;
  getWinners(season, leagueId).then((data) => {
    if (cancelled) return;
    const winnersHistory = data.finished_gameweeks || [];
    return computeLeagueFinances({
      standings,
      winnersHistory,
      fetchGwStandings: (gw) => getStandings(gw, season, leagueId).then((d) => d.standings || []),
      config: moneyConfig
    }).then((result) => {
      if (!cancelled) setFinances(result);
    });
  }).catch(err => {
    if (cancelled) return;
    console.error('Error computing league finances:', err);
  });
  return () => { cancelled = true; };
}, [moneyConfig, season, leagueId, standings]);

  if (loading) return <div className="loading">Loading standings...</div>;

  // The squad pitch view only ever reads the CURRENT season's picks/fixtures (see
  // handleManagerSquad's comment -- upcoming fixtures/form has no meaning for a past
  // season). `season` here is null for "current" and an explicit string for a past
  // season picked from the dropdown, so that's the only signal this component needs.
  const isCurrentSeason = !season;

  if (selectedManager) {
    return (
      <div className="standings-page">
        <ManagerSquad
          entryId={selectedManager.entryId}
          teamName={selectedManager.teamName}
          managerName={selectedManager.managerName}
          onClose={() => setSelectedManager(null)}
        />
      </div>
    );
  }

  return (
    <div className="standings-page">
      <h2>League Standings{seasonLabel && <span className="page-title-note">({seasonLabel})</span>}</h2>

      {/* Mobile Card View */}
      <div className="standings-cards">
        {/* Column labels shown once above the list instead of repeated on every card
            (each card used to carry its own "GW N"/"Total" labels, which just meant
            reading the same two words N times scrolling down the page). Rank/team
            columns are left blank here on purpose -- they're self-explanatory without
            a label -- and reuse the exact same classes as a real card so the numbers
            below line up under these labels without any separate width bookkeeping. */}
        <div className="standings-cards-header" aria-hidden="true">
          <div className="card-rank"></div>
          <div className="card-info"></div>
          <div className="card-stats">
            <div className="stat">
              <span className="stat-label">GW {displayGW || activeGW}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Net Total</span>
            </div>
          </div>
        </div>
        {standings.map((manager) => {
          const openSquad = () => setSelectedManager({ entryId: manager.manager_id, teamName: manager.real_name, managerName: manager.team_nickname });
          return (
            <div
              key={manager.manager_id}
              className={[
                'standings-card',
                manager.rank === 1 ? 'top-1' : '',
                // Full-card click, same pattern as GWWinners' row-link (see GWWinners.css
                // .winners-row-link) -- only wired up for the current season, since the
                // squad view it opens has no meaning for a past season's picks.
                isCurrentSeason ? 'standings-row-link' : ''
              ].filter(Boolean).join(' ')}
              onClick={isCurrentSeason ? openSquad : undefined}
            >
              <div className="card-rank">
                <span className="rank-badge">{manager.rank}</span>
              </div>
              <div className="card-info">
                <p className={`card-team ${isCurrentSeason ? 'card-team-link' : ''}`}>{manager.real_name}</p>
                {/* Historical (pre-2025/26) seasons only have a manager's real name on
                    record, no separate team nickname -- team_nickname is null for those
                    rows rather than a blank/duplicate line. The money badge sits next to
                    THIS line (the actual fantasy team name, e.g. "Self-Goal") rather than
                    the real-name line above, per direct feedback -- "team name" means the
                    team_nickname field here, confusingly, since card-team/real_name was
                    already using that class name for the manager's own name. */}
                {manager.team_nickname && (
                  <p className="card-manager">
                    <span className="card-manager-name">{manager.team_nickname}</span>
                    {moneyConfig && <MoneyBadge net={finances.get(String(manager.manager_id))?.net} />}
                  </p>
                )}
              </div>
              <div className="card-stats">
                <div className="stat">
                  <span className="stat-value">{manager.points_this_week}</span>
                </div>
                <div className="stat">
                  <span className="stat-value">{manager.total_points}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Desktop Table View */}
      <table className="standings-table">
        <thead>
          <tr>
            <th>RANK</th>
            <th>TEAM & MANAGER</th>
            <th className="col-divider">GW {displayGW || activeGW}</th>
            <th className="col-divider">Net Total</th>
          </tr>
        </thead>
        <tbody>
          {standings.map((manager) => {
            const openSquad = () => setSelectedManager({ entryId: manager.manager_id, teamName: manager.real_name, managerName: manager.team_nickname });
            return (
              <tr
                key={manager.manager_id}
                className={[
                  manager.rank === 1 ? 'top-1' : '',
                  isCurrentSeason ? 'standings-row-link' : ''
                ].filter(Boolean).join(' ')}
                onClick={isCurrentSeason ? openSquad : undefined}
                title={isCurrentSeason ? `View ${manager.real_name}'s squad` : undefined}
              >
                <td className="rank">
                  <span className="rank-badge">{manager.rank}</span>
                </td>
                <td className="team-manager">
                  <div className={`team-name ${isCurrentSeason ? 'team-name-link' : ''}`}>{manager.real_name}</div>
                  {manager.team_nickname && (
                    <div className="manager-name">
                      <span className="manager-name-text">{manager.team_nickname}</span>
                      {moneyConfig && <MoneyBadge net={finances.get(String(manager.manager_id))?.net} />}
                    </div>
                  )}
                </td>
                <td className="week-points col-divider">{manager.points_this_week}</td>
                <td className="points col-divider">{manager.total_points}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {standings.length === 0 && (
        <p className="no-data">No standings data available</p>
      )}
    </div>
  );
}
