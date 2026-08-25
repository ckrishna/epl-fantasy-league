// src/components/ManagerSquad.jsx
//
// The "click a manager in Standings" squad view -- a pitch-formation layout showing a
// manager's current picks, each player's own club code, a hot/cold form indicator, and
// their next two fixtures color-coded by difficulty. Renders inline in place of the
// standings list (not a modal/popup) -- Standings.jsx swaps this in for the list when
// a manager is selected, and swaps back via the "Back to standings" button below or by
// re-clicking the Standings nav tab. Design finalized over several mockup rounds with
// the app owner
// (see the rules baked into the CSS: every player card shares one fixed background and
// one fixed club-badge color regardless of light/dark theme -- deliberately NOT
// theme-aware).
import { useEffect, useState } from 'react';
import { getManagerSquad, getSquadAdvisor } from '../api/client';
import '../styles/ManagerSquad.css';

const POSITION_ORDER = ['GKP', 'DEF', 'MID', 'FWD'];
const POSITION_LETTER = { GKP: 'G', DEF: 'D', MID: 'M', FWD: 'F' };

// FPL's own chip identifiers (as stored on fpl_entry_gameweek.active_chip by
// fpl-data-ingester) -- 'manager' is Assistant Manager, the newest chip (see
// DATA_MODEL.md's historical-import notes for when this codebase first had to handle
// it). Short 2-letter codes rather than full words -- this sits inline next to the
// team nickname in the legend row, which already has to share space with the "?" help
// icon and (on the advisor-mock-preview branch, not yet merged, but reserved for here
// regardless per direct feedback) a center advisor icon. Full name is still available
// via the badge's title attribute on hover.
const CHIP_CODES = {
  wildcard: 'WC',
  freehit: 'FH',
  bboost: 'BB',
  '3xc': 'TC',
  manager: 'AM'
};

const CHIP_NAMES = {
  wildcard: 'Wildcard',
  freehit: 'Free Hit',
  bboost: 'Bench Boost',
  '3xc': 'Triple Captain',
  manager: 'Assistant Manager'
};

// Home-kit colors per club, keyed by the same short code the backend already sends as
// player.team_code (see manager-squad.mjs's CLUB_INFO) -- no backend change needed.
// `pattern` is optional: 'stripes' draws two vertical bands of `accent` over the base
// `primary` fill (roughly approximating each club's actual vertical-stripe home kit --
// Bournemouth, Brentford, Brighton, Crystal Palace, Newcastle, Sunderland all really do
// wear stripes, not a solid shirt); 'sleeve-contrast' colors just the two shoulder/
// sleeve regions in `accent` (West Ham's claret body with sky-blue sleeves). Everyone
// else is a plain solid + trim. Deliberately colors/patterns only -- no club crests,
// sponsor logos, or manufacturer marks are reproduced here, since those are licensed
// artwork this app has no rights to; a generic jersey shape in a club's real colors
// isn't the same as copying an official kit photo. Falls back to a neutral gray/white
// pair for any club not listed (new promotions before this map is updated, or a data
// glitch), matching ClubBadge's own "never crash on an unknown club" rule.
const KIT_COLORS = {
  ARS: { primary: '#EF0107', trim: '#023474' },
  AVL: { primary: '#670E36', trim: '#94BEE5' },
  BOU: { primary: '#DA020E', trim: '#000000', pattern: 'stripes', accent: '#000000' },
  BRE: { primary: '#E30613', trim: '#FFFFFF', pattern: 'stripes', accent: '#FFFFFF' },
  BHA: { primary: '#0057B8', trim: '#FFFFFF', pattern: 'stripes', accent: '#FFFFFF' },
  BUR: { primary: '#6C1D45', trim: '#99D6EA' },
  CHE: { primary: '#034694', trim: '#FFFFFF' },
  CRY: { primary: '#1B458F', trim: '#C4122E', pattern: 'stripes', accent: '#C4122E' },
  EVE: { primary: '#003399', trim: '#FFFFFF' },
  FUL: { primary: '#FFFFFF', trim: '#CC0000' },
  LEE: { primary: '#FFFFFF', trim: '#1D428A' },
  LIV: { primary: '#C8102E', trim: '#00B2A9' },
  MCI: { primary: '#6CABDD', trim: '#1C2C5B' },
  MUN: { primary: '#DA291C', trim: '#000000' },
  NEW: { primary: '#241F20', trim: '#FFFFFF', pattern: 'stripes', accent: '#FFFFFF' },
  NFO: { primary: '#DD0000', trim: '#FFFFFF' },
  SUN: { primary: '#E32219', trim: '#FFFFFF', pattern: 'stripes', accent: '#FFFFFF' },
  TOT: { primary: '#FFFFFF', trim: '#131319' },
  WHU: { primary: '#7A263A', trim: '#1BB1E7', pattern: 'sleeve-contrast', accent: '#1BB1E7' },
  WOL: { primary: '#FDB913', trim: '#231F20' },
  // Promoted for 2026/27 (confirmed live against bootstrap-static's teams array on
  // 2026-08-23, replacing Burnley/West Ham/Wolves -- see CLUB_INFO's own comment in
  // manager-squad.mjs for why those three stay in this map rather than being removed).
  // Hull's real home kit really is amber/black vertical stripes (their long-standing
  // "Tigers" identity), Coventry's is a plain sky blue ("Sky Blues"), Ipswich's is
  // royal blue with white sleeves.
  COV: { primary: '#78BFE6', trim: '#FFFFFF' },
  HUL: { primary: '#F18A00', trim: '#000000', pattern: 'stripes', accent: '#000000' },
  IPS: { primary: '#0044A9', trim: '#FFFFFF', pattern: 'sleeve-contrast', accent: '#FFFFFF' }
};
const DEFAULT_KIT = { primary: '#4b5563', trim: '#ffffff' };


// Shortened from the first jersey-shape draft per direct feedback ("the jersey is too
// long") -- a squatter torso reads as a shirt rather than a robe at this size. All
// coordinates are non-negative (viewBox starts at 0,0) so the collar peaks never get
// clipped by the svg's default overflow:hidden.
const JERSEY_PATH = 'M22 8 L38 1 Q50 10 62 1 L78 8 L96 21 L82 35 L78 30 L78 85 Q50 93 22 85 L22 30 L18 35 L4 21 Z';
const JERSEY_COLLAR_PATH = 'M38 1 Q50 10 62 1 L57 9 Q50 14 43 9 Z';

