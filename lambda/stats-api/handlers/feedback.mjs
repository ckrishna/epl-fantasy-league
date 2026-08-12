// Handler for the Help page's "send feedback" form (POST /app-feedback). Separate from
// GenBI's thumbs-up/down feedback (handlers/genbi.mjs's handleGenBIFeedback) -- that one
// attaches a vote to an already-logged question by query_id; this one is a free-text
// message with no relationship to GenBI at all.
import { hasRecentSubmission, recordFeedback } from '../utils/feedback-log.mjs';

const MIN_MESSAGE_LENGTH = 15;
const MAX_MESSAGE_LENGTH = 2000;

export async function handleFeedbackSubmit(body, sourceIp, corsHeaders) {
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';

  // Honeypot: a hidden field real managers never see or fill in (see the "website"
  // input in Help.jsx, kept out of the tab order and visually hidden). Bots that
  // auto-fill every field on a form tend to populate it. A non-empty value here is
  // treated as spam and dropped -- but we still return a normal 200 rather than a 4xx,
  // so a scraper gets no signal that it was caught and no reason to adjust its script.
  const honeypot = typeof body.website === 'string' ? body.website.trim() : '';
  if (honeypot) {
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true }) };
  }

  if (!message) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Feedback message is required' })
    };
  }

  if (message.length < MIN_MESSAGE_LENGTH) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: `Feedback must be at least ${MIN_MESSAGE_LENGTH} characters` })
    };
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: `Feedback must be under ${MAX_MESSAGE_LENGTH} characters` })
    };
  }

  // Light sanity check only -- not trying to fully validate email syntax, just catch
  // obvious non-emails so we don't store junk in a field meant for "reply to me at X".
  if (email && !email.includes('@')) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'That doesn\'t look like a valid email -- or just leave it blank' })
    };
  }

  try {
    if (await hasRecentSubmission(sourceIp)) {
      return {
        statusCode: 429,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'You already sent feedback recently -- give it a few minutes before sending more.' })
      };
    }
  } catch (err) {
    // A blip in the rate-limit check itself shouldn't block a real submission --
    // fail open, not closed.
    console.error('Feedback rate-limit check failed, allowing submission through', err);
  }

  try {
    await recordFeedback({
      message,
      email: email || null,
      sourceIp,
      userAgent: typeof body.userAgent === 'string' ? body.userAgent : null
    });
  } catch (err) {
    console.error('Failed to record feedback', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to save feedback -- please try again' })
    };
  }

  return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true }) };
}
