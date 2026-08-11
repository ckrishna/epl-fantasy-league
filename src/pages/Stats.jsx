// src/pages/Stats.jsx
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { queryStats, submitFeedback } from '../api/client';
import '../styles/Stats.css';

const SUGGESTED_QUERIES = [
  "Which player is a differential this week?",
  "Which managers are in form?",
  "Best captain picks this season?"
];

export default function Stats({ season = null }) {
  const [selectedQuery, setSelectedQuery] = useState(null);
  const [customQuestion, setCustomQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  // null = no vote yet, 'up'/'down' = recorded, 'pending' = submit in flight
  const [feedback, setFeedback] = useState(null);

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
    setFeedback(null);
    try {
      const data = await queryStats(question, season);

      if (data.error) {
        throw new Error(data.error);
      }

      setResult({
        type: 'text',
        title: 'League Analysis',
        question,
        answer: data.answer,
        usage: data.usage,
        durationMs: data.duration_ms,
        timestamp: data.timestamp,
        queryId: data.query_id
      });

    } catch (err) {
      console.error('GenBI error:', err);
      setError(err.message || 'Failed to fetch analysis');
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  // Lets a manager change their mind (up -> down or vice versa) by just submitting
  // again -- the backend does a plain overwrite, so there's no need to block re-voting.
  async function handleFeedback(vote) {
    if (!result?.queryId || feedback === 'pending') return;
    setFeedback('pending');
    const ok = await submitFeedback(result.queryId, vote);
    setFeedback(ok ? vote : null);
  }

  return (
    <div className="stats-page">
      <div className="stats-container">
        {/* Left Panel */}
        <div className="stats-left">
          <h2>⚡ League Intelligence</h2>

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
              <p className="asked-question">"{result.question}"</p>
              <div className="answer-box markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{result.answer}</ReactMarkdown>
              </div>
              <div className="result-metadata">
                <span className="tokens">Tokens: {result.usage?.output_tokens}</span>
                {typeof result.durationMs === 'number' && (
                  <span className="duration">Time: {(result.durationMs / 1000).toFixed(1)}s</span>
                )}
                {result.queryId && (
                  <div className="feedback-buttons">
                    <button
                      type="button"
                      className={[
                        'feedback-btn',
                        'thumbs-up',
                        feedback === 'up' && 'active',
                        feedback && feedback !== 'up' && 'locked'
                      ].filter(Boolean).join(' ')}
                      onClick={() => handleFeedback('up')}
                      disabled={!!feedback}
                      aria-pressed={feedback === 'up'}
                      aria-label="Good answer"
                      title="Good answer"
                    >
                      👍
                    </button>
                    <button
                      type="button"
                      className={[
                        'feedback-btn',
                        'thumbs-down',
                        feedback === 'down' && 'active',
                        feedback && feedback !== 'down' && 'locked'
                      ].filter(Boolean).join(' ')}
                      onClick={() => handleFeedback('down')}
                      disabled={!!feedback}
                      aria-pressed={feedback === 'down'}
                      aria-label="Bad answer"
                      title="Bad answer"
                    >
                      👎
                    </button>
                    {(feedback === 'up' || feedback === 'down') && (
                      <span className="feedback-thanks">Thanks!</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
