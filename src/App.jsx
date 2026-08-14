// src/App.jsx
import { useEffect, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import './styles/App.css';
import Standings from './pages/Standings';
import GWWinners from './pages/GWWinners';
import Stats from './pages/Stats';
import Trends from './pages/Trends';
import Help from './pages/Help';
import { getSeasons } from './api/client';

// Small line icons (Feather-style), not emoji -- emoji ship with their own fixed
// colors we can't override, and the sun emoji's built-in yellow was nearly invisible
// against the toggle's own orange track (confirmed live via screenshot: "barely
// visible"). These use currentColor so App.css can set an explicit, guaranteed-legible
// color for each icon against its own track color.
function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

// Reads any previously-saved choice; a first-time visitor with no saved preference
// gets dark by default (the app's own default, not the OS/browser's light/dark
// preference -- a visitor can still switch via the toggle, which then persists here).
function getInitialTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return 'dark';
}

export default function App() {
  const { leagueId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [activeTab, setActiveTab] = useState('standings');
  const [seasons, setSeasons] = useState([]);
  // null = "current season" (server picks it); only set to a specific string when
  // viewing a past season. The URL's leagueId is the real source of truth for this once
  // seasons has loaded (see the effect below) -- this state exists because a handful of
  // historical seasons (2019/20-2024/25, bulk CSV-imported) have no league_id on record
  // and so have no URL of their own; picking one of those from the dropdown can only set
  // this directly, the same way the dropdown worked before routing existed.
  const [selectedSeason, setSelectedSeason] = useState(null);
  const [theme, setTheme] = useState(getInitialTheme);
  // Bumped on every click of the Standings nav tab (even when it's already the active
  // tab) so Standings.jsx can reset out of the manager-squad view back to the list --
  // that's the "click Standings again to go back" behavior, without lifting the
  // selected-manager state itself up into App.
  const [standingsResetKey, setStandingsResetKey] = useState(0);
  const [winnersResetKey, setWinnersResetKey] = useState(0);

  useEffect(() => {
    getSeasons().then(setSeasons);
  }, []);

  const currentSeasonRow = seasons.find((s) => s.current) || null;

  // Single source of truth for "which season is showing" is the URL's leagueId, resolved
  // against the seasons list once it's loaded (each season row already carries its own
  // league_id -- see handlers/seasons.mjs). Three cases:
  //  - no leagueId at all ("/", or any path that didn't match a real one) -> redirect to
  //    the current season's own league URL, so every visit lands on a stable, bookmarkable
  //    link instead of a bare "/".
  //  - leagueId matches a season we know about -> show that season (current or past).
  //  - leagueId matches nothing -> either a typo, or (confirmed live 2026-08-14, see
  //    DATA_MODEL.md) an id FPL has since recycled to a completely unrelated league.
  //    Falls back to current rather than show a broken page -- and unlike the "/" case
  //    above, this one carries a `notFoundLeagueId` flag on the redirect's location
  //    state, purely so the banner below has something to render. Using location state
  //    (instead of a separate piece of component state) means it clears itself for free
  //    the moment any other navigation happens -- there's no separate "now hide the
  //    banner" case to get wrong.
  useEffect(() => {
    if (seasons.length === 0) return; // wait for the list before deciding anything

    if (!leagueId) {
      if (currentSeasonRow?.league_id != null) {
        navigate(`/${currentSeasonRow.league_id}`, { replace: true });
      }
      return;
    }

    const matched = seasons.find((s) => s.league_id != null && String(s.league_id) === leagueId);
    if (!matched) {
      console.warn(`No known season for league id "${leagueId}" -- falling back to current season.`);
      if (currentSeasonRow?.league_id != null) {
        navigate(`/${currentSeasonRow.league_id}`, { replace: true, state: { notFoundLeagueId: leagueId } });
      }
      return;
    }

    setSelectedSeason(matched.current ? null : matched.season);
  }, [leagueId, seasons, currentSeasonRow, navigate]);

  const notFoundLeagueId = location.state?.notFoundLeagueId ?? null;

  // The actual re-theming happens via CSS custom properties keyed off this attribute
  // (see App.css's `[data-theme='dark']` block) -- this effect's only job is to keep
  // the DOM attribute and localStorage in sync with React state.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);

    // index.html's <meta name="theme-color"> tags only track the OS's own light/dark
    // preference (media queries), so they never move if someone's OS is light but they
    // tap our in-app toggle to dark (or vice versa) -- that mismatch is exactly what
    // left a white status-bar/task-switcher strip showing in dark mode. Overriding the
    // meta tag's content directly here keeps the browser chrome in sync with whatever
    // is actually selected, not just the OS default.
    const bg = theme === 'dark' ? '#0a0a0f' : '#f3f4f6';
    document.querySelectorAll('meta[name="theme-color"]').forEach((tag) => {
      tag.setAttribute('content', bg);
    });
  }, [theme]);

  const currentSeason = currentSeasonRow?.season || null;
  const viewingHistory = selectedSeason !== null && selectedSeason !== currentSeason;
  // Resolved display label for the ScopeNote disclaimer on each page -- selectedSeason
  // is only ever an explicit string (a past season) or null (meaning "current", which
  // the server picks); this resolves null down to the actual current season string so
  // pages always have something concrete to show ("2026/27"), not "current".
  const seasonLabel = selectedSeason || currentSeason;
  // The league_id for whichever season is actually showing (current, or a past season
  // picked from the dropdown) -- distinct from the URL's leagueId, which only ever
  // reflects a season that HAS a league_id (see the dropdown's onChange above). Passed
  // through to Standings/GWWinners so their API calls can disambiguate once a second
  // league shares a season (2026-08-14, multi-league foundation); null for the six
  // historical seasons with no league_id on record, which is correct -- there's nothing
  // to scope against for those, same as omitting the param entirely.
  const viewingLeagueId = (seasons.find((s) => s.season === seasonLabel))?.league_id ?? null;

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-inner">
          <h1 className="app-title">
            <button
              type="button"
              className="app-title-link"
              onClick={() => {
                // Set state directly rather than relying on navigate() to trigger the
                // URL-resolution effect -- if the URL is already at the current league
                // (e.g. the dropdown was just used to view a no-league_id historical
                // season, which doesn't change the URL -- see its onChange below),
                // navigate() to that same URL is a no-op and the leagueId param never
                // actually changes, so that effect would never re-fire. Confirmed live
                // 2026-08-14: this exact sequence left the title button doing nothing.
                setSelectedSeason(null);
                if (currentSeasonRow?.league_id != null) {
                  navigate(`/${currentSeasonRow.league_id}`);
                }
                setActiveTab('standings');
                setStandingsResetKey((k) => k + 1);
              }}
              aria-label="Go to current season standings"
              title="Go to current season standings"
            >
              ⚽ EPL Fantasy League
            </button>
            <button
              type="button"
              className={`app-help-link ${activeTab === 'help' ? 'active' : ''}`}
              onClick={() => setActiveTab('help')}
              aria-label="Help"
              title="Help"
            >
              ?
            </button>
          </h1>

          <div className="app-header-controls">
            {seasons.length > 0 && (
              <select
                className={`league-picker ${viewingHistory ? 'viewing-history' : ''}`}
                value={selectedSeason ?? currentSeason ?? ''}
                onChange={(e) => {
                  const value = e.target.value;
                  const chosen = seasons.find((s) => s.season === value);
                  // Always set state directly -- don't rely solely on navigate()
                  // triggering the URL-resolution effect. That effect only re-runs when
                  // the leagueId URL PARAM actually changes value; picking a no-league_id
                  // historical season never changes the URL at all (nothing to route
                  // through), so switching FROM one of those BACK to a real-league_id
                  // season can navigate to a URL that's unchanged from before that
                  // detour -- a no-op navigate that would otherwise leave selectedSeason
                  // stuck. Confirmed live 2026-08-14: picking 2022/23 then trying to get
                  // back to 2026/27 left the dropdown stuck on 2022/23 for exactly this
                  // reason. Still navigating too (when there's a real league_id) so the
                  // URL stays a shareable/bookmarkable reflection of what's on screen.
                  setSelectedSeason(value === currentSeason ? null : value);
                  if (chosen?.league_id != null) {
                    navigate(`/${chosen.league_id}`);
                  }
                }}
                aria-label="Select league and season"
                title={viewingHistory ? 'Viewing a past season' : undefined}
              >
                {seasons.map((s) => (
                  <option key={s.season} value={s.season}>
                    {s.season}
                    {s.current ? ' (current)' : ''}
                  </option>
                ))}
              </select>
            )}

            <button
              type="button"
              role="switch"
              aria-checked={theme === 'dark'}
              className="theme-toggle"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              <span className="theme-toggle-icon theme-toggle-icon-sun"><SunIcon /></span>
              <span className="theme-toggle-icon theme-toggle-icon-moon"><MoonIcon /></span>
              <span className="theme-toggle-thumb" />
            </button>
          </div>
        </div>
      </header>

      {notFoundLeagueId && (
        <div className="league-not-found-banner" role="alert">
          <span>League ID "{notFoundLeagueId}" wasn't found -- showing {currentSeason} instead.</span>
          <button
            type="button"
            className="league-not-found-dismiss"
            onClick={() => navigate(location.pathname, { replace: true, state: null })}
            aria-label="Dismiss"
          >
            &times;
          </button>
        </div>
      )}

      <nav className="tabs">
        <button
          className={`tab ${activeTab === 'standings' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('standings');
            setStandingsResetKey((k) => k + 1);
          }}
        >
          Standings
        </button>
        <button
          className={`tab ${activeTab === 'winners' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('winners');
            setWinnersResetKey((k) => k + 1);
          }}
        >
          GW Winners
        </button>
        <button
          className={`tab ${activeTab === 'stats' ? 'active' : ''}`}
          onClick={() => setActiveTab('stats')}
        >
          GenBI<sup className="beta-tag">Beta</sup>
        </button>
        <button
          className={`tab ${activeTab === 'trends' ? 'active' : ''}`}
          onClick={() => setActiveTab('trends')}
        >
          Trends
        </button>
      </nav>

      <main className="app-content">
        {activeTab === 'standings' && <Standings season={selectedSeason} seasonLabel={seasonLabel} resetKey={standingsResetKey} leagueId={viewingLeagueId} />}
        {activeTab === 'winners' && <GWWinners season={selectedSeason} seasonLabel={seasonLabel} resetKey={winnersResetKey} leagueId={viewingLeagueId} />}
        {activeTab === 'stats' && <Stats season={selectedSeason} seasonLabel={seasonLabel} />}
        {/* Trends deliberately ignores the season dropdown (its own manager picker spans
            every season) -- leagueId here is always the LIVE league, i.e. which
            league_group_id "your" cross-season history should be scoped to, not
            whatever historical season happens to be selected elsewhere in the app. */}
        {activeTab === 'trends' && <Trends leagueId={currentSeasonRow?.league_id ?? null} />}
        {activeTab === 'help' && <Help />}
      </main>

<footer className="app-footer">
  <p>
    Last updated: {new Date().toLocaleString('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    })} UTC
  </p>
  <button
    type="button"
    className="app-footer-help-link"
    onClick={() => setActiveTab('help')}
  >
    Help & Support
  </button>
  <p className="app-footer-copyright">&copy; {new Date().getFullYear()} candorsolutions.us</p>
</footer>
    </div>
  );
}
