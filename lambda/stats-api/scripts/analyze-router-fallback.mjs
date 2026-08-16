// Analyzes real GenBI usage (genbi-query-log, built by utils/genbi-log.mjs) to answer
// the question raised at the end of this session's latency work: how often does
// router.mjs's selectRelevantFields() fall back to fetching ALL 11 context fields
// (every DynamoDB Scan, every external FPL fetch -- the single most expensive path a
// question can take) versus narrowing down to just what a question actually needs?
//
// router.mjs's own comment explains why this fallback exists at all -- "under-fetching
// produces a wrong/declined answer; over-fetching only costs a few extra tokens" -- so
// this is NOT a bug to blindly remove. The real gap is that nobody has ever looked at
// how often it actually fires, or what real questions trigger it, which is the only
// honest basis for deciding whether it's worth expanding router.mjs's keyword coverage
// to shrink it.
//
// Every logged question already carries fields_selected (the router's raw output for
// that exact question) plus its real token/cost/duration numbers -- so this needed no
// new instrumentation, just reading data that's already being written.
//
// Usage: node scripts/analyze-router-fallback.mjs
//   Requires AWS credentials with read access to genbi-query-log (read-only -- this
//   script never writes anything).

import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb } from '../utils/dynamodb.mjs';

const TABLE = 'genbi-query-log';

// Mirrors router.mjs's ALL_TRUE exactly -- kept as a literal list here (not imported)
// since this script cares about the SHAPE of a logged row, not the router's live
// keyword logic itself.
const ALL_FIELDS = [
  'standings', 'seasonWins', 'recentForm', 'playerGwData', 'seasonTotals',
  'managerPicks', 'managerStats', 'ownership', 'topCaptainPicks',
  'nextGwStrategy', 'fixtureRun'
];

function isFallback(fieldsSelected) {
  if (!fieldsSelected) return false;
  return ALL_FIELDS.every((f) => fieldsSelected[f] === true);
}

function selectedFieldNames(fieldsSelected) {
  if (!fieldsSelected) return [];
  return ALL_FIELDS.filter((f) => fieldsSelected[f] === true);
}

