// src/pages/Stats.jsx - AI Assistant with sample data
import { useState } from 'react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import '../styles/Stats.css';

const SAMPLE_QUERIES = {
  "Who has the most GW wins this season?": {
    type: 'table',
    title: 'Manager with Most Weekly Wins',
    answer: 'Sushil Suvarna (Suberox) leads with 4 gameweek wins this season.',
    data: [
      { manager: 'Sushil Suvarna', team: 'Suberox', wins: 4, avgPoints: 65.2 },
      { manager: 'Michael Kojo Brown', team: 'Da Movement', wins: 3, avgPoints: 68.1 },
      { manager: 'Vineet Dhiman', team: 'Spursy Spurs', wins: 2, avgPoints: 62.5 },
      { manager: 'Himanish Raghunath', team: 'Nish\'s Team', wins: 2, avgPoints: 64.3 },
      { manager: 'Vinay Swaminathan', team: 'Boltzman', wins: 2, avgPoints: 61.8 },
    ]
  },
  "What's the average points per manager?": {
    type: 'chart',
    chartType: 'bar',
    title: 'Average Points Per Manager (All GWs)',
    answer: 'Michael Kojo Brown has the highest average with 68.1 points per gameweek. The league average is 62.4 points.',
    data: [
      { name: 'Michael Kojo', value: 68.1 },
      { name: 'Sushil Suvarna', value: 65.2 },
      { name: 'Himanish R', value: 64.3 },
      { name: 'Vineet D', value: 62.5 },
      { name: 'Vinay S', value: 61.8 },
      { name: 'Sunil M', value: 59.2 },
      { name: 'Aditya S', value: 58.4 },
      { name: 'Chetan B', value: 57.1 },
      { name: 'Nihar N', value: 54.6 },
      { name: 'Sricharan M', value: 52.8 },
      { name: 'Devin J', value: 51.5 },
    ]
  },
  "Points trend over last 10 gameweeks?": {
    type: 'chart',
    chartType: 'line',
    title: 'Points Trend - Last 10 Gameweeks',
    answer: 'Clear upward trend visible. Average points increasing from 58 (GW16) to 65 (GW25). Suggests improved decision-making mid-season.',
    data: [
      { gw: 16, avg: 58, min: 45, max: 75 },
      { gw: 17, avg: 59, min: 47, max: 76 },
      { gw: 18, avg: 60, min: 48, max: 78 },
      { gw: 19, avg: 61, min: 49, max: 79 },
      { gw: 20, avg: 62, min: 50, max: 80 },
      { gw: 21, avg: 63, min: 51, max: 81 },
      { gw: 22, avg: 63, min: 52, max: 82 },
      { gw: 23, avg: 64, min: 53, max: 83 },
      { gw: 24, avg: 64, min: 54, max: 84 },
      { gw: 25, avg: 65, min: 55, max: 85 },
    ]
  },
  "Transfer cost impact analysis": {
    type: 'metrics',
    title: 'Transfer Cost Impact',
    answer: 'Managers who made 2-3 strategic transfers averaged 3.2 more points per week than those making 5+ transfers. Quality > Quantity.',
    metrics: [
      { label: 'Avg points (0-1 transfer)', value: 62.8, color: '#10b981' },
      { label: 'Avg points (2-3 transfers)', value: 65.2, color: '#3b82f6' },
      { label: 'Avg points (4+ transfers)', value: 59.1, color: '#ef4444' },
      { label: 'Best transfer week impact', value: '+8.5 pts', color: '#f59e0b' },
    ]
  },
  "Best captain picks this season": {
    type: 'table',
    title: 'Top Captain Picks (By Points Differential)',
    answer: 'Haaland as captain was the best pick, averaging +12.3 bonus points above baseline when selected.',
    data: [
      { rank: 1, player: 'Erling Haaland', avgBonus: 12.3, timesSelected: 8, totalPoints: 98 },
      { rank: 2, player: 'Harry Kane', avgBonus: 10.1, timesSelected: 6, totalPoints: 61 },
      { rank: 3, player: 'Mohamed Salah', avgBonus: 9.8, timesSelected: 7, totalPoints: 69 },
      { rank: 4, player: 'Bukayo Saka', avgBonus: 8.5, timesSelected: 4, totalPoints: 34 },
      { rank: 5, player: 'Phil Foden', avgBonus: 8.2, timesSelected: 5, totalPoints: 41 },
    ]
  }
};

