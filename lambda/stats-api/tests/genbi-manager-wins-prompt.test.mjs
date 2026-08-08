// EVAL: buildSystemPrompt() disambiguates "most GW wins" from "form".
//
// Bug: a plain "which manager had the most GW wins?" question (no "form"/"recently"/
// "lately" wording) has no explicit routing rule in <instructions> -- only "Form"
// questions and "Captains" questions are covered. Left ambiguous, the model hedges by
// answering both the 5-week recent_form_summary AND the season-long total_season_summary
// in the same response instead of giving one direct answer. Same ambiguity class as the
// player-points gameweek-vs-season fix (instruction #4); this adds the equivalent rule
// for manager win counts (instruction #5).
//
// Note: this only asserts the instruction text reaches Bedrock -- actual model behavior
// on ambiguous phrasing can't be asserted against a mocked Bedrock call, only verified
// live.
//
// Run BEFORE the fix: expect FAIL.
// Run AFTER the fix: expect PASS.

import { test } from 'node:test';
import assert from 'node:assert';
import { installBedrockMock } from './helpers/mock-bedrock.mjs';
import { askClaude } from '../utils/bedrock.mjs';

test('[current bug] system prompt tells the model to answer plain "most wins" questions from total_season_summary, not recent_form_summary', async () => {
  const bedrockMock = installBedrockMock('Da Movement leads with 10 wins.');
  try {
    await askClaude('Which manager had the most number of GW wins?', {
      gameweek: 10,
      recent_form_summary: {},
      total_season_summary: {},
      players_gw_data: [],
      our_league_picks: []
    });
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    const system = payload.system;

    assert.match(system, /MANAGER WIN COUNTS/,
      'Expected an explicit instruction disambiguating plain "most wins" questions.');
    assert.match(system, /total_season_summary/,
      'Expected the win-count rule to reference total_season_summary.');
    assert.match(system, /do not hedge/i,
      'Expected the instruction to tell the model to give one direct answer instead of both interpretations.');
  } finally {
    bedrockMock.restore();
  }
});

test('[regression] Form instruction (#1) is untouched by the new rule', async () => {
  const bedrockMock = installBedrockMock('Yash is in the best form.');
  try {
    await askClaude('Who is in the best form?', {
      gameweek: 10,
      recent_form_summary: {},
      total_season_summary: {},
      players_gw_data: [],
      our_league_picks: []
    });
    const payload = JSON.parse(bedrockMock.calls[0].input.body);
    assert.match(payload.system, /Rank managers by the count in <recent_form_summary>/);
  } finally {
    bedrockMock.restore();
  }
});
