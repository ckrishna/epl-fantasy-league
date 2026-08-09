// EVAL: selectRelevantFields() in utils/router.mjs
//
// New: a deterministic (non-model) router that decides which of GenBI's 6 context
// fields a question actually needs, so genbi.mjs can skip fetching/sending fields
// that aren't relevant instead of always fetching all 6 on every question.
//
// Run BEFORE the fix: expect FAIL (module doesn't exist yet).
// Run AFTER the fix: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { selectRelevantFields } from '../utils/router.mjs';

test('[current bug] a plain standings question only selects standings', () => {
  const fields = selectRelevantFields('What are our league standings?');
  assert.strictEqual(fields.standings, true);
  assert.strictEqual(fields.playerGwData, false);
  assert.strictEqual(fields.seasonTotals, false);
  assert.strictEqual(fields.managerPicks, false);
});

test('[current bug] a win-count question selects seasonWins but not playerGwData/seasonTotals', () => {
  const fields = selectRelevantFields('Who has the most GW wins this season?');
  assert.strictEqual(fields.seasonWins, true);
  assert.strictEqual(fields.playerGwData, false);
});

test('[current bug] a form question selects recentForm', () => {
  const fields = selectRelevantFields('Which managers are in form?');
  assert.strictEqual(fields.recentForm, true);
});

test('[current bug] a captain question selects both managerPicks and playerGwData', () => {
  const fields = selectRelevantFields('Best captain picks this week?');
  assert.strictEqual(fields.managerPicks, true, 'Captain math needs manager_picks (who captained who)');
  assert.strictEqual(fields.playerGwData, true, 'Captain math needs player_data (their points)');
});

test('[current bug] an explicit numbered gameweek reference selects playerGwData', () => {
  const fields = selectRelevantFields('Who scored the most points in GW5?');
  assert.strictEqual(fields.playerGwData, true);
});

test('[current bug] a season-scoped player question selects seasonTotals, not playerGwData alone', () => {
  const fields = selectRelevantFields('Who scored the most points this season?');
  assert.strictEqual(fields.seasonTotals, true);
});

test('[current bug] a fully unrecognized question falls back to selecting everything', () => {
  const fields = selectRelevantFields('How do you know about my league?');
  for (const value of Object.values(fields)) {
    assert.strictEqual(value, true, 'Expected the safe fallback: fetch everything when nothing matched');
  }
});

test('[current bug] a win-streak question selects managerStats', () => {
  const fields = selectRelevantFields('Who has the longest win streak?');
  assert.strictEqual(fields.managerStats, true);
});

test('[current bug] a transfer-activity question selects managerStats', () => {
  const fields = selectRelevantFields('Who made the most transfers this season?');
  assert.strictEqual(fields.managerStats, true);
});

test('[current bug] a chip-usage question selects managerStats', () => {
  const fields = selectRelevantFields('Who played their wildcard chip?');
  assert.strictEqual(fields.managerStats, true);
});

test('[regression] every field key is always present, never undefined', () => {
  const fields = selectRelevantFields('anything at all');
  for (const key of ['standings', 'seasonWins', 'recentForm', 'playerGwData', 'seasonTotals', 'managerPicks', 'managerStats']) {
    assert.strictEqual(typeof fields[key], 'boolean', `Expected ${key} to always be a boolean`);
  }
});

test('[regression] empty question string does not throw, falls back to everything', () => {
  const fields = selectRelevantFields('');
  assert.strictEqual(fields.standings, true);
});

test('[regression] undefined question does not throw, falls back to everything', () => {
  const fields = selectRelevantFields(undefined);
  assert.strictEqual(fields.standings, true);
});