// MOCK CONTENT -- GH #44 ("Advisor: suggest squad moves using league + global FPL
// data"). Four categories, redesigned 2026-08-24 per direct feedback on the original
// one-card-at-a-time layout ("not intuitive") into a short, scannable list -- see
// AdvisorModal below. Squad Change is now REAL (see getSquadAdvisor/buildTransferMove
// -- direct instruction scoped the first real pass to exactly this, sourced from the
// full player pool, not just the manager's own bench). Captain Pick, Chip Watch, and
// Differential Pick are still this hand-written placeholder content -- AdvisorModal
// marks them `preview: true` so nobody mistakes them for real advice now that Squad
// Change genuinely is. Differential is scoped to "top 100 overall FPL ranks" per direct
// instruction, not our own league's ownership (which we DO already compute for GenBI,
// via computeOwnershipAggregates -- deliberately not reused here, since FPL exposes no
// top-100-overall ownership feed, so this stays hand-written either way for now).
// Uses a real current player's name (not a generic placeholder like "Low-owned
// Midfielder") for Captain Pick/Chip Watch/Differential Pick's `name` field, per direct
// feedback that a fake-sounding placeholder read as confusing rather than obviously
// illustrative -- a user asked "who is the low owned midfielder?" expecting a real
// answer. The stat attached to it (e.g. "4% owned, top 100") is still illustrative, not
// computed -- the `preview: true` tag + subtitle are what actually communicate that,
// not the name itself.
// The 'transfer' entry below is kept only as the source for the dev-only
// /__advisor-preview page (see mockTransferMove), which has no real entryId to query.
const MOCK_ADVISOR = {
  moves: [
    {
      kind: 'transfer',
      title: 'Squad Change',
      teaser: '+4.2 pts',
      delta: '+4.2 pts',
      out: { name: 'Struggling Def' },
      in: { name: 'In-form Def' },
      reason: 'Two home fixtures in the next three gameweeks against sides averaging under 1 xG, and rising ownership among top managers.'
    },
    {
      kind: 'captain',
      title: 'Captain Pick',
      teaser: '+3.1 pts',
      delta: '+3.1 pts',
      name: 'Erling Haaland',
      reason: 'Home fixture against a defense that’s conceded in 5 of their last 6, and nailed-on penalty duty -- vs your current armband.'
    },
    {
      kind: 'chip',
      title: 'Chip Watch',
      teaser: 'Bench Boost',
      chipKey: 'bboost',
      name: 'Bench Boost',
      reason: 'Your bench looks unusually strong this week -- Jordan Pickford and 2 of your other 3 subs are nailed starters with winnable fixtures. Worth weighing now, or saving for a double gameweek.'
    },
    {
      kind: 'differential',
      title: 'Differential Pick',
      teaser: '4% owned (top 100)',
      name: 'Morgan Gibbs-White',
      reason: 'Owned by just 4% of the top 100 overall ranks but trending up in form -- a lower-risk way to chase a rank gain than a heavily-owned template pick.'
    }
  ]
};

// Small circle badge shown on each collapsed row -- matches the app's existing
// letter/2-letter badge language (the "?" help button, captain "C"/"V" badges, chip
// codes on the points badge) rather than introducing a new icon set. Chip Watch uses
// the real chip abbreviation (CHIP_CODES) for whichever chip is actually being
// suggested, so the badge stays accurate if the suggested chip ever changes.
function rowIcon(move) {
  if (move.kind === 'transfer') return '⇄'; // ⇄
  if (move.kind === 'captain') return 'C';
  if (move.kind === 'chip') return CHIP_CODES[move.chipKey] || '★';
  if (move.kind === 'differential') return '%';
  return '•';
}

function difficultyTier(d) {
  if (d <= 2) return 'easy';
  if (d >= 4) return 'hard';
  return 'neutral';
}

// FPL's own single-letter availability code -> which color treatment (if any) the
// player's name band gets. 'a' (available) and anything unrecognized both mean "don't
// flag this" -- per direct instruction, an available player's name stays completely
// plain, not just visually quiet, so there's never a dead/no-op click target on a
// normal card. 'd' (doubtful) reads as a heads-up (yellow); 'i'/'s'/'u'/'n' (injured,
// suspended, unavailable, or some other reason FPL doesn't play them) all read as "not
// playing" (red) -- the manager cares that they're out, not exactly which of those
// four reasons, at a glance on the pitch view (the popup spells out the exact one).
function availabilityTier(status) {
  if (status === 'd') return 'doubtful';
  if (status === 'i' || status === 's' || status === 'u' || status === 'n') return 'unavailable';
  return null;
}

const AVAILABILITY_STATUS_LABEL = {
  d: 'Doubtful',
  i: 'Injured',
  s: 'Suspended',
  u: 'Unavailable',
  n: 'Not available'
};

// "9th", "1st", "2nd", "3rd" -- used for the opponent's league position in the
// fixture-detail popup. Handles the 11th/12th/13th "teenth" exception (which would
// otherwise wrongly read "11st"/"12nd"/"13rd" under the plain last-digit rule).
function ordinal(n) {
  if (typeof n !== 'number') return null;
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  return `${n}${suffix}`;
}

// FPL's own strength ratings run roughly 1000-1400 across the current league, with no
// official "this is Weak/Average/Strong" scale published anywhere -- these cutoffs are
// a reasonable estimate to turn the raw number into a plain-English read, per direct
// feedback on "what kind of information can we show that makes sense". Not tuned
// against real 2026/27 data yet since the season hasn't produced enough of it.
function strengthLabel(value) {
  if (typeof value !== 'number') return null;
  if (value >= 1250) return 'Strong';
  if (value >= 1120) return 'Average';
  return 'Weak';
}

const FORM_RESULT_LABEL = { W: 'Win', D: 'Draw', L: 'Loss' };

