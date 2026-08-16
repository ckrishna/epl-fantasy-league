// src/pages/Standings.jsx
import { useEffect, useState } from 'react';
import { getStandings, getWinners } from '../api/client';
import ManagerSquad from '../components/ManagerSquad';
import { computeLeagueFinances } from '../utils/leagueFinances';
import '../styles/Standings.css';

// Rounded to whole dollars -- these are already a projection (see the effect above), so
// showing cents would read as more precise than the figure actually is. Clickable when
// a breakdown is available (stopPropagation so tapping the badge doesn't also trigger
// the row's own click-to-open-squad handler) -- "why is this number what it is" is
// exactly the question a real-money feature needs to answer on demand, not just assert.
function MoneyBadge({ net, onClick }) {
  if (typeof net !== 'number') return null;
  const rounded = Math.round(net);
  const positive = rounded >= 0;
  return (
    <button
      type="button"
      className={`money-badge ${positive ? 'money-badge-positive' : 'money-badge-negative'}`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title="See how this was calculated"
    >
      {positive ? '+' : '−'}${Math.abs(rounded)}
    </button>
  );
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// One line item's plain-English label -- kept out of leagueFinances.js since that file
// is deliberately UI-free (see its own header comment), this is presentation only.
function lineItemLabel(item) {
  switch (item.type) {
    case 'buy_in':
      return 'Buy-in';
    case 'gw_win':
      return `Gameweek ${item.gameweek} win` + (item.tieCount > 1 ? ` (split ${item.tieCount} ways)` : '');
    case 'gw_reassigned':
      return `Gameweek ${item.gameweek} win — runner-up payout*` + (item.tieCount > 1 ? ` (split ${item.tieCount} ways)` : '');
    case 'top_split':
      return `Season ${ordinal(item.rank)}-place payout`;
    default:
      return item.type;
  }
}

// Sort order for the breakdown list: buy-in first (the starting cost), then every GW
// line chronologically, then the season-end payout last -- reads top-to-bottom the way
// the money actually accumulated over the season instead of in whatever order the
// algorithm happened to compute it.
function sortLineItems(items) {
  const rank = (item) => (item.type === 'buy_in' ? 0 : item.type === 'top_split' ? 2 : 1);
  return [...items].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return (a.gameweek ?? 0) - (b.gameweek ?? 0);
  });
}

function MoneyBreakdownModal({ teamName, managerName, finance, onClose }) {
  const items = sortLineItems(finance.breakdown || []);
  const hasReassigned = items.some((i) => i.type === 'gw_reassigned');
  const net = Math.round(finance.net);
  return (
    <div className="money-breakdown-overlay" onClick={onClose}>
      <div className="money-breakdown-modal" onClick={(e) => e.stopPropagation()}>
        <div className="money-breakdown-modal-header">
          <div>
            <h4>{teamName}</h4>
            {managerName && <p className="money-breakdown-modal-subtitle">{managerName}</p>}
          </div>
          <button type="button" className="money-breakdown-close-btn" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <ul className="money-breakdown-list">
          {items.map((item, i) => (
            <li key={i} className="money-breakdown-row">
              <span className="money-breakdown-label">{lineItemLabel(item)}</span>
              <span className={`money-breakdown-amount ${item.amount >= 0 ? 'money-breakdown-amount-positive' : 'money-breakdown-amount-negative'}`}>
                {item.amount >= 0 ? '+' : '−'}${Math.abs(item.amount).toFixed(2)}
              </span>
            </li>
          ))}
        </ul>

        <div className="money-breakdown-net-row">
          <span>Net</span>
          <span className={net >= 0 ? 'money-breakdown-amount-positive' : 'money-breakdown-amount-negative'}>
            {net >= 0 ? '+' : '−'}${Math.abs(net)}
          </span>
        </div>

        {hasReassigned && (
          <p className="money-breakdown-footnote">
            * Last place forfeits a gameweek win unless they win enough to clear the
            league's minimum — that payout goes to whoever was on top once last place
            is excluded from that week's ranking.
          </p>
        )}
      </div>
    </div>
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
const [finances, setFinances] = useState(new Map()); // manager_id (string) -> {totalWon, net, breakdown}
const [breakdownFor, setBreakdownFor] = useState(null); // { teamName, managerName, finance } | null

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
                    {moneyConfig && (
                      <MoneyBadge
                        net={finances.get(String(manager.manager_id))?.net}
                        onClick={() => setBreakdownFor({
                          teamName: manager.real_name,
                          managerName: manager.team_nickname,
                          finance: finances.get(String(manager.manager_id))
                        })}
                      />
                    )}
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
                      {moneyConfig && (
                        <MoneyBadge
                          net={finances.get(String(manager.manager_id))?.net}
                          onClick={() => setBreakdownFor({
                            teamName: manager.real_name,
                            managerName: manager.team_nickname,
                            finance: finances.get(String(manager.manager_id))
                          })}
                        />
                      )}
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

      {breakdownFor && breakdownFor.finance && (
        <MoneyBreakdownModal
          teamName={breakdownFor.teamName}
          managerName={breakdownFor.managerName}
          finance={breakdownFor.finance}
          onClose={() => setBreakdownFor(null)}
        />
      )}
    </div>
  );
}
