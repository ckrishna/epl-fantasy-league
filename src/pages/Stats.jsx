// src/pages/Stats.jsx
import { useState } from 'react';
import { queryStats } from '../api/client';
import '../styles/Stats.css';

const SAMPLE_QUESTIONS = [
  "Who are the top 5 scorers this gameweek?",
  "Which team's players are scoring the most points?",
  "What's the form trend over the last 5 gameweeks?",
  "Who should I transfer in this week?",
];

export default function Stats() {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleQuery() {
    if (!question.trim()) return;
    
    setLoading(true);
    setResult(null);
    const data = await queryStats(question);
    setResult(data);
    setLoading(false);
  }

  function handleSample(q) {
    setQuestion(q);
  }

  return (
    <div className="stats-page">
      <h2>Fantasy Stats - Ask AI</h2>
      <p>Ask natural language questions about your league performance and player stats</p>

      <div className="query-section">
        <div className="query-input-wrapper">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask me anything... e.g., 'Who's in form?' or 'Best transfer this week?'"
            className="query-input"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.ctrlKey) {
                handleQuery();
              }
            }}
          />
          <button 
            onClick={handleQuery} 
            disabled={loading || !question.trim()}
            className="query-button"
          >
            {loading ? '🤖 Thinking...' : 'Ask'}
          </button>
        </div>

        <div className="sample-questions">
          <p>Sample questions:</p>
          {SAMPLE_QUESTIONS.map((q, idx) => (
            <button
              key={idx}
              className="sample-btn"
              onClick={() => handleSample(q)}
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="loading-indicator">
          <div className="spinner"></div>
          <p>Analyzing league data...</p>
        </div>
      )}

      {result && !loading && (
        <div className="result-section">
          {result.error ? (
            <div className="error">
              <p>❌ {result.error}</p>
            </div>
          ) : (
            <div className="answer">
              <h3>Answer:</h3>
              <p>{result.answer}</p>
              <p className="timestamp">Generated: {new Date(result.timestamp).toLocaleString()}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
