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
  WOL: { primary: '#FDB913', trim: '#231F20' }
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

// Shortened to 2 letters (from FPL's usual 3-letter club code) so both fixture pills
// fit on one row per direct feedback -- every club's own 3-letter code already has a
// unique first-2-letter prefix across the current 20-team league (ARS/AVL/BOU/BRE/
// BHA/BUR/CHE/CRY/EVE/FUL/LEE/LIV/MCI/MUN/NEW/NFO/SUN/TOT/WHU/WOL all differ by their
// second letter), so a plain slice needs no separate lookup table and stays correct as
// long as that holds -- if a future promoted club ever collides on its first 2 letters
// with an existing one, this would need a real disambiguation table instead.
function FixturePill({ fixture }) {
  if (!fixture) return null;
  const label = `${fixture.opponent_code.slice(0, 2)}${fixture.is_home ? 'H' : 'A'}`;
  return <div className={`squad-fixture-pill squad-fixture-${difficultyTier(fixture.difficulty)}`}>{label}</div>;
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
function JerseyBadge({ player }) {
  const colors = KIT_COLORS[player.team_code] || DEFAULT_KIT;
  // Unique per card (not just per club) since multiple copies of the same club's
  // jersey render on one page at once -- SVG clipPath ids must be unique in the DOM,
  // and two players sharing a club would otherwise silently clip against whichever
  // <defs> happened to render last.
  const clipId = `jersey-clip-${player.player_id}`;
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

      {typeof player.gw_points === 'number' && (
        <div className="squad-points-bar">
          <span className="squad-points-bar-num">{player.gw_points}</span>
          <span className="squad-points-bar-label">PTS</span>
        </div>
      )}
    </div>
  );
}

function PlayerCard({ player }) {
  return (
    <div className="squad-player-card">
      <JerseyBadge player={player} />
      <div className="squad-jersey-info">
        {/* Names are truncated to one line (CSS text-overflow: ellipsis on
            .squad-player-name) rather than wrapping -- per direct feedback, a long
            name wrapping to 2 lines made that one card taller than its row
            neighbors. title carries the full name for anyone who wants it via hover.
            A plain "-" is also a valid CSS line-break point, which used to split e.g.
            "Tarkowski-D" with the "D" stranded alone before truncation replaced
            wrapping entirely -- the non-breaking hyphen (U+2011) below is left in
            place since it's harmless and keeps the name+letter glued together in the
            one line that's still shown. */}
        <div className="squad-name-wrap">
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
        </div>
        <div className="squad-fixture-list">
          {player.fixtures.map((f, i) => <FixturePill key={i} fixture={f} />)}
        </div>
      </div>
    </div>
  );
}

function PositionRow({ players }) {
  if (players.length === 0) return null;
  return (
    <div className="squad-position-row">
      {players.map((p) => <PlayerCard key={p.player_id} player={p} />)}
    </div>
  );
}

// The "?" button's popup -- one large, fixed-size example card (deliberately NOT built
// from the real .squad-player-card responsive classes, so its six numbered callouts
// can use hardcoded pixel positions that stay correct at exactly one size, instead of
// needing to track three breakpoints). Shows a captain badge and a hot-form badge at
// once purely for illustration -- a real card only ever shows one badge per corner --
// since the legend still has to explain everything each corner can show: captain,
// vice-captain, hot form, or cold form.
function PlayerCardHelpModal({ onClose }) {
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
              <div className="squad-club-badge squad-help-example-crest">
                <img src="/badges/t3.png" alt="ARS" />
              </div>
              <span className="squad-help-dot squad-help-dot-1">1</span>

              <span className="squad-cap-badge squad-help-example-cap">C</span>
              <span className="squad-help-dot squad-help-dot-5">5</span>

              <span className="squad-form-badge squad-hot-badge squad-help-example-hot">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 17a2.5 2.5 0 0 0 2.5-2.5c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5" /></svg>
              </span>
              <span className="squad-help-dot squad-help-dot-6">6</span>

              <div className="squad-help-example-row">
                <span className="squad-help-dot">2</span>
                <p className="squad-help-example-name">Player Name<span className="squad-position-letter">{'‑'}F</span></p>
              </div>

              <div className="squad-help-example-row">
                <span className="squad-help-dot">3</span>
                <div className="squad-points-chip squad-help-example-points">8 pts</div>
              </div>

              <div className="squad-help-example-row">
                <span className="squad-help-dot">4</span>
                <div className="squad-help-example-fixtures">
                  <div className="squad-fixture-pill squad-fixture-easy">BOU-H</div>
                  <div className="squad-fixture-pill squad-fixture-hard">TOT-A</div>
                </div>
              </div>
            </div>
          </div>

          <ol className="squad-help-modal-list">
            <li><span className="squad-help-dot">1</span> Team badge &mdash; the player's own club</li>
            <li><span className="squad-help-dot">2</span> Player name &ndash; position (G, D, M, or F)</li>
            <li><span className="squad-help-dot">3</span> Points scored this gameweek</li>
            <li><span className="squad-help-dot">4</span> Next two fixtures &mdash; green / gray / red for easy / medium / hard difficulty, with H or A for home or away</li>
            <li><span className="squad-help-dot">5</span> Left corner &mdash; captain (C) or vice-captain (V)</li>
            <li><span className="squad-help-dot">6</span> Right corner &mdash; hot or cold form</li>
          </ol>
        </div>
      </div>
    </div>
  );
}

export default function ManagerSquad({ entryId, teamName, managerName, onClose }) {
  const [squad, setSquad] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

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
            <PositionRow key={pos} players={starters.filter((p) => p.position === pos)} />
          ))}

          {bench.length > 0 && (
            <div className="squad-bench-section">
              <p className="squad-bench-label">Subs</p>
              <PositionRow players={bench} />
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
    </div>
  );
}