// `onClick`, when passed, turns this into a real button that opens the fixture-detail
// popup (see FixtureDetailModal below) with this exact fixture -- per direct feedback,
// this applies to all 3 fixture pills on a card (the current-gameweek one next to
// points, plus the two upcoming ones). The help modal's own example pills are plain
// squad-fixture-pill divs rendered directly (not through this component), so they stay
// inert illustrations without needing a special case here.
function FixturePill({ fixture, onClick }) {
  if (!fixture) return null;
  // Full 3-letter club code (ARS, AVL, ...) rather than a 2-letter-plus-H/A-suffix
  // shorthand -- that shorthand only existed because home/away used to be readable
  // ONLY from a trailing H/A letter buried in the pill's own text. Now that venue is
  // shown via the underline below (away games only, nothing extra on home games),
  // there's no reason to sacrifice a real letter of the club code for it, and the
  // real code is more recognizable at a glance than a truncated one.
  const label = fixture.opponent_code;
  const className = `squad-fixture-pill squad-fixture-${difficultyTier(fixture.difficulty)}${fixture.is_home ? '' : ' squad-fixture-away'}`;
  if (!onClick) {
    return <div className={className}>{label}</div>;
  }
  return (
    <button type="button" className={className} onClick={() => onClick(fixture)} aria-haspopup="dialog" title="View fixture details">
      {label}
    </button>
  );
}

// Shows the club's official crest image (from FPL's own crest CDN) inside the badge
// circle. Hotlinked images can occasionally fail to load (network hiccup, an
// unrecognized club with no crest_url, a privacy extension blocking a third-party
// image host) -- onError swaps back to the plain 3-letter text badge that was here
// before, rather than showing a broken-image icon.
function ClubBadge({ crestUrl, code }) {
  const [failed, setFailed] = useState(false);
  if (!crestUrl || failed) {
    return <div className="squad-club-badge squad-club-badge-text">{code}</div>;
  }
  return (
    <div className="squad-club-badge">
      <img src={crestUrl} alt={code} onError={() => setFailed(true)} />
    </div>
  );
}

// The player card's top half: a colored jersey silhouette (per the app owner's mock
// request -- "are we able to show the player card with the actual home team jersey?"),
// with the club crest on the chest, this gameweek's points printed where a real shirt's
// squad number would go (we don't store real squad numbers -- see the back-and-forth
// that landed here: points are real data we already have, a made-up number wasn't), and
// the captain/vice-captain/hot-form/cold-form corner badges sitting directly on the
// shirt instead of on a surrounding white card. All four corner badges deliberately
// share one plain black circle treatment (per direct feedback) -- captain/vice differ
// only by letter, hot/cold only by icon + icon color, so there's a single visual
// language for "something is flagged on this corner" instead of four different badge
// colors competing with the jersey and each other.
function JerseyBadge({ player, onOpenFixture }) {
  const colors = KIT_COLORS[player.team_code] || DEFAULT_KIT;
  // Unique per card (not just per club) since multiple copies of the same club's
  // jersey render on one page at once -- SVG clipPath ids must be unique in the DOM,
  // and two players sharing a club would otherwise silently clip against whichever
  // <defs> happened to render last.
  const clipId = `jersey-clip-${player.player_id}`;
  // Whether to actually show this gameweek's points number, or leave the bubble blank
  // because the game hasn't kicked off yet. Deliberately keyed on kickoff_time (a
  // fixed schedule set well in advance, effectively never stale) rather than the
  // fixture's own `status` field -- status only gets refreshed by a separate, once-a-
  // WEEK job (fpl-global-stats-weekly), so on a normal Sunday it can still read
  // 'PENDING' for a match that kicked off and finished the day before, blanking every
  // card's real score. kickoff_time needs no such refresh to stay accurate. No
  // current_fixture at all (a blank gameweek for this club) or no kickoff_time on it
  // both fall back to "show the points" -- there's nothing pending to wait for.
  const kickoffTime = player.current_fixture?.kickoff_time;
  const hasKickedOff = !kickoffTime || new Date(kickoffTime) <= new Date();
  return (
    <div className="squad-jersey-card">
      {/* Shirt scaled down to ~75% per direct feedback -- a dedicated points bar
          below (full card width, not squeezed onto the shirt fabric itself) reads
          better than a pill floating over the shirt, and sidesteps the contrast
          problems a floating pill had on striped/light kits entirely, since the bar
          has its own guaranteed background regardless of jersey color or pattern. */}
      <div className="squad-jersey-shirt">
        {player.is_captain && <div className="squad-corner-badge squad-corner-left">C</div>}
        {player.is_vice_captain && !player.is_captain && (
          <div className="squad-corner-badge squad-corner-left">V</div>
        )}
        {player.form_tag === 'cold' && (
          <div className="squad-corner-badge squad-corner-right squad-cold-badge" aria-label="Cold form" title="Cold form">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 2v20M6 5l6 3.5L18 5M6 19l6-3.5L18 19M4 9l8 3-8 3M20 9l-8 3 8 3" />
            </svg>
          </div>
        )}
        {player.form_tag === 'hot' && (
          <div className="squad-corner-badge squad-corner-right squad-hot-badge" aria-label="Hot form" title="Hot form">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8.5 14.5A2.5 2.5 0 0 0 11 17a2.5 2.5 0 0 0 2.5-2.5c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5" />
            </svg>
          </div>
        )}

        {/* viewBox cropped to y=0-52 (of the full 93-unit-tall jersey path) --
            everything below that (plain torso fabric, the hem) is simply outside
            the viewBox and never drawn, per direct feedback to keep the shirt full
            width/scale but shorten it rather than shrinking the whole graphic. */}
        <svg className="squad-jersey-svg" viewBox="0 0 100 52" aria-hidden="true">
          <defs>
            <clipPath id={clipId}>
              <path d={JERSEY_PATH} />
            </clipPath>
          </defs>
          <path d={JERSEY_PATH} fill={colors.primary} stroke={colors.trim} strokeWidth="2.5" />
          {colors.pattern === 'stripes' && (
            <g clipPath={`url(#${clipId})`}>
              <rect x="20" y="0" width="20" height="93" fill={colors.accent} />
              <rect x="60" y="0" width="20" height="93" fill={colors.accent} />
            </g>
          )}
          {colors.pattern === 'sleeve-contrast' && (
            <g clipPath={`url(#${clipId})`}>
              <rect x="0" y="0" width="26" height="93" fill={colors.accent} />
              <rect x="74" y="0" width="26" height="93" fill={colors.accent} />
            </g>
          )}
          <path d={JERSEY_COLLAR_PATH} fill={colors.trim} />
        </svg>

        <div className="squad-jersey-crest">
          <ClubBadge crestUrl={player.team_crest} code={player.team_code} />
        </div>
      </div>

      {/* Points and this gameweek's own fixture as two side-by-side tablets, same row
          -- per direct feedback, a separate row just for the current fixture used too
          much real estate; this fits it in the same space the points tablet already
          occupied instead of growing the card. The current-fixture tablet reuses
          FixturePill itself (same difficulty color + away dot as the two fixtures
          below) rather than a one-off style, so "this is a fixture" reads the same
          wherever a fixture pill appears on the card. null on a blank gameweek for
          this player's club -- then it's just the points tablet, same as before. */}
      {typeof player.gw_points === 'number' && (
        <div className="squad-points-row">
          {/* "TBD" rather than "0 PTS" when this player's own fixture hasn't kicked
              off yet -- a 0 there reads as "played and scored nothing", which isn't
              true yet. Same bubble, same size either way -- just a different label
              inside it, not an empty or missing one. */}
          <div className={`squad-points-bar${hasKickedOff ? '' : ' squad-points-bar-pending'}`}>
            {hasKickedOff ? (
              <>
                <span className="squad-points-bar-num">{player.gw_points}</span>
                <span className="squad-points-bar-label">PTS</span>
              </>
            ) : (
              <span className="squad-points-bar-tbd">TBD</span>
            )}
          </div>
          <FixturePill fixture={player.current_fixture} onClick={(f) => onOpenFixture(player, f)} />
        </div>
      )}
    </div>
  );
}

