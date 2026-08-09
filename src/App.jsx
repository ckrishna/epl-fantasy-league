// src/App.jsx
import { useEffect, useState } from 'react';
import './styles/App.css';
import Standings from './pages/Standings';
import GWWinners from './pages/GWWinners';
import Stats from './pages/Stats';
import Help from './pages/Help';
import { getSeasons } from './api/client';

export default function App() {
  const [activeTab, setActiveTab] = useState('standings');
  const [seasons, setSeasons] = useState([]);
  // null = "current season" (server picks it); only set to a specific string when the
  // user explicitly selects a past season from the dropdown.
  const [selectedSeason, setSelectedSeason] = useState(null);

  useEffect(() => {
    getSeasons().then(setSeasons);
  }, []);

  const currentSeason = seasons.find((s) => s.current)?.season || null;
  const viewingHistory = selectedSeason !== null && selectedSeason !== currentSeason;

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-inner">
          <h1 className="app-title">⚽ EPL Fantasy League</h1>

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
        {activeTab === 'standings' && <Standings season={selectedSeason} />}
        {activeTab === 'winners' && <GWWinners season={selectedSeason} />}
        {activeTab === 'stats' && <Stats season={selectedSeason} />}
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