async function scanAll() {
  const rows = [];
  let lastEvaluatedKey;
  do {
    const result = await dynamodb.send(new ScanCommand({
      TableName: TABLE,
      ExclusiveStartKey: lastEvaluatedKey
    }));
    rows.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return rows;
}

function avg(nums) {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function fmtMs(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtUsd(usd) {
  return `$${usd.toFixed(4)}`;
}

async function main() {
  console.log(`Scanning ${TABLE}...\n`);
  const rows = await scanAll();

  if (rows.length === 0) {
    console.log('No rows in genbi-query-log yet -- nothing to analyze. Ask GenBI a few ' +
      'more questions (varied phrasing, not just repeats of the same one) and re-run this.');
    return;
  }

  const fallbackRows = rows.filter((r) => isFallback(r.fields_selected));
  const narrowRows = rows.filter((r) => !isFallback(r.fields_selected));
  const fallbackPct = (fallbackRows.length / rows.length) * 100;

  console.log('='.repeat(70));
  console.log('ROUTER FALLBACK RATE');
  console.log('='.repeat(70));
  console.log(`Total questions logged:     ${rows.length}`);
  console.log(`Hit the ALL_TRUE fallback:  ${fallbackRows.length} (${fallbackPct.toFixed(1)}%)`);
  console.log(`Narrowly routed:            ${narrowRows.length} (${(100 - fallbackPct).toFixed(1)}%)`);

  if (fallbackRows.length > 0 && narrowRows.length > 0) {
    console.log('\n' + '='.repeat(70));
    console.log('COST/LATENCY IMPACT: fallback vs. narrowly-routed questions');
    console.log('='.repeat(70));
    const fbDuration = avg(fallbackRows.map((r) => r.duration_ms || 0));
    const nrDuration = avg(narrowRows.map((r) => r.duration_ms || 0));
    const fbCost = avg(fallbackRows.map((r) => r.cost_usd || 0));
    const nrCost = avg(narrowRows.map((r) => r.cost_usd || 0));
    const fbInput = avg(fallbackRows.map((r) => r.input_tokens || 0));
    const nrInput = avg(narrowRows.map((r) => r.input_tokens || 0));
    console.log(`Avg Bedrock duration -- fallback: ${fmtMs(fbDuration)}  vs  narrow: ${fmtMs(nrDuration)}`);
    console.log(`Avg cost per question -- fallback: ${fmtUsd(fbCost)}  vs  narrow: ${fmtUsd(nrCost)}`);
    console.log(`Avg input tokens -- fallback: ${fbInput.toFixed(0)}  vs  narrow: ${nrInput.toFixed(0)}`);
    console.log('(Note: fallback rows fetch the full <context> block regardless of what ' +
      'Bedrock actually needed to answer -- this is the real per-question cost of an ' +
      'unmatched question, not just a router curiosity.)');
  }

  if (fallbackRows.length > 0) {
    console.log('\n' + '='.repeat(70));
    console.log(`SAMPLE QUESTIONS THAT HIT THE FALLBACK (up to 20 of ${fallbackRows.length})`);
    console.log('='.repeat(70));
    console.log('These are real, unmatched questions -- read them for a pattern before ' +
      'adding router.mjs keywords, so any expansion targets what people are actually ' +
      'asking rather than a guess.\n');
    const seen = new Set();
    for (const row of fallbackRows) {
      const q = (row.question || '').trim();
      if (!q || seen.has(q.toLowerCase())) continue;
      seen.add(q.toLowerCase());
      console.log(`  - "${q}"`);
      if (seen.size >= 20) break;
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('FIELD SELECTION FREQUENCY (across ALL questions, narrow + fallback)');
  console.log('='.repeat(70));
  console.log('Which fields actually get requested most often -- useful for prioritizing ' +
    'future work (e.g. which Scan/fetch is worth optimizing next) independent of the ' +
    'fallback question above.\n');
  const counts = {};
  for (const f of ALL_FIELDS) counts[f] = 0;
  for (const row of rows) {
    for (const f of selectedFieldNames(row.fields_selected)) counts[f] += 1;
  }
  const sortedFields = ALL_FIELDS.slice().sort((a, b) => counts[b] - counts[a]);
  for (const f of sortedFields) {
    const pct = ((counts[f] / rows.length) * 100).toFixed(0);
    const bar = '#'.repeat(Math.round(counts[f] / rows.length * 40));
    console.log(`  ${f.padEnd(16)} ${String(counts[f]).padStart(4)}/${rows.length}  (${pct.padStart(3)}%)  ${bar}`);
  }

  console.log('\n' + '='.repeat(70));
  console.log('RECOMMENDATION');
  console.log('='.repeat(70));
  if (rows.length < 20) {
    console.log(`Only ${rows.length} questions logged so far -- too small a sample to act on. ` +
      `Re-run this after real usage builds up (aim for 50+ questions across different people/phrasings).`);
  } else if (fallbackPct < 10) {
    console.log(`Fallback rate is low (${fallbackPct.toFixed(1)}%) -- router.mjs's keyword ` +
      `coverage is already handling most real questions. Not worth spending time narrowing ` +
      `it further right now.`);
  } else if (fallbackPct < 30) {
    console.log(`Fallback rate is moderate (${fallbackPct.toFixed(1)}%) -- worth reading the ` +
      `sample questions above and adding a few targeted keywords to router.mjs's ` +
      `KEYWORD_GROUPS for whatever pattern shows up repeatedly, rather than a large rewrite.`);
  } else {
    console.log(`Fallback rate is high (${fallbackPct.toFixed(1)}%) -- a meaningful share of ` +
      `real questions aren't matching any keyword group. Worth prioritizing: read the sample ` +
      `questions above for common phrasing router.mjs doesn't yet cover.`);
  }
}

main().catch((err) => {
  console.error('analyze-router-fallback failed:', err);
  process.exitCode = 1;
});
