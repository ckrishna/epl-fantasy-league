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
import { getManagerSquad } from '../api/client';
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

export default function ManagerSquad({ entryId, teamName, managerName, onClose }) {
  const [squad, setSquad] = useState(null);
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    setLoading(true);
    setError(false);
    getManagerSquad(entryId)
      .then((data) => setSquad(data))
      .catch((err) => {
        console.error('getManagerSquad failed:', err.message);
        setError(true);
      })
      .finally(() => setLoading(false));
  }, [entryId]);

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
          {/* Three-column grid row: left column (help icon + team/manager name, which
              truncates per direct feedback -- "truncate name if needed") and right
              column (reserved Advisor slot) are equal-width (minmax(0, 1fr) each), so
              the points badge in the middle column sits mathematically centered in the
              row regardless of how long the name is, instead of just being "next to"
              the name. The chip is shown once (in the badge's own bar below the
              number) -- no separate tag next to the name. */}
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

            {/* Empty on purpose -- reserves the right side of this row for the
                center/right Advisor icon (a separate, not-yet-merged feature branch),
                per direct instruction to leave this space alone. */}
            <div className="squad-legend-advisor-slot" aria-hidden="true" />
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
    </div>
  );
}
