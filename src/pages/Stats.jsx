// src/pages/Stats.jsx
import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { queryStats, submitFeedback } from '../api/client';
import ScopeNote from '../components/ScopeNote';
import '../styles/Stats.css';

// "5m 42.7s" style formatting, minutes only shown once there are any -- matches the
// reference loader's elapsed-time treatment.
function formatElapsed(ms) {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(1);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

const SUGGESTED_QUERIES = [
  "Which player is a differential this week?",
  "Which managers are in form?",
  "Best captain picks this season?"
];

// Only auto-focus the question input on desktop. On mobile, autofocusing pops the
// virtual keyboard the instant this page loads, and that keyboard-open/viewport-resize
// dance is what was causing the whole page to appear shifted right (reported live on
// GenBI specifically). 640px matches this page's own mobile breakpoint (see Stats.css).
// Read once at mount, not tracked live -- a page reflowing mid-session because the
// user rotated their phone isn't worth chasing here, this only needs to be right at
// the moment the page first renders.
function shouldAutoFocus() {
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 641px)').matches;
}

export default function Stats({ season = null, seasonLabel = null }) {
  const [selectedQuery, setSelectedQuery] = useState(null);
  const [customQuestion, setCustomQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  // null = no vote yet, 'up'/'down' = recorded, 'pending' = submit in flight
  const [feedback, setFeedback] = useState(null);
  // Live-ticking "how long has this been running" counter for the loading state --
  // GenBI calls can take several seconds, and a bare spinner gives no sense of
  // progress. Counts up in 100ms steps while `loading` is true; reset per-request in
  // fetchGenBI rather than here, so it starts fresh even if the previous request's
  // interval hasn't been cleaned up yet.
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!loading) return;
    const startedAt = Date.now();
    const intervalId = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 100);
    return () => clearInterval(intervalId);
  }, [loading]);

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
    setElapsedMs(0);
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
          <ScopeNote season={seasonLabel}>
            Questions are answered using {seasonLabel} season data only
          </ScopeNote>

          <form className="custom-question" onSubmit={handleCustomQuestion}>
            <input
              type="text"
              placeholder="Ask any question..."
              value={customQuestion}
              onChange={(e) => setCustomQuestion(e.target.value)}
              disabled={loading}
              className="question-input"
              autoFocus={shouldAutoFocus()}
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
            <p>💡 Each question is answered fresh — no memory of earlier questions. e.g., "Who made the best transfers?" or "Which player is a differential?"</p>
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
              <div className="churn-card">
                <span className="pixel-grid" aria-hidden="true">
                  {Array.from({ length: 9 }).map((_, i) => (
                    <span key={i} className="pixel" style={{ animationDelay: `${i * 90}ms` }} />
                  ))}
                </span>
                <span className="churn-label">Churning</span>
                <span className="churn-time">{formatElapsed(elapsedMs)}</span>
              </div>
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
                <div className="stat-chip">
                  <span className="stat-chip-label">Tokens</span>
                  <span className="stat-chip-value">{result.usage?.output_tokens ?? '—'}</span>
                </div>
                {typeof result.durationMs === 'number' && (
                  <div className="stat-chip">
                    {/* Was just "Time" -- easy to mistake for the total wait shown by
                        the "Churning" loader, when this is actually only the Bedrock
                        call itself (routing + DynamoDB fetches aren't included). */}
                    <span className="stat-chip-label">AI Time</span>
                    <span className="stat-chip-value">{(result.durationMs / 1000).toFixed(1)}s</span>
                  </div>
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
