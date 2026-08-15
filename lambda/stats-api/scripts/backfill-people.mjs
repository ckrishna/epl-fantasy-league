// One-time (but safely re-runnable) backfill: populates the new `people` registry table
// from every distinct real name seen in fpl_entry_gameweek. Does NOT write anything to
// fpl_entry_gameweek, fpl_entry_picks, fpl_league_standings, or gw-winners-cache -- this
// script only ever reads those, and only ever writes to `people`. person_id is a pure
// function of the normalized name (see utils/people.mjs's stablePersonId), so re-running
// this after new managers join is idempotent: existing people get overwritten with the
// same values, nobody gets duplicated.
//
// Usage: node scripts/backfill-people.mjs [--dry-run]
//   --dry-run prints what would be written without writing anything.
//
// Requires AWS credentials with read access to fpl_entry_gameweek and write access to
// `people`. Assumes the `people` table already exists (create it first -- see
// DATA_MODEL.md's people/groups/group_seasons section for the schema).

import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb } from '../utils/dynamodb.mjs';
import { derivePeopleFromRows } from '../utils/people.mjs';

async function scanAllGwRows() {
  const items = [];
  let lastEvaluatedKey;
  do {
    const result = await dynamodb.send(new ScanCommand({
      TableName: 'fpl_entry_gameweek',
      ExclusiveStartKey: lastEvaluatedKey
    }));
    items.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return items;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log('Scanning fpl_entry_gameweek (read-only)...');
  const rows = await scanAllGwRows();
  console.log(`Found ${rows.length} rows.`);

  const people = derivePeopleFromRows(rows);
  console.log(`Derived ${people.length} distinct people:`);
  for (const p of people) {
    console.log(`  ${p.person_id}  ${p.canonical_name}`);
  }

  if (dryRun) {
    console.log('\n--dry-run set -- nothing written.');
    return;
  }

  console.log('\nWriting to `people` table...');
  const now = new Date().toISOString();
  for (const p of people) {
    // UpdateCommand rather than PutCommand so a re-run is truly idempotent: canonical_name
    // and source are safe to refresh every time (they're always recomputed identically
    // for the same name), but created_at should reflect when this person was FIRST seen,
    // not the most recent script run -- if_not_exists is the same "only set once" idiom
    // already used by genbi-budget.mjs's `warned` field.
    await dynamodb.send(new UpdateCommand({
      TableName: 'people',
      Key: { person_id: p.person_id },
      UpdateExpression: 'SET canonical_name = :name, #src = :source, created_at = if_not_exists(created_at, :now)',
      ExpressionAttributeNames: { '#src': 'source' },
      ExpressionAttributeValues: {
        ':name': p.canonical_name,
        ':source': 'backfill-2026-08-14',
        ':now': now
      }
    }));
  }
  console.log(`Wrote ${people.length} people.`);
}

main().catch((err) => {
  console.error('backfill-people failed:', err);
  process.exitCode = 1;
});