export default function Stats() {
  const [selectedQuery, setSelectedQuery] = useState(null);
  const [loading, setLoading] = useState(false);

  function handleQueryClick(query) {
    setLoading(true);
    setTimeout(() => {
      setSelectedQuery(query);
      setLoading(false);
    }, 800); // Simulate thinking
  }

  const result = selectedQuery ? SAMPLE_QUERIES[selectedQuery] : null;

  return (
    <div className="stats-page">
      <div className="stats-container">
        {/* Left Panel - AI Chat */}
        <div className="stats-left">
          <h2>⚡ League Intelligence</h2>
          <p className="subtitle">Ask about league trends, performance, and strategy</p>

          <div className="queries-list">
            <p className="queries-label">Popular Analyses:</p>
            {Object.keys(SAMPLE_QUERIES).map((query, idx) => (
              <button
                key={idx}
                className={`query-btn ${selectedQuery === query ? 'active' : ''}`}
                onClick={() => handleQueryClick(query)}
                disabled={loading}
              >
                <span className="query-icon">📊</span>
                <span className="query-text">{query}</span>
                <span className="query-arrow">→</span>
              </button>
            ))}
          </div>

          <div className="info-box">
            <p>💡 <strong>Tip:</strong> Click any analysis to see detailed insights with visualizations and data trends.</p>
          </div>
        </div>

        {/* Right Panel - Results Canvas */}
        <div className="stats-right">
          {!selectedQuery && !loading && (
            <div className="empty-state">
              <div className="empty-icon">📈</div>
              <p>Select an analysis to get started</p>
            </div>
          )}

          {loading && (
            <div className="loading-state">
              <div className="spinner"></div>
              <p>Analyzing league data...</p>
            </div>
          )}

          {result && !loading && (
            <div className="result-canvas">
              <h3>{result.title}</h3>
              
              <div className="answer-box">
                <p>{result.answer}</p>
              </div>

              {/* Render based on type */}
              {result.type === 'chart' && result.chartType === 'bar' && (
                <div className="chart-container">
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={result.data}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="name" angle={-45} textAnchor="end" height={80} />
                      <YAxis />
                      <Tooltip />
                      <Bar dataKey="value" fill="#003d7a" radius={[8, 8, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {result.type === 'chart' && result.chartType === 'line' && (
                <div className="chart-container">
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={result.data}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="gw" />
                      <YAxis />
                      <Tooltip />
                      <Legend />
                      <Line type="monotone" dataKey="avg" stroke="#003d7a" strokeWidth={2} name="Avg Points" />
                      <Line type="monotone" dataKey="min" stroke="#ef4444" strokeWidth={1} name="Min" />
                      <Line type="monotone" dataKey="max" stroke="#10b981" strokeWidth={1} name="Max" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              {result.type === 'table' && (
                <div className="table-container">
                  <table className="data-table">
                    <thead>
                      <tr>
                        {Object.keys(result.data[0]).map(key => (
                          <th key={key}>{key.toUpperCase()}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.data.map((row, idx) => (
                        <tr key={idx}>
                          {Object.values(row).map((val, i) => (
                            <td key={i}>{val}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {result.type === 'metrics' && (
                <div className="metrics-grid">
                  {result.metrics.map((metric, idx) => (
                    <div key={idx} className="metric-card" style={{ borderLeftColor: metric.color }}>
                      <p className="metric-label">{metric.label}</p>
                      <p className="metric-value">{metric.value}</p>
                    </div>
                  ))}
                </div>
              )}

              <p className="result-timestamp">Generated: {new Date().toLocaleString()}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
