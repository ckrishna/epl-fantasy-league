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

// Bottom-nav icons (same Feather-style/currentColor convention as Sun/Moon above) --
// one per mobile bottom-nav item (task #177). Help deliberately has no icon here; it
// stays reachable via the "?" header button and the footer link, same as before, since
// the bottom bar only has room for the four primary sections without feeling cramped.
function TrophyIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
      <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" />
      <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function SparklesIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
      <path d="M5 3v4" />
      <path d="M19 17v4" />
      <path d="M3 5h4" />
      <path d="M17 19h4" />
    </svg>
  );
}

function TrendingUpIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
      <polyline points="17 6 23 6 23 12" />
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
  const viewingSeasonRow = seasons.find((s) => s.season === seasonLabel);
  const viewingLeagueId = viewingSeasonRow?.league_id ?? null;

  // Season/league dropdown -- moved (task #177) from its own row under the app header
  // into each page's own title row instead, sitting right next to "League Standings" /
  // "Gameweek Winners" / "League Intelligence". Built once here since the element and
  // its onChange logic are identical everywhere it's used; Trends deliberately never
  // receives this (it ignores the season dropdown -- see its own render call below).
  const seasonPicker = seasons.length > 0 ? (
    <select
      className={`league-picker ${viewingHistory ? 'viewing-history' : ''}`}
      value={selectedSeason ?? currentSeason ?? ''}
      onChange={(e) => {
        const value = e.target.value;
        const chosen = seasons.find((s) => s.season === value);
        // Always set state directly -- don't rely solely on navigate() triggering the
        // URL-resolution effect. That effect only re-runs when the leagueId URL PARAM
        // actually changes value; picking a no-league_id historical season never
        // changes the URL at all (nothing to route through), so switching FROM one of
        // those BACK to a real-league_id season can navigate to a URL that's unchanged
        // from before that detour -- a no-op navigate that would otherwise leave
        // selectedSeason stuck. Confirmed live 2026-08-14: picking 2022/23 then trying
        // to get back to 2026/27 left the dropdown stuck on 2022/23 for exactly this
        // reason. Still navigating too (when there's a real league_id) so the URL stays
        // a shareable/bookmarkable reflection of what's on screen.
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
        </option>
      ))}
    </select>
  ) : null;

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-inner">
          <div className="app-header-row app-header-row-top">
            <h1 className="app-title">
              {/* Plain text, not a link/button -- per direct feedback this shouldn't
                  navigate anywhere. (Previously jumped to the current season's
                  standings; that shortcut is gone, not relocated -- the Standings tab
                  itself still does the same thing.) */}
              ⚽ EPL Fantasy League
              {/* Raw league ID, not the name -- an ID is guaranteed unique across
                  leagues where a human-chosen name isn't (direct feedback). Same line,
                  same font as the title (inherits .app-title's size/weight) rather than
                  a smaller stacked subtitle -- confirmed there's room for it here.
                  Hidden entirely once there's no league_id to show (six historical
                  seasons predate real FPL league tracking -- see DATA_MODEL.md). */}
              {viewingLeagueId != null && (
                <span className="app-league-id">- {viewingLeagueId}</span>
              )}
            </h1>

            <div className="app-header-top-right">
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

              <button
                type="button"
                className={`app-help-link ${activeTab === 'help' ? 'active' : ''}`}
                onClick={() => setActiveTab('help')}
                aria-label="Help"
                title="Help"
              >
                ?
              </button>
            </div>
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

      {/* Mobile-only bottom icon bar (task #177) -- same tabs, same handlers/state as
          .tabs above, just a second nav rendered alongside it. App.css shows exactly
          one of the two at any given width (.tabs hidden, .bottom-nav flex) rather than
          this component picking between them, so there's no duplicated width-detection
          logic in JS. */}
      <nav className="bottom-nav">
        <button
          className={`bottom-nav-item ${activeTab === 'standings' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('standings');
            setStandingsResetKey((k) => k + 1);
          }}
        >
          <TrophyIcon />
          <span>Standings</span>
        </button>
        <button
          className={`bottom-nav-item ${activeTab === 'winners' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('winners');
            setWinnersResetKey((k) => k + 1);
          }}
        >
          <CalendarIcon />
          <span>GW Winners</span>
        </button>
        <button
          className={`bottom-nav-item ${activeTab === 'stats' ? 'active' : ''}`}
          onClick={() => setActiveTab('stats')}
        >
          <span className="bottom-nav-icon-wrap">
            <SparklesIcon />
            <span className="bottom-nav-beta-pill">Beta</span>
          </span>
          <span>GenBI</span>
        </button>
        <button
          className={`bottom-nav-item ${activeTab === 'trends' ? 'active' : ''}`}
          onClick={() => setActiveTab('trends')}
        >
          <TrendingUpIcon />
          <span>Trends</span>
        </button>
      </nav>

      <main className="app-content">
        {activeTab === 'standings' && <Standings season={selectedSeason} seasonLabel={seasonLabel} resetKey={standingsResetKey} leagueId={viewingLeagueId} seasonPicker={seasonPicker} />}
        {activeTab === 'winners' && <GWWinners season={selectedSeason} seasonLabel={seasonLabel} resetKey={winnersResetKey} leagueId={viewingLeagueId} seasonPicker={seasonPicker} />}
        {activeTab === 'stats' && <Stats season={selectedSeason} seasonLabel={seasonLabel} leagueId={viewingLeagueId} seasonPicker={seasonPicker} />}
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
