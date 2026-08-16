// Daily cost guardrail for GenBI's Bedrock usage. Tracks real spend (not just token
// count) against a hard daily cap, computed from the currently-configured model's
// actual Bedrock pricing, so a request that's about to blow the budget is blocked
// *before* it's sent (zero cost) rather than discovered after the fact.
//
// One DynamoDB row per UTC calendar day in the `genbi-usage-daily` table:
//   { date: "2026-08-08", cost_usd: 0.42, warned: false }
// A new day starts fresh automatically -- there's no row to read yet, so usage
// defaults to $0.
import { UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb } from './dynamodb.mjs';

const TABLE = 'genbi-usage-daily';

// Bedrock on-demand pricing for us.anthropic.claude-sonnet-4-6 (us-west-2), switched
// from Haiku 4.5 2026-08-16 (see bedrock.mjs's CLAUDE_MODEL_ID comment for why --
// including why this is 4.6, not the originally-tried Sonnet 5, which this AWS account
// doesn't have access to). Confirmed via Anthropic's official pricing page as of Aug
// 2026: Sonnet 4.6 base rate is $3 / 1M input tokens, $15 / 1M output tokens (identical
// published pricing to Sonnet 4.5); Bedrock's `us.`-prefixed regional endpoint (used
// here, not the global endpoint) carries a documented 10% premium over that base rate --
// the same 1.1x relationship the old Haiku constants already reflected ($1.10/$5.50 vs
// Haiku's $1/$5 base) -- giving $3.30 / 1M input, $16.50 / 1M output. This is exactly 3x
// the old Haiku cost per token, so the same $10/day default budget now covers roughly a
// third as many questions -- worth raising GENBI_DAILY_BUDGET_USD if that bites. If
// Anthropic/AWS repricing changes this, update here -- this is the only place cost is
// computed.
const INPUT_COST_PER_TOKEN = 3.30 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 16.50 / 1_000_000;

export const DAILY_BUDGET_USD = Number(process.env.GENBI_DAILY_BUDGET_USD) || 10;
export const WARNING_THRESHOLD_RATIO = 0.8;

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD", UTC
}

export function computeCostUsd({ inputTokens = 0, outputTokens = 0 }) {
  return inputTokens * INPUT_COST_PER_TOKEN + outputTokens * OUTPUT_COST_PER_TOKEN;
}

// Reads today's accumulated spend. No row yet (first request of the day) => $0, not warned.
export async function getTodayUsage() {
  const date = todayKey();
  const result = await dynamodb.send(new GetCommand({ TableName: TABLE, Key: { date } }));
  if (!result.Item) {
    return { date, cost_usd: 0, warned: false };
  }
  return { date, cost_usd: result.Item.cost_usd || 0, warned: !!result.Item.warned };
}

// Checks today's spend against the budget *before* a Bedrock call is made.
// Returns whether the call should be blocked, and whether a warning email is due.
export async function checkBudget() {
  const usage = await getTodayUsage();
  return {
    costSoFar: usage.cost_usd,
    overBudget: usage.cost_usd >= DAILY_BUDGET_USD,
    shouldWarn: !usage.warned && usage.cost_usd >= DAILY_BUDGET_USD * WARNING_THRESHOLD_RATIO
  };
}

// Adds a completed call's real cost to today's running total (creates the row if this
// is the first call of the day). Uses an atomic ADD so concurrent requests don't clobber
// each other's writes.
export async function recordUsage({ inputTokens, outputTokens }) {
  const date = todayKey();
  const costUsd = computeCostUsd({ inputTokens, outputTokens });
  await dynamodb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { date },
    UpdateExpression: 'ADD cost_usd :c SET warned = if_not_exists(warned, :false)',
    ExpressionAttributeValues: { ':c': costUsd, ':false': false }
  }));
  return costUsd;
}

// Marks today as already-warned so the threshold email only fires once per day.
export async function markWarned() {
  const date = todayKey();
  await dynamodb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { date },
    UpdateExpression: 'SET warned = :true',
    ExpressionAttributeValues: { ':true': true }
  }));
}
