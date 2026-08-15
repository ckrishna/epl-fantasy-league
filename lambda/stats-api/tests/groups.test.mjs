// utils/groups.mjs -- group_id is a slug of a human-supplied display name (not auto-derived
// like person_id, since a group's name is a judgment call -- see the file's header comment).
// deriveGroupSeasons is the pure function seed-default-group.mjs uses to shape a
// fpl_entry_gameweek season scan + a seasons league_id lookup into group_seasons rows.

import { test } from 'node:test';
import assert from 'node:assert';
import { slugify, deriveGroupSeasons } from '../utils/groups.mjs';

test('slugify lowercases and hyphenates', () => {
  assert.strictEqual(slugify('Carpe Diem'), 'carpe-diem');
});

test('slugify strips punctuation and collapses repeated separators', () => {
  assert.strictEqual(slugify('Sunday League FC!!'), 'sunday-league-fc');
  assert.strictEqual(slugify('  Multiple   Spaces  '), 'multiple-spaces');
});

test('deriveGroupSeasons dedupes and sorts season strings oldest-first', () => {
  const result = deriveGroupSeasons({
    groupId: 'carpe-diem',
    seasonStrings: ['2025/26', '2019/20', '2025/26', '2022/23']
  });
  assert.deepStrictEqual(result.map((r) => r.season_string), ['2019/20', '2022/23', '2025/26']);
});

test('deriveGroupSeasons attaches a known league_id, defaults to null when unknown', () => {
  const result = deriveGroupSeasons({
    groupId: 'carpe-diem',
    seasonStrings: ['2025/26', '2019/20'],
    leagueIdBySeasonString: { '2025/26': 438107 }
  });
  const bySeason = Object.fromEntries(result.map((r) => [r.season_string, r.league_id]));
  assert.strictEqual(bySeason['2025/26'], 438107);
  assert.strictEqual(bySeason['2019/20'], null);
});

test('deriveGroupSeasons skips blank/missing season strings', () => {
  const result = deriveGroupSeasons({
    groupId: 'carpe-diem',
    seasonStrings: ['2025/26', null, '', undefined]
  });
  assert.strictEqual(result.length, 1);
});

test('every derived row carries the given group_id', () => {
  const result = deriveGroupSeasons({ groupId: 'carpe-diem', seasonStrings: ['2025/26'] });
  assert.strictEqual(result[0].group_id, 'carpe-diem');
});
