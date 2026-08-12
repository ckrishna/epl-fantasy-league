// Storage for the Help page's "send feedback" form. One row per submission in the
// `app-feedback` table:
//   {
//     feedback_id: "b3f1...",   // uuid, PK
//     timestamp: "2026-08-12T19:15:45.958Z",
//     date: "2026-08-12",       // UTC calendar day, for scanning without parsing timestamp
//     message: "...",
//     email: "chetan@..." | null,   // optional -- only set if the manager wants a reply
//     source_ip: "1.2.3.4" | null,  // used only for the rate-limit check below, never shown
//     user_agent: "..." | null
//   }
//
// Deliberately writes straight to DynamoDB and stops there -- no SES email on submit.
// The whole point of a form over a mailto: link was to NOT get a real-time inbox ping
// per submission; feedback is reviewed on demand (Scan the table) instead.
import { randomUUID } from 'node:crypto';
import { PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb } from './dynamodb.mjs';

const TABLE = 'app-feedback';
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// Cheap abuse guard: has this source IP submitted anything in the last 5 minutes? A
// full Scan is fine here given this table's tiny expected size (a handful of
// submissions from an ~8-manager private league, not a public form at scale) -- no
// need for a GSI or a second rate-limit table to make this fast.
//
// `sourceIp` can be null (some Lambda event shapes don't always populate it) -- treat
// that as "can't identify this caller" and let the submission through rather than
// blocking everyone behind a null-IP false match.
export async function hasRecentSubmission(sourceIp) {
  if (!sourceIp) return false;

  const cutoff = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const result = await dynamodb.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: 'source_ip = :ip AND #ts > :cutoff',
    ExpressionAttributeNames: { '#ts': 'timestamp' },
    ExpressionAttributeValues: { ':ip': sourceIp, ':cutoff': cutoff }
  }));
  return (result.Items || []).length > 0;
}

export async function recordFeedback({ message, email, sourceIp, userAgent }) {
  const feedbackId = randomUUID();
  const timestamp = new Date().toISOString();

  await dynamodb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      feedback_id: feedbackId,
      timestamp,
      date: timestamp.slice(0, 10),
      message,
      email: email || null,
      source_ip: sourceIp || null,
      user_agent: userAgent || null
    }
  }));

  return feedbackId;
}
