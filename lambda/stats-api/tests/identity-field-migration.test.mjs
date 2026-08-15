// utils/identity-field-migration.mjs -- pure rename helpers backing
// scripts/migrate-identity-field-names.mjs. See that file's header comment for why
// this renames to brand-new field names (real_name/team_nickname) rather than
// literally swapping team_name/manager_name.

import { test } from 'node:test';
import assert from 'node:assert';
import {
  needsFlatRename,
  renameFlatIdentityFields,
  renameWinnersList,
  winnersListNeedsRename
} from '../utils/identity-field-migration.mjs';

test('needsFlatRename is true when team_name is present', () => {
  assert.strictEqual(needsFlatRename({ team_name: 'Chetan Bk', manager_name: 'COYS' }), true);
});

test('needsFlatRename is true when only manager_name is present (edge case, still needs cleanup)', () => {
  assert.strictEqual(needsFlatRename({ manager_name: 'COYS' }), true);
});

test('needsFlatRename is false once an item has already been migrated', () => {
  assert.strictEqual(needsFlatRename({ real_name: 'Chetan Bk', team_nickname: 'COYS' }), false);
});

test('renameFlatIdentityFields maps team_name -> real_name and manager_name -> team_nickname', () => {
  const result = renameFlatIdentityFields({ team_name: 'Chetan Bk', manager_name: 'COYS', other: 'field' });
  assert.deepStrictEqual(result, { real_name: 'Chetan Bk', team_nickname: 'COYS' });
});

test('renameFlatIdentityFields defaults team_nickname to null when manager_name is null (historical rows)', () => {
  const result = renameFlatIdentityFields({ team_name: 'Sunil Mathew', manager_name: null });
  assert.deepStrictEqual(result, { real_name: 'Sunil Mathew', team_nickname: null });
});

test('renameFlatIdentityFields defaults team_nickname to null when manager_name is missing entirely', () => {
  const result = renameFlatIdentityFields({ team_name: 'Sunil Mathew' });
  assert.deepStrictEqual(result, { real_name: 'Sunil Mathew', team_nickname: null });
});

test('renameWinnersList renames every entry and preserves every other field untouched', () => {
  const winners = [
    { entry_id: 6409595, team_name: 'Michael Kojo Brown', manager_name: 'Da Movement', net_points: 82, gross_points: 90, transfer_cost: 8 },
    { entry_id: 12345, team_name: 'Chetan Bk', manager_name: 'COYS', net_points: 82, gross_points: 82, transfer_cost: 0 }
  ];
  const result = renameWinnersList(winners);
  assert.deepStrictEqual(result, [
    { entry_id: 6409595, real_name: 'Michael Kojo Brown', team_nickname: 'Da Movement', net_points: 82, gross_points: 90, transfer_cost: 8 },
    { entry_id: 12345, real_name: 'Chetan Bk', team_nickname: 'COYS', net_points: 82, gross_points: 82, transfer_cost: 0 }
  ]);
});

test('renameWinnersList defaults team_nickname to null for a null manager_name entry', () => {
  const result = renameWinnersList([{ entry_id: 1, team_name: 'Sunil Mathew', manager_name: null, net_points: 50 }]);
  assert.strictEqual(result[0].team_nickname, null);
});

test('renameWinnersList handles an empty or missing list without throwing', () => {
  assert.deepStrictEqual(renameWinnersList([]), []);
  assert.deepStrictEqual(renameWinnersList(undefined), []);
});

test('winnersListNeedsRename is true if any entry still has the old field names', () => {
  const winners = [
    { entry_id: 1, real_name: 'Already Migrated', team_nickname: null },
    { entry_id: 2, team_name: 'Not Yet Migrated', manager_name: null }
  ];
  assert.strictEqual(winnersListNeedsRename(winners), true);
});

test('winnersListNeedsRename is false once every entry is migrated', () => {
  const winners = [{ entry_id: 1, real_name: 'Chetan Bk', team_nickname: 'COYS' }];
  assert.strictEqual(winnersListNeedsRename(winners), false);
});

test('winnersListNeedsRename is false (not an error) for an empty or missing list', () => {
  assert.strictEqual(winnersListNeedsRename([]), false);
  assert.strictEqual(winnersListNeedsRename(undefined), false);
});