function PlayerCard({ player, onOpenFixture, onOpenAvailability }) {
  // null for a fully available player -- per direct instruction, that player's name
  // stays completely plain (no tint, not clickable) rather than just visually quiet,
  // so there's no dead click target on the vast majority of normal cards.
  const tier = availabilityTier(player.availability_status);
  return (
    <div className="squad-player-card">
      <JerseyBadge player={player} onOpenFixture={onOpenFixture} />
      <div className="squad-jersey-info">
        {/* Names are truncated to one line (CSS text-overflow: ellipsis on
            .squad-player-name) rather than wrapping -- per direct feedback, a long
            name wrapping to 2 lines made that one card taller than its row
            neighbors. title carries the full name for anyone who wants it via hover.
            A plain "-" is also a valid CSS line-break point, which used to split e.g.
            "Tarkowski-D" with the "D" stranded alone before truncation replaced
            wrapping entirely -- the non-breaking hyphen (U+2011) below is left in
            place since it's harmless and keeps the name+letter glued together in the
            one line that's still shown.

            Only the name's OWN row gets tinted for a doubtful/injured/suspended
            player -- per direct feedback, NOT the whole white info block (that would
            also tint the fixture pills below it, which is unrelated information). */}
        <div className={`squad-name-wrap${tier ? ` squad-name-wrap-${tier}` : ''}`}>
          {tier ? (
            <button type="button" className="squad-player-name squad-player-name-btn" title={player.name} onClick={() => onOpenAvailability(player)}>
              {player.name}
              {player.is_bench && (
                <span className="squad-position-letter">{'‑'}{POSITION_LETTER[player.position] || '?'}</span>
              )}
            </button>
          ) : (
            <p className="squad-player-name" title={player.name}>
              {player.name}
              {/* The starting XI is already grouped into GKP/DEF/MID/FWD rows on the
                  pitch, so the position letter is redundant there -- only the bench
                  (one mixed-position row) still needs it to tell a benched defender
                  from a benched forward at a glance. */}
              {player.is_bench && (
                <span className="squad-position-letter">{'‑'}{POSITION_LETTER[player.position] || '?'}</span>
              )}
            </p>
          )}
        </div>
        <div className="squad-fixture-list">
          {player.fixtures.map((f, i) => (
            <FixturePill key={i} fixture={f} onClick={(fx) => onOpenFixture(player, fx)} />
          ))}
        </div>
      </div>
    </div>
  );
}

// Four-point sparkle + two accompanying dots -- the familiar "AI" shorthand glyph,
// reused for both the pulsing pitch button and the modal header so the same icon shows
// up in both places.
function SparkleIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2c.9 3.3 1.8 5.7 2.8 6.7 1 1 3.4 1.9 6.7 2.8-3.3.9-5.7 1.8-6.7 2.8-1 1-1.9 3.4-2.8 6.7-.9-3.3-1.8-5.7-2.8-6.7-1-1-3.4-1.9-6.7-2.8 3.3-.9 5.7-1.8 6.7-2.8 1-1 1.9-3.4 2.8-6.7Z" />
      <circle cx="19.5" cy="4.5" r="1.3" />
      <circle cx="4.5" cy="19" r="1" />
    </svg>
  );
}

// One move's actual content -- kept separate from the stepper chrome below so adding a
// new `kind` later (e.g. "chip") only means adding a case here, not touching navigation.
// The transfer move now has two extra states a mock move never had: `loading` (still
// waiting on getSquadAdvisor) and `noSuggestion` (the real backend came back with
// found: false -- e.g. no affordable upgrade, or no picks data yet) -- both render as
// plain text instead of the OUT/IN boxes, which only make sense once there's an actual
// pair of players to show.
function AdvisorMoveBody({ move }) {
  if (move.kind === 'transfer') {
    if (move.loading) {
      return <p className="squad-advisor-transfer-name">Fetching a live suggestion&hellip;</p>;
    }
    if (move.noSuggestion) {
      return null;
    }
    return (
      <div className="squad-advisor-transfer">
        <div className="squad-advisor-transfer-side squad-advisor-out">
          <span className="squad-advisor-transfer-label">OUT</span>
          <span className="squad-advisor-transfer-name">{move.out.name}</span>
        </div>
        <span className="squad-advisor-transfer-arrow" aria-hidden="true">&rarr;</span>
        <div className="squad-advisor-transfer-side squad-advisor-in">
          <span className="squad-advisor-transfer-label">IN</span>
          <span className="squad-advisor-transfer-name">{move.in.name}</span>
        </div>
      </div>
    );
  }
  return <p className="squad-advisor-transfer-name">{move.name}</p>;
}

