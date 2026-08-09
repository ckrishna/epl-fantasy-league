// Structured Q&A log for GenBI. One row per answered question in the `genbi-query-log`
// table:
//   {
//     query_id: "b3f1...",        // uuid, PK -- also returned to the frontend so a
//                                 // future thumbs-up/down feature has something to
//                                 // attach feedback to
//     timestamp: "2026-08-09T05:38:36.174Z",
//     date: "2026-08-09",        // UTC calendar day, for future scanning/GSI without
//                                 // needing to parse `timestamp` client-side
//     question: "Who is winning?",
//     season: "2026/27",
//     gameweek: 3,
//     fields_selected: { standings: true, seasonWins: false, ... },  // router's output
//                                 // -- lets us later measure router accuracy against
//                                 // real usage, not just the unit tests' assumptions
//     answer: "...",
//     input_tokens: 812,
//     output_tokens: 94,
//     cost_usd: 0.0014,
//     duration_ms: 1180,
//     feedback: null             // reserved for the thumbs-up/down feature -- always
//                                 // null until that feature writes to it
//   }
//
// Deliberately scoped to the successful path only (a real question that got a real
// Bedrock answer). Budget-blocked requests and hard errors never reach here -- there's
// no answer/tokens/router decision to log for either, and logging them would mean
// designing a second, differently-shaped row. Revisit if error-path visibility turns
// out to be needed once this has real usage.
//
// Write is wrapped in try/catch, same resilience pattern as the ingestion_runs audit
// table and the budget-warning email: a logging failure must never fail the actual
// question a manager is waiting on an answer to.
import { randomUUID } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb } from './dynamodb.mjs';

const TABLE = 'genbi-query-log';

export async function recordQueryLog({
  question,
  season,
  gameweek,
  fieldsSelected,
  answer,
  inputTokens,
  outputTokens,
  costUsd,
  durationMs
}) {
  const queryId = randomUUID();
  const timestamp = new Date().toISOString();

  try {
    await dynamodb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        query_id: queryId,
        timestamp,
        date: timestamp.slice(0, 10),
        question,
        season,
        gameweek,
        fields_selected: fieldsSelected,
        answer,
        input_tokens: inputTokens || 0,
        output_tokens: outputTokens || 0,
        cost_usd: costUsd || 0,
        duration_ms: durationMs,
        feedback: null
      }
    }));
  } catch (err) {
    console.error('Failed to record genbi-query-log entry', err);
  }

  // Returned regardless of whether the write actually succeeded -- the frontend still
  // gets a query_id to hold onto. If the write silently failed, a later feedback
  // submission against this ID will simply find nothing to update; it won't crash.
  return queryId;
}
