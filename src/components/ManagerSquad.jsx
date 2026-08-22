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

function difficultyTier(d) {
  if (d <= 2) return 'easy';
  if (d >= 4) return 'hard';
  return 'neutral';
}

function FixturePill({ fixture }) {
  if (!fixture) return null;
  const label = `${fixture.opponent_code}-${fixture.is_home ? 'H' : 'A'}`;
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

function PlayerCard({ player }) {
  return (
    <div className="squad-player-card">
      <ClubBadge crestUrl={player.team_crest} code={player.team_code} />
      {player.is_captain && <div className="squad-cap-badge">C</div>}
      {player.is_vice_captain && !player.is_captain && <div className="squad-cap-badge squad-vice-badge">V</div>}
      {player.form_tag === 'cold' && (
        <div className="squad-form-badge squad-cold-badge" aria-label="Cold form" title="Cold form">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 2v20M6 5l6 3.5L18 5M6 19l6-3.5L18 19M4 9l8 3-8 3M20 9l-8 3 8 3" />
          </svg>
        </div>
      )}
      {player.form_tag === 'hot' && (
        <div className="squad-form-badge squad-hot-badge" aria-label="Hot form" title="Hot form">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8.5 14.5A2.5 2.5 0 0 0 11 17a2.5 2.5 0 0 0 2.5-2.5c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5" />
          </svg>
        </div>
      )}
      {/* A plain "-" is a valid line-break point in CSS by default, which is exactly
          what was splitting e.g. "Tarkowski-D" across two lines with the D stranded
          alone. The non-breaking hyphen (U+2011) renders identically but isn't treated
          as a break opportunity, so the name and its position letter always wrap (or
          don't) together. The wrapping div reserves two lines' worth of height and
          centers whatever ends up in it, so 1-line and 2-line names still line up
          across a row instead of the shorter ones sitting higher. */}
      <div className="squad-name-wrap">
        <p className="squad-player-name">
          {player.name}<span className="squad-position-letter">{'‑'}{POSITION_LETTER[player.position] || '?'}</span>
        </p>
      </div>
      {typeof player.gw_points === 'number' && (
        <div className="squad-points-chip">{player.gw_points} pts</div>
      )}
      <div className="squad-fixture-list">
        {player.fixtures.map((f, i) => <FixturePill key={i} fixture={f} />)}
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
          <div className="squad-legend">
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
              <p className="squad-legend-team">{teamName}</p>
              {managerName && (
                <p className="squad-legend-manager">
                  <span className="squad-legend-manager-text">{managerName}</span>
                  {/* Chip played THIS gameweek, if any -- inline next to the team
                      nickname rather than a full-width banner, so the legend row still
                      has room for the "?" help icon plus a center advisor icon (a
                      separate, not-yet-merged feature -- this just leaves it space,
                      doesn't implement it). It changes how the whole squad should be
                      read (Bench Boost means the bench counts, Triple Captain means
                      the captain's tripled not doubled -- both already reflected in
                      the numbers above once active_chip is set), so it's still shown
                      up front, just compactly -- full name via the title tooltip. */}
                  {squad.active_chip && CHIP_CODES[squad.active_chip] && (
                    <span className="squad-chip-badge" title={CHIP_NAMES[squad.active_chip]}>
                      {CHIP_CODES[squad.active_chip]}
                    </span>
                  )}
                </p>
              )}
            </div>

            {typeof squad.team_gw_points_net === 'number' && (
              <div className="squad-legend-total">
                <span className="squad-legend-gw">GW{squad.gameweek}</span>
                <span className="squad-legend-net">
                  NET {squad.team_gw_points_net} pts
                  {squad.transfer_cost > 0 && (
                    <span className="squad-legend-hit"> (&minus;{squad.transfer_cost} hit)</span>
                  )}
                </span>
              </div>
            )}
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
