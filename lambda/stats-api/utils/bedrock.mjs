// Single source of truth for calling Bedrock from GenBI. Previously this file held a
// second, unused, simpler implementation (callClaude) that duplicated genbi.mjs's own
// inline callClaudeWithContext() -- both hardcoded the same now-deprecated model ID
// (anthropic.claude-3-haiku-20240307-v1:0, which Bedrock has marked legacy and denies
// access to). Same "hardcoded value duplicated in two places, only one gets fixed"
// pattern that's already bitten this project three times (LEAGUE_ID, gameweek fallback
// x2) -- consolidated into one function so there's only one place to update.
//
// Model: Claude Haiku 4.5. us-west-2 does not support in-region on-demand invocation
// for this model (confirmed via the Bedrock model card), so this uses the cross-region
// "Geo: US" inference profile ID (the `us.`-prefixed one) rather than the bare model ID.
export const CLAUDE_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

function buildSystemPrompt(leagueContext) {
  return `
<role>
You are a deterministic FPL Data Analyst. Your output MUST be 100% grounded in the provided context. You are strictly forbidden from using your own memory of player transfers or team history.
</role>

<definitions>
- MANAGER FORM: Defined EXCLUSIVELY by the number of wins in the <recent_form_summary> (the last 5 weeks of data).
- SEASON LEADERS: Defined by the <total_season_summary>.
- CAPTAIN SCORE: (Player's GW points as listed) × 2.
</definitions>

<context>
  <current_gw>${leagueContext.gameweek}</current_gw>
  <recent_form_summary>${JSON.stringify(leagueContext.recent_form_summary)}</recent_form_summary>
  <total_season_summary>${JSON.stringify(leagueContext.total_season_summary)}</total_season_summary>
  <player_data>${JSON.stringify(leagueContext.players_gw_data)}</player_data>
  <manager_picks>${JSON.stringify(leagueContext.our_league_picks)}</manager_picks>
</context>

<instructions>
1. If asked about "Form": Rank managers by the count in <recent_form_summary>. Explain that "Form" considers only the last 5 gameweeks.
2. If asked about "Captains":
   - Match the player name from <manager_picks> to their points in <player_data>.
   - YOU MUST SHOW THE MATH: "(Points) x 2 = Total".
   - Never report a captain score higher than 60 for a single gameweek.
3. DATA INTEGRITY: Use only the 'team_name' provided in <player_data>. Do not assume Mbeumo is at Brentford if the data says "Man Utd".
</instructions>

Calculate results carefully using only the provided context and be concise.`;
}

export async function askClaude(question, leagueContext) {
  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1024,
    system: buildSystemPrompt(leagueContext),
    messages: [
      {
        role: 'user',
        content: question
      }
    ]
  };

  const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
  const bedrockClient = new BedrockRuntimeClient({ region: 'us-west-2' });

  const command = new InvokeModelCommand({
    modelId: CLAUDE_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payload)
  });

  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));

  return {
    response: responseBody.content[0].text,
    usage: responseBody.usage
  };
}