// Everything but the transfer move is still hand-written MOCK_ADVISOR content --
// tagged `preview: true` so the card header can flag it honestly now that the transfer
// card next to it is real (buildTransferMove below). Filters the mock transfer entry
// back out since a real one takes its place as moves[0] once fetched/loaded.
//
// `usedChips` (real data, from the /manager-squad/advisor response's `used_chips`)
// overrides the Chip Watch row specifically -- added after direct feedback that the
// mock content is identical for every manager, and a concrete case where that's
// actively wrong, not just generic: a manager who's already played Bench Boost this
// season would otherwise see it "recommended" again, which isn't illustrative, it's
// impossible (FPL doesn't let you replay a used chip). Captain Pick and Differential
// Pick stay fully generic -- there's no equally cheap, equally certain check for those
// (whether a captain suggestion is "wrong" depends on projections, not a fact already
// on record the way chip usage is).
function mockPreviewMoves(usedChips = []) {
  return MOCK_ADVISOR.moves
    .filter((m) => m.kind !== 'transfer')
    .map((m) => {
      if (m.kind === 'chip' && usedChips.includes(m.chipKey)) {
        return {
          ...m,
          preview: true,
          teaser: 'Already used',
          reason: `You've already played ${m.name} this season, so this specific suggestion no longer applies. Picking the best of your remaining chips isn't wired up yet -- for now this card only checks whether the illustrative pick above is still available to you.`
        };
      }
      return { ...m, preview: true };
    });
}

// The dev-only /__advisor-preview page (isMockPreview) has no real entryId to query --
// falls back to MOCK_ADVISOR's own placeholder transfer instead of fetching, so that
// page still has a transfer card to review.
function mockTransferMove() {
  const mock = MOCK_ADVISOR.moves.find((m) => m.kind === 'transfer');
  return { ...mock, preview: true };
}

// FPL's own single-letter availability codes don't appear here -- getSquadAdvisor's
// `transfer.reason` is one of a small fixed set ('no_data' | 'season_not_started' |
// 'no_affordable_upgrade') rather than free text, so this can give each one an honest,
// specific explanation instead of a generic "couldn't suggest anything".
function transferUnavailableReason(transfer) {
  if (transfer.reason === 'season_not_started') {
    return "The season hasn't started yet -- check back once the Gameweek 1 deadline passes.";
  }
  if (transfer.reason === 'no_affordable_upgrade') {
    return transfer.out
      ? `${transfer.out.name} looks like the weakest link in your squad right now, but no affordable upgrade was found within your current budget.`
      : 'No affordable upgrade was found within your current budget.';
  }
  return "We don't have enough picks data yet to suggest a transfer.";
}

// Short label shown on the collapsed row when there's no real delta to show (loading,
// or a found:false response) -- keeps the row scannable even before it's expanded.
function transferUnavailableTeaser(transfer) {
  if (!transfer) return 'No data yet';
  if (transfer.reason === 'no_affordable_upgrade') return 'No upgrade in budget';
  return 'No data yet';
}

// Builds the Squad Change row from a real /manager-squad/advisor response. `found:
// false` isn't an error -- it's a legitimate "nothing to suggest right now" answer --
// so it renders as its own explanatory row (AdvisorMoveBody's noSuggestion case)
// rather than being treated as a fetch failure.
function buildTransferMove(transfer) {
  if (!transfer || !transfer.found) {
    return {
      kind: 'transfer',
      title: 'Squad Change',
      teaser: transferUnavailableTeaser(transfer),
      delta: null,
      noSuggestion: true,
      reason: transferUnavailableReason(transfer || {})
    };
  }
  const sign = transfer.delta_pts > 0 ? '+' : '';
  const delta = `${sign}${transfer.delta_pts} pts`;
  return {
    kind: 'transfer',
    title: 'Squad Change',
    teaser: delta,
    delta,
    out: { name: transfer.out.name },
    in: { name: transfer.in.name },
    reason: transfer.reason
  };
}

