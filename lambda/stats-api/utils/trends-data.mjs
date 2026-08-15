import { dynamodb } from './dynamodb.mjs';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';

// Collapses whitespace variants (matches import-historical-seasons.mjs's normName) so
// "Chetan Bk" and a copy with a stray non-breaking space are treated as the same real
// person when grouping trend data by name across seasons. real_name is the join key
// here -- it's the field that holds a manager's real name on EVERY row, historical or
// live (renamed 2026-08-14 from the old, misleadingly-named team_name -- see
// DATA_MODEL.md's identity redesign notes; team_nickname, formerly manager_name, is
// the FPL squad nickname, only ever populated for live seasons).
export function normName(raw) {
  return String(raw || '').replace(/[ \s]+/g, ' ').trim();
}

// Full, unfiltered scan of fpl_entry_gameweek -- the one table Trends reads from, since
// it already has full weekly granularity for every season on record (historical rows
// were backfilled GW-by-GW, live rows are written GW-by-GW by the ingester). A few
// thousand rows total as of 2026, small enough for a single scan loop; revisit with a
// GSI on real_name if this ever gets slow.
export async function getAllGwRows() {
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
