// src/pages/Stats.jsx
import { useState } from 'react';
import { queryStats } from '../api/client';
import '../styles/Stats.css';

const SUGGESTED_QUERIES = [
  "Who has the most GW wins this season?",
  "Which managers are in form?",
  "Best captain picks this season?"
];

export default function Stats({ season = null }) {
  const [selectedQuery, setSelectedQuery] = useState(null);
  const [customQuestion, setCustomQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function handleQueryClick(query) {
    setLoading(true);
    setError(null);
    setSelectedQuery(query);
    await fetchGenBI(query);
  }

  async function handleCustomQuestion(e) {
    e.preventDefault();
    if (!customQuestion.trim()) return;
    
    setLoading(true);
    setError(null);
    setSelectedQuery(customQuestion);
    await fetchGenBI(customQuestion);
    setCustomQuestion('');
  }

  async function fetchGenBI(question) {
    try {
      const data = await queryStats(question, season);

      if (data.error) {
        throw new Error(data.error);
      }

      setResult({
        type: 'text',
        title: 'League Analysis',
        answer: data.answer,
        usage: data.usage,
        timestamp: data.timestamp
      });

    } catch (err) {
      console.error('GenBI error:', err);
      setError(err.message || 'Failed to fetch analysis');
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="stats-page">
      <div className="stats-container">
        {/* Left Panel */}
        <div className="stats-left">
          <h2>⚡ League Intelligence</h2>
          <p className="subtitle">
            Ask Claude about league trends{season ? ` — ${season}` : ''}
          </p>

          <form className="custom-question" onSubmit={handleCustomQuestion}>
            <input
              type="text"
              placeholder="Ask any question..."
              value={customQuestion}
              onChange={(e) => setCustomQuestion(e.target.value)}
              disabled={loading}
              className="question-input"
              autoFocus
            />
            <button type="submit" disabled={loading || !customQuestion.trim()} className="submit-btn">
              →
            </button>
          </form>

          <div className="divider">suggested:</div>

          <div className="queries-list">
            {SUGGESTED_QUERIES.map((query, idx) => (
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
            <p>💡 Ask anything about your league! e.g., "Who made the best transfers?" or "Which player is a differential?"</p>
          </div>
        </div>

        {/* Right Panel */}
        <div className="stats-right">
          {!selectedQuery && !loading && (
            <div className="empty-state">
              <div className="empty-icon">📈</div>
              <p>Ask a question to get started</p>
            </div>
          )}

          {loading && (
            <div className="loading-state">
              <div className="spinner"></div>
              <p>Analyzing with Claude...</p>
            </div>
          )}

          {error && (
            <div className="error-state">
              <p className="error-title">⚠️ Error</p>
              <p className="error-message">{error}</p>
            </div>
          )}

          {result && !loading && (
            <div className="result-canvas">
              <h3>{result.title}</h3>
              <div className="answer-box">
                <p>{result.answer}</p>
              </div>
              <div className="result-metadata">
                <span className="tokens">Tokens: {result.usage?.output_tokens}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
