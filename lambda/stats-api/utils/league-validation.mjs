// League onboarding validation -- the checks that must pass before a new league_id is
// registered in the `leagues` table (see scripts/add-league.mjs for the CLI that runs
// this).
//
// IMPORTANT, confirmed live 2026-08-14: FPL RECYCLES league_id values across seasons.
// Querying an old id from a rolled-over season does NOT error and does NOT return that
// old league's data -- it returns whatever NEW, completely unrelated league happens to
// have been created with that same numeric id this season. Confirmed: id 212889 was
// our own 2025/26 league last year; queried today (pre-season 2026/27) it now resolves
// to a league called "Fornebu" with entirely different members, created 2026-07-24.
// This means "must be for the current season" is not actually a condition FPL lets a
// league_id fail -- you structurally cannot address a rolled-over season's league by its
// old id at all, every query is answered against whatever is currently live. What it DOES
// mean: a stale/copy-pasted league_id will silently resolve to a DIFFERENT real league,
// with no error to catch it. The defense here is showing the human exactly what was
// found (name, created date, entry count) before anything gets written, not a pass/fail
// season check.
//
// This also means the `leagues` table must key on (league_id, season_string) together,
// NOT league_id alone -- the same numeric id WILL be reused by an unrelated league in a
// future season, and that is not a duplicate, it's two different leagues that happen to
// share a recycled number.

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, FPL_API, FPL_FETCH_HEADERS, getCurrentSeason } from './dynamodb.mjs';

// Default safety cap on league size. Lowered 100 -> 25 (2026-08-15): the real risk isn't
// validation-time cost -- countLeagueEntries above already paginates correctly -- it's
// that fpl-data-ingester's getLeagueManagers() does NOT paginate FPL's league-standings
// response (see task #50/#137), so any league larger than one FPL results page silently
// loses members during actual ingestion, with no error. FPL's real per-page size hasn't
// been confirmed live yet (blocked on real 2026/27 data, see DATA_MODEL.md), so 25 is a
// deliberately conservative margin below any plausible page size until #50 ships and
// ingestion itself is safe for larger leagues. Once #50 is fixed, this can go back up
// toward the original 100 (a few dozen people is still the realistic ceiling for a
// private/office league; FPL's own "Overall" league, id 314, has 11M+ entries -- the cap
// is there to block that kind of accidental paste, not to be a tight budget). Raise with
// care -- this constant is the only place that needs to change.
export const MAX_LEAGUE_ENTRIES = Number(process.env.LEAGUE_MAX_ENTRIES) || 25;

// Fetches one page of a league's standings/new_entries. Returns null for a 404 (no such
// league at all) so callers can distinguish "doesn't exist" from a real network error.
async function fetchStandingsPage(leagueId, page) {
  const response = await fetch(
    `${FPL_API}/leagues-classic/${leagueId}/standings/?page_standings=${page}&page_new_entries=${page}`,
    { headers: FPL_FETCH_HEADERS }
  );
  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`FPL API returned HTTP ${response.status} for league ${leagueId}`);
  }
  return response.json();
}

// Counts total entries in a league, preferring `standings` (populated once at least one
// gameweek has scored) and falling back to `new_entries` (brand-new, pre-scoring league)
// -- the same fallback fpl-data-ingester's getLeagueManagers() already uses, for the same
// reason (see that file's comment). Bails out the moment the running count crosses
// `capAtMost` rather than paging a huge league to completion just to prove it's too big
// -- paging all of a millions-strong league just to confirm it's oversized would be its
// own denial-of-service against ourselves.
async function countLeagueEntries(leagueId, capAtMost) {
  let page = 1;
  let total = 0;
  let usedSource = null;

  while (true) {
    const data = await fetchStandingsPage(leagueId, page);
    if (!data) return { total, exceeded: false };

    const standingsResults = data.standings?.results ?? [];
    const newEntriesResults = data.new_entries?.results ?? [];

    // Source is decided once, from page 1, then stuck to -- switching mid-count would
    // double count or drop people if standings and new_entries both have data.
    if (page === 1) {
      usedSource = standingsResults.length > 0 ? 'standings' : 'new_entries';
    }

    const pageCount = usedSource === 'standings' ? standingsResults.length : newEntriesResults.length;
    total += pageCount;

    if (total > capAtMost) {
      return { total, exceeded: true };
    }

    const hasNext = usedSource === 'standings' ? !!data.standings?.has_next : !!data.new_entries?.has_next;
    if (!hasNext || pageCount === 0) break;
    page += 1;
  }

  return { total, exceeded: false };
}

// Runs all three checks (exists & open, not a duplicate for this season, under the size
// cap) and returns one result an admin script or future admin UI can render directly.
// Never throws for a normal validation failure -- only for genuinely unexpected errors
// (network failure, malformed FPL response) -- so callers can always show *why* a league
// didn't pass, not just that it didn't.
export async function validateLeagueForOnboarding(leagueId, { season, maxEntries = MAX_LEAGUE_ENTRIES } = {}) {
  const numericId = Number(leagueId);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return { ok: false, errors: [`"${leagueId}" isn't a valid league id (expected a positive integer).`], league: null };
  }

  const firstPage = await fetchStandingsPage(numericId, 1);
  if (!firstPage) {
    return { ok: false, errors: [`No league found for id ${numericId} (FPL returned 404).`], league: null };
  }
  const league = firstPage.league;
  if (!league) {
    return {
      ok: false,
      errors: [`FPL's response for league ${numericId} was missing league details -- unexpected shape, investigate before proceeding.`],
      league: null
    };
  }

  const errors = [];
  if (league.closed) {
    errors.push(`League "${league.name}" (${numericId}) is marked closed by FPL -- closed leagues don't accept new/updated data.`);
  }

  // Duplicate check -- scoped to (league_id, season), see file header for why.
  const currentSeason = season || (await getCurrentSeason());
  const existing = await dynamodb.send(new GetCommand({
    TableName: 'leagues',
    Key: { league_id: numericId, season_string: currentSeason }
  }));
  if (existing.Item) {
    errors.push(`League ${numericId} is already registered for ${currentSeason} (added ${existing.Item.added_at}).`);
  }

  const { total, exceeded } = await countLeagueEntries(numericId, maxEntries);
  if (exceeded) {
    errors.push(
      `League "${league.name}" (${numericId}) has more than ${maxEntries} entries -- too large to onboard ` +
      `(cap exists to bound ingestion cost/time, see MAX_LEAGUE_ENTRIES in league-validation.mjs).`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    league: {
      id: numericId,
      name: league.name,
      created: league.created,
      closed: league.closed,
      entryCount: exceeded ? `${maxEntries}+` : total,
      season: currentSeason
    }
  };
}
