// src/App.jsx
import { useEffect, useState } from 'react';
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
  const [activeTab, setActiveTab] = useState('standings');
  const [seasons, setSeasons] = useState([]);
  // null = "current season" (server picks it); only set to a specific string when the
  // user explicitly selects a past season from the dropdown.
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

  const currentSeason = seasons.find((s) => s.current)?.season || null;
  const viewingHistory = selectedSeason !== null && selectedSeason !== currentSeason;
  // Resolved display label for the ScopeNote disclaimer on each page -- selectedSeason
  // is only ever an explicit string (a past season) or null (meaning "current", which
  // the server picks); this resolves null down to the actual current season string so
  // pages always have something concrete to show ("2026/27"), not "current".
  const seasonLabel = selectedSeason || currentSeason;

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-inner">
          <h1 className="app-title">
            <button
              type="button"
              className="app-title-link"
              onClick={() => {
                setSelectedSeason(null);
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
                  setSelectedSeason(value === currentSeason ? null : value);
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
        {activeTab === 'standings' && <Standings season={selectedSeason} seasonLabel={seasonLabel} resetKey={standingsResetKey} />}
        {activeTab === 'winners' && <GWWinners season={selectedSeason} seasonLabel={seasonLabel} resetKey={winnersResetKey} />}
        {activeTab === 'stats' && <Stats season={selectedSeason} seasonLabel={seasonLabel} />}
        {activeTab === 'trends' && <Trends />}
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
