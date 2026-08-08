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
        <h1>⚽ EPL Fantasy League</h1>
        <p>Carpe Diem - League 438107</p>

        {seasons.length > 1 && (
          <div className="season-picker">
            <select
              value={selectedSeason ?? currentSeason ?? ''}
              onChange={(e) => {
                const value = e.target.value;
                setSelectedSeason(value === currentSeason ? null : value);
              }}
              aria-label="Select season"
            >
              {seasons.map((s) => (
                <option key={s.season} value={s.season}>
                  {s.season}{s.current ? ' (current)' : ''}
                </option>
              ))}
            </select>
            {viewingHistory && <span className="history-badge">Viewing past season</span>}
          </div>
        )}
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
          Stats
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
