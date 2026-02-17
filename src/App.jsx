// src/App.jsx
import { useState } from 'react';
import './styles/App.css';
import Standings from './pages/Standings';
import GWWinners from './pages/GWWinners';
import Stats from './pages/Stats';
import Help from './pages/Help';

export default function App() {
  const [activeTab, setActiveTab] = useState('standings');

  return (
    <div className="app">
      <header className="app-header">
        <h1>⚽ EPL Fantasy League</h1>
        <p>Carpe Diem - League 212889</p>
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
        {activeTab === 'standings' && <Standings />}
        {activeTab === 'winners' && <GWWinners />}
        {activeTab === 'stats' && <Stats />}
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