// Redesigned 2026-08-24 per direct feedback that the original one-card-at-a-time
// pager ("Move 1 of 3", prev/next, dots) wasn't intuitive. Now a short, scannable list
// of 4 rows -- Squad Change, Captain Pick, Chip Watch, Differential Pick -- collapsed
// by default (icon + title + one-line teaser only), each expanding IN PLACE on click
// to reveal the full detail (OUT/IN or name, plus the reason) rather than opening a
// separate view. Only one row expands at a time (an accordion, not independent
// toggles) -- keeps the modal from growing tall with everything open at once, and
// matches "grab your attention, click each to get more info" -- one focus at a time.
//
// Squad Change is real (GH #44's first non-mock piece, fetched live from
// getSquadAdvisor); Captain Pick/Chip Watch/Differential Pick are still
// MOCK_ADVISOR's hand-written content, each tagged `preview: true` in its row.
function AdvisorModal({ onClose, entryId, gw, isMockPreview }) {
  const [expanded, setExpanded] = useState(null);
  const [transferMove, setTransferMove] = useState(isMockPreview ? mockTransferMove() : null);
  const [transferError, setTransferError] = useState(false);
  // Chips this manager has actually played this season -- real data (used_chips on the
  // getSquadAdvisor response), used only to keep the still-mock Chip Watch row from
  // recommending something provably already spent. Defaults to none-used, matching
  // both the dev preview page (no real entryId to check) and the loading window before
  // the real response arrives -- worst case it briefly shows the same default content
  // it always used to, never a false "already used" claim.
  const [usedChips, setUsedChips] = useState([]);

  useEffect(() => {
    if (isMockPreview) return;
    getSquadAdvisor(entryId, gw)
      .then((data) => {
        setTransferMove(buildTransferMove(data.transfer));
        setUsedChips(data.used_chips || []);
      })
      .catch((err) => {
        console.error('getSquadAdvisor failed:', err.message);
        setTransferError(true);
      });
  }, [entryId, gw, isMockPreview]);

  const resolvedTransferMove = transferError
    ? { kind: 'transfer', title: 'Squad Change', teaser: "Couldn't load", delta: null, noSuggestion: true, reason: "Couldn't load a transfer suggestion right now. Try again in a moment." }
    : (transferMove || { kind: 'transfer', title: 'Squad Change', teaser: 'Loading…', delta: null, loading: true });

  const moves = [resolvedTransferMove, ...mockPreviewMoves(usedChips)];

  return (
    <div className="squad-help-overlay" onClick={onClose}>
      <div className="squad-help-modal squad-advisor-modal" onClick={(e) => e.stopPropagation()}>
        <div className="squad-help-modal-header">
          <h4>
            <span className="squad-advisor-modal-icon"><SparkleIcon size={18} /></span>
            Squad Advisor
          </h4>
          <button type="button" className="squad-close-btn" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        {/* No modal-wide "preview" subtitle here -- dropped per direct feedback that
            it was redundant once every still-mock row already carries its own
            "PREVIEW" tag (see rowIcon/mockPreviewMoves above). Saying it twice added
            clutter, not clarity. */}

        <div className="squad-advisor-list">
          {moves.map((move) => {
            const isOpen = expanded === move.kind;
            return (
              <div key={move.kind} className={`squad-advisor-row-wrap ${isOpen ? 'open' : ''}`}>
                <button
                  type="button"
                  className="squad-advisor-row"
                  onClick={() => setExpanded(isOpen ? null : move.kind)}
                  aria-expanded={isOpen}
                >
                  <span className="squad-advisor-row-icon" aria-hidden="true">{rowIcon(move)}</span>
                  <span className="squad-advisor-row-title">
                    {move.title}
                    {move.preview && <span className="squad-advisor-row-preview-tag">Preview</span>}
                  </span>
                  <span className="squad-advisor-row-teaser">{move.teaser}</span>
                  <span className="squad-advisor-row-chevron" aria-hidden="true">{isOpen ? '−' : '+'}</span>
                </button>

                {isOpen && (
                  <div className="squad-advisor-row-detail">
                    <AdvisorMoveBody move={move} />
                    {move.reason && <p className="squad-advisor-reason">{move.reason}</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PositionRow({ players, onOpenFixture, onOpenAvailability }) {
  if (players.length === 0) return null;
  return (
    <div className="squad-position-row">
      {players.map((p) => (
        <PlayerCard key={p.player_id} player={p} onOpenFixture={onOpenFixture} onOpenAvailability={onOpenAvailability} />
      ))}
    </div>
  );
}

// The "?" button's popup -- one large, fixed-size example card built from the SAME
// jersey/points/fixture classes the real card uses (not the responsive
// .squad-player-card sizing, so its numbered callouts can use hardcoded pixel
// positions that stay correct at exactly one size, without tracking three
// breakpoints). Rebuilt to actually look like a real jersey card -- this used to be a
// leftover plain-white-card-plus-floating-crest mock from before the jersey redesign,
// which had drifted out of sync with what the app actually shows. Shows a captain
// badge and a hot-form badge at once purely for illustration -- a real card only ever
// shows one badge per corner -- since the legend still has to explain everything each
// corner can show: captain, vice-captain, hot form, or cold form.
function PlayerCardHelpModal({ onClose }) {
  const colors = KIT_COLORS.ARS;
  return (
    <div className="squad-help-overlay" onClick={onClose}>
      <div className="squad-help-modal" onClick={(e) => e.stopPropagation()}>
        <div className="squad-help-modal-header">
          <h4>How to read a player card</h4>
          <button type="button" className="squad-close-btn" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div className="squad-help-modal-body">
          <div className="squad-help-pitch">
            <div className="squad-help-example-card">
              <div className="squad-jersey-shirt squad-help-example-shirt">
                <div className="squad-corner-badge squad-corner-left">C</div>
                <span className="squad-help-dot squad-help-dot-cap">6</span>

                <div className="squad-corner-badge squad-corner-right squad-hot-badge">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 17a2.5 2.5 0 0 0 2.5-2.5c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5" /></svg>
                </div>
                <span className="squad-help-dot squad-help-dot-form">7</span>

                <svg className="squad-jersey-svg" viewBox="0 0 100 52" aria-hidden="true">
                  <path d={JERSEY_PATH} fill={colors.primary} stroke={colors.trim} strokeWidth="2.5" />
                  <path d={JERSEY_COLLAR_PATH} fill={colors.trim} />
                </svg>

                <div className="squad-jersey-crest squad-help-example-crest">
                  <ClubBadge crestUrl="/badges/t3.png" code="ARS" />
                </div>
                <span className="squad-help-dot squad-help-dot-crest">1</span>
              </div>

              {/* Points and this gameweek's own fixture, side by side -- matches the
                  real card exactly, right down to reusing .squad-points-row so this
                  never silently drifts out of sync with it again. */}
              <div className="squad-points-row squad-help-example-points-row">
                <div className="squad-points-bar">
                  <span className="squad-points-bar-num">8</span>
                  <span className="squad-points-bar-label">PTS</span>
                </div>
                <div className="squad-fixture-pill squad-fixture-easy">BOU</div>
              </div>
              <span className="squad-help-dot squad-help-dot-points">3</span>
              <span className="squad-help-dot squad-help-dot-current">4</span>

              <div className="squad-jersey-info squad-help-example-info">
                <p className="squad-player-name">Player Name<span className="squad-position-letter">{'‑'}F</span></p>
                <div className="squad-fixture-list">
                  <div className="squad-fixture-pill squad-fixture-easy">BOU</div>
                  <div className="squad-fixture-pill squad-fixture-hard squad-fixture-away">TOT</div>
                </div>
              </div>
              <span className="squad-help-dot squad-help-dot-name">2</span>
              <span className="squad-help-dot squad-help-dot-fixtures">5</span>
            </div>
          </div>

          <ol className="squad-help-modal-list">
            <li><span className="squad-help-dot">1</span> Team badge, on the shirt &mdash; the player's own club</li>
            <li><span className="squad-help-dot">2</span> Player name &ndash; position (G, D, M, or F)</li>
            <li><span className="squad-help-dot">3</span> Points scored this gameweek</li>
            <li><span className="squad-help-dot">4</span> This gameweek's fixture &mdash; tap it for kickoff time, difficulty, and opponent form</li>
            <li><span className="squad-help-dot">5</span> Next two fixtures &mdash; green / gray / red for easy / medium / hard difficulty, underlined for an away game, and tappable just like the current one</li>
            <li><span className="squad-help-dot">6</span> Left corner &mdash; captain (C) or vice-captain (V)</li>
            <li><span className="squad-help-dot">7</span> Right corner &mdash; hot or cold form</li>
          </ol>
        </div>
      </div>
    </div>
  );
}

// The popup opened by tapping any of the 3 fixture pills on a player card (current
// gameweek's, next two upcoming). Built from what the backend now supplies per pill
// (see manager-squad.mjs's fixturesForPlayer): kickoff time, difficulty, and an
// opponent object with league position/points, recent form, and venue-correct
// attack/defence strength. Follows the same overlay/centered-card convention as the
// "?" help modal above rather than inventing a new one.
function FixtureDetailModal({ fixture, player, onClose }) {
  if (!fixture) return null;
  const opp = fixture.opponent;

  // Converted client-side from the UTC kickoff_time FPL stores into whoever is
  // actually looking at this popup's OWN local time -- per direct feedback ("would be
  // good to have this local time to the user seeing this"), rather than a fixed UK
  // kickoff time that reads wrong for anyone elsewhere.
  const kickoff = fixture.kickoff_time ? new Date(fixture.kickoff_time) : null;
  const kickoffLabel = kickoff && !Number.isNaN(kickoff.getTime())
    ? kickoff.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    })
    : null;

  const diffTier = difficultyTier(fixture.difficulty);
  const diffLabel = diffTier === 'easy' ? 'Easy' : diffTier === 'hard' ? 'Hard' : 'Medium';

  // Which of the opponent's two strength numbers actually matters depends on what
  // THIS player does, not the opponent's -- a defender (or keeper) cares how
  // dangerous the opponent's attack is; a midfielder or forward cares how solid the
  // opponent's defence is. The venue side (home vs away strength) is already
  // resolved server-side against this exact fixture.
  const usesAttack = player.position === 'GKP' || player.position === 'DEF';
  const strengthValue = opp ? (usesAttack ? opp.strength_attack : opp.strength_defence) : null;
  const strengthTag = usesAttack ? "Opponent's attack" : "Opponent's defence";

  return (
    <div className="squad-help-overlay" onClick={onClose}>
      <div className="squad-fixture-modal" onClick={(e) => e.stopPropagation()}>
        <div className="squad-help-modal-header">
          <h4>Gameweek {fixture.gw} fixture</h4>
          <button type="button" className="squad-close-btn" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div className="squad-fixture-modal-teams">
          <div className="squad-fixture-modal-team">
            <ClubBadge crestUrl={player.team_crest} code={player.team_code} />
            <span>{player.team_code}</span>
          </div>
          <span className="squad-fixture-modal-vs">{fixture.is_home ? 'vs' : '@'}</span>
          <div className="squad-fixture-modal-team">
            <ClubBadge crestUrl={opp?.crest} code={fixture.opponent_code} />
            <span>{fixture.opponent_code}</span>
          </div>
        </div>

        <p className="squad-fixture-modal-venue">
          {fixture.is_home ? 'Home' : 'Away'}
          {kickoffLabel ? ` · ${kickoffLabel} (your local time)` : ''}
        </p>

        {fixture.status === 'FINISHED' && (
          <p className="squad-fixture-modal-final">
            Final score: {fixture.team_h_score}&ndash;{fixture.team_a_score}
          </p>
        )}

        <div className="squad-fixture-modal-row">
          <span className={`squad-fixture-modal-dot squad-fixture-${diffTier}`} aria-hidden="true" />
          <span>{diffLabel} difficulty ({fixture.difficulty}/5)</span>
        </div>

        {opp && (
          <>
            <div className="squad-fixture-modal-divider" />

            {typeof opp.position === 'number' && (
              <div className="squad-fixture-modal-row">
                <span className="squad-fixture-modal-label">League position</span>
                <span>{ordinal(opp.position)}{typeof opp.points === 'number' ? ` · ${opp.points} pts` : ''}</span>
              </div>
            )}

            {opp.form && opp.form.length > 0 && (
              <div className="squad-fixture-modal-form">
                <span className="squad-fixture-modal-label">Form (oldest &rarr; most recent)</span>
                <div className="squad-fixture-modal-form-dots">
                  {opp.form.map((r, i) => (
                    <span
                      key={i}
                      className={`squad-form-dot squad-form-dot-${r.toLowerCase()}${i === opp.form.length - 1 ? ' squad-form-dot-recent' : ''}`}
                      title={FORM_RESULT_LABEL[r] || r}
                    >
                      {r}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {strengthValue !== null && strengthValue !== undefined && (
              <div className="squad-fixture-modal-row">
                <span className="squad-fixture-modal-label">{strengthTag}</span>
                <span>{strengthLabel(strengthValue)}</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Opened by tapping a doubtful/injured/suspended player's name (see PlayerCard --
// only rendered as a clickable button in the first place when availabilityTier finds
// something to flag). Follows the same overlay/card convention as the other two
// modals on this page.
function AvailabilityDetailModal({ player, onClose }) {
  const tier = availabilityTier(player.availability_status);
  const statusLabel = AVAILABILITY_STATUS_LABEL[player.availability_status] || 'Doubtful';

  // FPL stops updating chance_of_playing_this_round once that gameweek's deadline has
  // passed, so it's commonly null well before "next round" also goes null -- shown
  // separately (not folded into one combined line) so whichever one FPL still has an
  // opinion on is never hidden by the other already being blank.
  const hasThisRound = typeof player.chance_of_playing_this_round === 'number';
  const hasNextRound = typeof player.chance_of_playing_next_round === 'number';

  return (
    <div className="squad-help-overlay" onClick={onClose}>
      <div className="squad-fixture-modal" onClick={(e) => e.stopPropagation()}>
        <div className="squad-help-modal-header">
          <h4>{player.name}</h4>
          <button type="button" className="squad-close-btn" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div className="squad-fixture-modal-row" style={{ paddingTop: 0 }}>
          <span className={`squad-availability-pill squad-availability-${tier}`}>{statusLabel}</span>
        </div>

        {player.news && (
          <div className="squad-fixture-modal-form">
            <span className="squad-fixture-modal-label">Team news</span>
            <p className="squad-availability-news">{player.news}</p>
          </div>
        )}

        {(hasThisRound || hasNextRound) && <div className="squad-fixture-modal-divider" />}

        {hasThisRound && (
          <div className="squad-fixture-modal-row">
            <span className="squad-fixture-modal-label">This gameweek</span>
            <span>{player.chance_of_playing_this_round}%</span>
          </div>
        )}

        {hasNextRound && (
          <div className="squad-fixture-modal-row">
            <span className="squad-fixture-modal-label">Next gameweek</span>
            <span>{player.chance_of_playing_next_round}%</span>
          </div>
        )}
      </div>
    </div>
  );
}

// mockSquad: bypasses the real /manager-squad fetch entirely and renders this data
// instead -- used only by pages/AdvisorPreview.jsx, a dev-only route for reviewing the
// GH #44 Advisor mock (see MOCK_ADVISOR above) without depending on real, live picks
// data. Nothing else should ever pass this prop.
export default function ManagerSquad({ entryId, teamName, managerName, onClose, mockSquad = null }) {
  const [squad, setSquad] = useState(mockSquad);
  const [loading, setLoading] = useState(!mockSquad);
  const [error, setError] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  // Which fixture-detail popup (if any) is open -- { player, fixture } together, since
  // the popup needs both the fixture itself and the viewed player's own team/position
  // (to pick attack vs defence strength, and to show the player's own crest).
  const [activeFixture, setActiveFixture] = useState(null);
  const openFixture = (player, fixture) => setActiveFixture({ player, fixture });
  // Which player's availability popup (if any) is open -- just the player itself,
  // unlike activeFixture, since availability isn't tied to a specific fixture pill.
  const [activeAvailability, setActiveAvailability] = useState(null);
  const openAvailability = (player) => setActiveAvailability(player);
  const [showAdvisor, setShowAdvisor] = useState(false);

  useEffect(() => {
    if (mockSquad) return;
    setLoading(true);
    setError(false);
    getManagerSquad(entryId)
      .then((data) => setSquad(data))
      .catch((err) => {
        console.error('getManagerSquad failed:', err.message);
        setError(true);
      })
      .finally(() => setLoading(false));
  }, [entryId, mockSquad]);

  const starters = (squad?.players || []).filter((p) => !p.is_bench);
  const bench = (squad?.players || []).filter((p) => p.is_bench);

  return (
    <div className="squad-page">
      {/* Re-added per direct design feedback -- the Standings nav tab re-click
          technically does the same thing, but with no on-screen affordance most
          people didn't realize this view could be backed out of at all. */}
      <button type="button" className="squad-back-btn" onClick={onClose}>
        <span aria-hidden="true">&larr;</span> Back to standings
      </button>

      {loading && <p className="squad-loading">Loading squad...</p>}

      {!loading && error && (
        <p className="squad-loading">Couldn't load this squad right now. Try again in a moment.</p>
      )}

      {!loading && !error && squad && squad.players.length > 0 && (
        <div className="squad-pitch">
          {/* Three-column grid row: left column (help icon + Advisor sparkle, side by
              side) and right column (team/manager name, truncates per direct feedback --
              "truncate name if needed") are equal-width (minmax(0, 1fr) each), so the
              points badge in the middle column sits mathematically centered in the row
              regardless of how long the name is, instead of just being "next to" the
              name. The chip is shown once (in the badge's own bar below the number) --
              no separate tag next to the name. */}
          <div className="squad-legend">
            <div className="squad-legend-left">
              <button
                type="button"
                className="squad-help-btn"
                onClick={() => setShowHelp(true)}
                aria-haspopup="dialog"
                aria-label="How to read a player card"
                title="How to read a player card"
              >
                ?
              </button>

              {/* Always-pulsing "AI" entry point -- moved next to the help icon per
                  direct feedback (was previously floating, absolutely centered over
                  the whole row). See MOCK_ADVISOR above: the transfer move in this
                  modal is real (GH #44, tasks #196-202); captain/fixture-run are still
                  hand-written preview content. */}
              <button
                type="button"
                className="squad-advisor-btn"
                onClick={() => setShowAdvisor(true)}
                aria-haspopup="dialog"
                aria-label="Get suggested moves to improve this squad"
                title="Get suggested moves to improve this squad"
              >
                <span className="squad-advisor-btn-ring" aria-hidden="true" />
                <span className="squad-advisor-btn-ring squad-advisor-btn-ring-delay" aria-hidden="true" />
                <SparkleIcon size={14} />
              </button>
            </div>

            {typeof squad.team_gw_points_net === 'number' && (
              <div className="squad-points-badge-wrap">
                <div className="squad-points-badge">
                  <div className="squad-points-badge-num">{squad.team_gw_points_net}</div>
                  {squad.active_chip && CHIP_CODES[squad.active_chip] && (
                    <div className="squad-points-badge-chip" title={CHIP_NAMES[squad.active_chip]}>
                      {CHIP_CODES[squad.active_chip]}
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="squad-legend-right">
              <div className="squad-legend-identity">
                <p className="squad-legend-team" title={teamName}>{teamName}</p>
                {managerName && (
                  <p className="squad-legend-manager">
                    <span className="squad-legend-manager-text" title={managerName}>
                      {managerName}
                    </span>
                  </p>
                )}
              </div>
            </div>
          </div>

          {POSITION_ORDER.map((pos) => (
            <PositionRow
              key={pos}
              players={starters.filter((p) => p.position === pos)}
              onOpenFixture={openFixture}
              onOpenAvailability={openAvailability}
            />
          ))}

          {bench.length > 0 && (
            <div className="squad-bench-section">
              <p className="squad-bench-label">Subs</p>
              <PositionRow players={bench} onOpenFixture={openFixture} onOpenAvailability={openAvailability} />
            </div>
          )}
        </div>
      )}

      {!loading && !error && (!squad || squad.players.length === 0) && (
        <p className="squad-loading">
          {squad?.reason === 'season_not_started'
            ? "The season hasn't started yet -- squads unlock once the Gameweek 1 deadline passes."
            : 'No squad data available for this manager yet.'}
        </p>
      )}

      {showHelp && <PlayerCardHelpModal onClose={() => setShowHelp(false)} />}

      {activeFixture && (
        <FixtureDetailModal
          fixture={activeFixture.fixture}
          player={activeFixture.player}
          onClose={() => setActiveFixture(null)}
        />
      )}

      {activeAvailability && (
        <AvailabilityDetailModal
          player={activeAvailability}
          onClose={() => setActiveAvailability(null)}
        />
      )}

      {showAdvisor && (
        <AdvisorModal
          onClose={() => setShowAdvisor(false)}
          entryId={entryId}
          gw={squad?.gameweek}
          isMockPreview={!!mockSquad}
        />
      )}
    </div>
  );
}
