// utils/people.mjs -- person_id is a pure, DynamoDB-free deterministic function of a
// normalized real name (not of anything FPL issues, since neither entry_id nor
// league_id survives a season rollover -- see DATA_MODEL.md). Covers: stability,
// whitespace/formatting insensitivity (via normName), and the row-deriving helper the
// backfill script uses.

import { test } from 'node:test';
import assert from 'node:assert';
import { stablePersonId, derivePeopleFromRows } from '../utils/people.mjs';

test('the same name always produces the same person_id', () => {
  assert.strictEqual(stablePersonId('Chetan Bk'), stablePersonId('Chetan Bk'));
});

test('whitespace-only variants of the same name produce the same person_id', () => {
  assert.strictEqual(stablePersonId('Chetan  Bk'), stablePersonId('Chetan Bk'));
  assert.strictEqual(stablePersonId('  Chetan Bk  '), stablePersonId('Chetan Bk'));
});

test('different names produce different person_ids', () => {
  assert.notStrictEqual(stablePersonId('Chetan Bk'), stablePersonId('Michael Kojo Brown'));
});

test('person_id is a short, readable, prefixed string, not a raw hash', () => {
  const id = stablePersonId('Chetan Bk');
  assert.match(id, /^person_[0-9a-f]{12}$/);
});

test('derivePeopleFromRows dedupes by normalized name and sorts by canonical_name', () => {
  const rows = [
    { team_name: 'Michael Kojo Brown', season: '2025/26' },
    { team_name: 'Chetan Bk', season: '2025/26' },
    { team_name: 'Chetan  Bk', season: '2026/27' }, // same person, different whitespace
    { team_name: 'Michael Kojo Brown', season: '2026/27' }
  ];

  const people = derivePeopleFromRows(rows);

  assert.strictEqual(people.length, 2, 'expected exactly 2 distinct people, not 4 rows worth');
  assert.deepStrictEqual(people.map((p) => p.canonical_name), ['Chetan Bk', 'Michael Kojo Brown']);
  assert.strictEqual(people[0].person_id, stablePersonId('Chetan Bk'));
});

test('derivePeopleFromRows skips rows with a blank/missing name', () => {
  const rows = [
    { team_name: 'Chetan Bk' },
    { team_name: '' },
    { team_name: null },
    {}
  ];

  const people = derivePeopleFromRows(rows);

  assert.strictEqual(people.length, 1);
});

test('derivePeopleFromRows honors a custom nameField', () => {
  const rows = [{ manager_real_name: 'Chetan Bk' }];
  const people = derivePeopleFromRows(rows, { nameField: 'manager_real_name' });
  assert.strictEqual(people.length, 1);
  assert.strictEqual(people[0].canonical_name, 'Chetan Bk');
});
