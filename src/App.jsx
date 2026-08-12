// src/App.jsx
import { useEffect, useState } from 'react';
import './styles/App.css';
import Standings from './pages/Standings';
import GWWinners from './pages/GWWinners';
import Stats from './pages/Stats';
import Help from './pages/Help';
import { getSeasons } from './api/client';

// Reads any previously-saved choice; falls back to the OS/browser's own light/dark
// preference for a first-time visitor rather than always defaulting to light.
function getInitialTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export default function App() {
  const [activeTab, setActiveTab] = useState('standings');
  const [seasons, setSeasons] = useState([]);
  // null = "current season" (server picks it); only set to a specific string when the
  // user explicitly selects a past season from the dropdown.
  const [selectedSeason, setSelectedSeason] = useState(null);
  const [theme, setTheme] = useState(getInitialTheme);

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
          <h1 className="app-title">⚽ EPL Fantasy League</h1>

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
                    {s.league_id ? `League ${s.league_id} — ${s.season}` : s.season}
                    {s.current ? ' (current)' : ''}
                  </option>
                ))}
              </select>
            )}

            <button
              type="button"
              className="theme-toggle"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              <span className={`theme-toggle-option ${theme === 'light' ? 'active' : ''}`}>☀️</span>
              <span className={`theme-toggle-option ${theme === 'dark' ? 'active' : ''}`}>🌙</span>
            </button>
          </div>
        </div>
      </header>

      <nav className="tabs">
        <button
          className={`tab ${activeTab === 'standings' ? 'active' : ''}`}
          onClick={() => setActiveTab('standings')}
        >
          Standings
        </button>
        <button
          className={`tab ${activeTab === 'winners' ? 'active' : ''}`}
          onClick={() => setActiveTab('winners')}
        >
          GW Winners
        </button>
        <button
          className={`tab ${activeTab === 'stats' ? 'active' : ''}`}
          onClick={() => setActiveTab('stats')}
        >
          Stats<sup className="beta-tag">Beta</sup>
        </button>
        <button
          className={`tab ${activeTab === 'help' ? 'active' : ''}`}
          onClick={() => setActiveTab('help')}
        >
          Help
        </button>
      </nav>

      <main className="app-content">
        {activeTab === 'standings' && <Standings season={selectedSeason} seasonLabel={seasonLabel} />}
        {activeTab === 'winners' && <GWWinners season={selectedSeason} seasonLabel={seasonLabel} />}
        {activeTab === 'stats' && <Stats season={selectedSeason} seasonLabel={seasonLabel} />}
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
</footer>
    </div>
  );
}
