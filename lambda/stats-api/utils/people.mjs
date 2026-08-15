// The `people` table (see DATA_MODEL.md's "people/groups/group_seasons" section) is a
// registry of every real human this app has ever tracked, keyed by a stable person_id
// that's a deterministic function of their normalized real name -- NOT of anything FPL
// issues, since we've confirmed live that neither entry_id nor league_id survives a
// season rollover (see DATA_MODEL.md's multi-league notes).
//
// Deliberate design choice: person_id is a PURE function of the name, computable by
// anyone with the name, with zero DynamoDB dependency. This means resolving "which
// person does this row belong to" never requires a live lookup against the `people`
// table -- any handler can call stablePersonId() directly. The `people` table itself
// exists as a REGISTRY (for enumeration, canonical display names, and a future home for
// name-variant aliases if one is ever needed), not as a required join for basic
// identity resolution. This mirrors why the historical import's stableEntryId() exists
// (same idea, different purpose -- see import-historical-seasons.mjs) and deliberately
// avoids ever needing to bulk-write a person_id onto existing rows in fpl_entry_gameweek
// or fpl_entry_picks: those rows can have their person_id computed on read, forever,
// with no migration required.
import { createHash } from 'node:crypto';
import { normName } from './trends-data.mjs';

// Short, readable, deterministic. Not cryptographically sensitive -- collision
// resistance only needs to hold across a few dozen real names, not attacker-chosen
// input, so a truncated sha256 hex prefix is more than enough headroom.
export function stablePersonId(rawName) {
  const normalized = normName(rawName);
  const hash = createHash('sha256').update(normalized).digest('hex');
  return `person_${hash.slice(0, 12)}`;
}

// Pure, DynamoDB-free: takes any array of objects with a real_name-shaped field and
// returns one deduped {person_id, canonical_name} per distinct normalized name. Used by
// scripts/backfill-people.mjs (fed real fpl_entry_gameweek rows) and directly unit
// testable without any mock DynamoDB at all. Default renamed 2026-08-14 from team_name
// to real_name -- see DATA_MODEL.md's identity redesign notes.
export function derivePeopleFromRows(rows, { nameField = 'real_name' } = {}) {
  const byId = new Map();
  for (const row of rows) {
    const raw = row[nameField];
    const normalized = normName(raw);
    if (!normalized) continue;
    const personId = stablePersonId(normalized);
    if (!byId.has(personId)) {
      byId.set(personId, { person_id: personId, canonical_name: normalized });
    }
  }
  return [...byId.values()].sort((a, b) => a.canonical_name.localeCompare(b.canonical_name));
}
