// src/pages/Help.jsx
import { useEffect, useState } from 'react';
import { submitAppFeedback } from '../api/client';
import '../styles/Help.css';

// Client-side half of the "don't get bombarded" guard -- the real guard is server-side
// (IP-based rate limit in handlers/feedback.mjs), but disabling the form locally right
// after a submission avoids even bothering the server for an obvious double-click/
// resubmit, and gives the manager an immediate reason why the button's disabled instead
// of waiting on a 429 round-trip.
const FEEDBACK_COOLDOWN_MS = 5 * 60 * 1000;
const FEEDBACK_STORAGE_KEY = 'feedbackSubmittedAt';
// Mirrors handlers/feedback.mjs's MIN_MESSAGE_LENGTH -- kept in sync by hand since the
// two live in separate deploy units (frontend vs. lambda), same as this form's max
// length (2000) already did via the textarea's maxLength prop below.
const MIN_MESSAGE_LENGTH = 15;

function getCooldownRemaining() {
  const last = Number(localStorage.getItem(FEEDBACK_STORAGE_KEY) || 0);
  const remaining = FEEDBACK_COOLDOWN_MS - (Date.now() - last);
  return remaining > 0 ? remaining : 0;
}

export default function Help() {
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  // Honeypot -- a field real managers never see or fill in (hidden via .feedback-honeypot
  // in Help.css, kept out of the tab order below). Always sent empty by this form; a
  // non-empty value on the way to the server means a bot filled in every input it found.
  const [website, setWebsite] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState(null); // { type: 'success' | 'error', text }
  const [cooldownMs, setCooldownMs] = useState(getCooldownRemaining);

  // Re-enables the form on its own once the cooldown window passes, instead of leaving
  // it stuck disabled until the manager happens to reload the page.
  useEffect(() => {
    if (cooldownMs <= 0) return;
    const timeoutId = setTimeout(() => setCooldownMs(0), cooldownMs);
    return () => clearTimeout(timeoutId);
  }, [cooldownMs]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (message.trim().length < MIN_MESSAGE_LENGTH || submitting || cooldownMs > 0) return;

    setSubmitting(true);
    setStatus(null);

    const result = await submitAppFeedback({ message: message.trim(), email: email.trim(), website });
    setSubmitting(false);

    if (result.success) {
      setMessage('');
      setEmail('');
      setStatus({ type: 'success', text: "Thanks -- feedback sent!" });
      localStorage.setItem(FEEDBACK_STORAGE_KEY, String(Date.now()));
      setCooldownMs(FEEDBACK_COOLDOWN_MS);
    } else {
      setStatus({ type: 'error', text: result.error || 'Something went wrong -- please try again.' });
    }
  }

  return (
    <div className="help-page">
      <h2>Help & Documentation</h2>

      <div className="help-grid">
        <section className="help-card feedback-card">
          <h3>💬 Send Feedback</h3>
          <p>Spot a bug, have a question, or want to suggest something? Send it straight through here.</p>

          <form className="feedback-form" onSubmit={handleSubmit}>
            <textarea
              className="feedback-message"
              placeholder="What's on your mind?"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              disabled={submitting || cooldownMs > 0}
              maxLength={2000}
              rows={4}
            />
            <p className="feedback-hint">
              {message.trim().length > 0 && message.trim().length < MIN_MESSAGE_LENGTH
                ? `${MIN_MESSAGE_LENGTH - message.trim().length} more character${MIN_MESSAGE_LENGTH - message.trim().length === 1 ? '' : 's'} needed`
                : `Minimum ${MIN_MESSAGE_LENGTH} characters`}
            </p>
            <input
              type="email"
              className="feedback-email"
              placeholder="Your email (optional -- only if you want a reply)"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting || cooldownMs > 0}
            />

            {/* Honeypot field -- visually hidden and out of the tab order, never seen by
                a real person filling out this form normally. */}
            <input
              type="text"
              name="website"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              className="feedback-honeypot"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
            />

            <button
              type="submit"
              className="feedback-submit-btn"
              disabled={submitting || cooldownMs > 0 || message.trim().length < MIN_MESSAGE_LENGTH}
            >
              {submitting ? 'Sending…' : cooldownMs > 0 ? 'Sent recently' : 'Send Feedback'}
            </button>
          </form>

          {status && (
            <p className={`feedback-status feedback-status-${status.type}`}>{status.text}</p>
          )}
        </section>

        <section className="help-card help-card-wide">
          <h3>⚙️ How It Works</h3>
          <p>This app:</p>
          <ul>
            <li>Updates nightly with live Premier League data</li>
            <li>Stores historical gameweeks performance</li>
            <li>Uses AI to answer natural language questions</li>
            <li>Hosted on Cloudflare Pages for fast global access</li>
          </ul>
        </section>

        <section className="help-card help-card-wide">
          <h3>📱 Browser Support</h3>
          <p>Works on all modern browsers.</p>
        </section>
      </div>
    </div>
  );
}
