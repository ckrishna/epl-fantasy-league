// src/pages/Trends.jsx
import { useEffect, useMemo, useState } from 'react';
import {
  ComposedChart, Area, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import { getTrendsManagers, getTrends } from '../api/client';
import '../styles/Trends.css';

const MANAGER_STORAGE_KEY = 'trends_manager';

// Mobile shows one section at a time via these sub-tabs (avoids a long scroll on a
// small screen); desktop ignores this entirely and shows both side by side in a grid --
// see the `@media (min-width: 769px)` override in Trends.css.
//
const SECTIONS = [
  { id: 'field', label: 'Vs field' },
  { id: 'pace', label: 'Pace' },
  { id: 'seasons', label: 'Seasons' }
];

function ordinal(n) {
  if (n == null) return '—';
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

// Merges this-season points and the historical average/min/max envelope into one
// gameweek-indexed array Recharts can plot as a single chart. `range` is a [min, max]
// pair -- Recharts' Area renders that shape as a filled band, not a line.
function buildPaceChartData(pace) {
  if (!pace) return [];
  const envelopeByGw = new Map((pace.history_envelope || []).map((e) => [e.gameweek, e]));
  const thisByGw = new Map((pace.this_season || []).map((p) => [p.gameweek, p.points]));
  const allGws = [...new Set([...envelopeByGw.keys(), ...thisByGw.keys()])].sort((a, b) => a - b);

  return allGws.map((gw) => {
    const env = envelopeByGw.get(gw);
    return {
      gameweek: gw,
      this_season: thisByGw.has(gw) ? thisByGw.get(gw) : null,
      avg: env ? env.avg : null,
      range: env ? [env.min, env.max] : null
    };
  });
}

// One row per gameweek, one column per manager (m0, m1, ...) -- the shape a single
// Recharts chart needs to plot every manager's line at once. Column index matches the
// manager's index in the `field` array, kept consistent between this and the <Line>
// elements themselves.
function buildFieldChartData(field) {
  if (!field || field.length === 0) return [];
  const allGws = [...new Set(field.flatMap((m) => m.points.map((p) => p.gameweek)))].sort((a, b) => a - b);
  return allGws.map((gw) => {
    const row = { gameweek: gw };
    field.forEach((m, idx) => {
      const point = m.points.find((p) => p.gameweek === gw);
      row[`m${idx}`] = point ? point.points : null;
    });
    return row;
  });
}

// Paints muted "everyone else" lines first, the leader next, and "you" last, so your
// own line is never hidden underneath the rest of the field.
function fieldLinePriority(m) {
  if (m.is_you) return 2;
  if (m.is_leader) return 1;
  return 0;
}

const tooltipStyle = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--text-primary)'
};

// Recharts colors each tooltip line using that series' own stroke/fill by default,
// regardless of contentStyle above -- contentStyle only sets the wrapper/label color.
// The "Historical range" Area's fill (a muted --gray-200) was rendering as
// near-invisible dark-on-dark text against the tooltip's own dark background in dark
// mode. itemStyle forces every line to the same readable color instead.
const tooltipItemStyle = { color: 'var(--text-primary)' };

const axisTick = { fontSize: 11, fill: 'var(--text-muted)' };

export default function Trends() {
  const [managers, setManagers] = useState([]);
  const [managersLoading, setManagersLoading] = useState(true);
  const [selected, setSelected] = useState(() => localStorage.getItem(MANAGER_STORAGE_KEY) || '');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [activeSection, setActiveSection] = useState('field');

  useEffect(() => {
    getTrendsManagers().then((list) => {
      setManagers(list);
      setManagersLoading(false);
      setSelected((prev) => {
        if (prev && list.some((m) => m.team_name === prev)) return prev;
        return list[0]?.team_name || '';
      });
    });
  }, []);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    setError(null);
    localStorage.setItem(MANAGER_STORAGE_KEY, selected);
    getTrends(selected).then((result) => {
      if (!result) {
        setError('Could not load trends for this manager.');
        setData(null);
      } else {
        setData(result);
      }
      setLoading(false);
    });
  }, [selected]);

  const paceChartData = useMemo(() => buildPaceChartData(data?.pace), [data]);

  const fieldChartData = useMemo(() => buildFieldChartData(data?.field), [data]);
  const fieldRenderOrder = useMemo(() => {
    if (!data?.field) return [];
    return data.field.map((m, idx) => idx).sort((a, b) => fieldLinePriority(data.field[a]) - fieldLinePriority(data.field[b]));
  }, [data]);

  const fieldSummary = useMemo(() => {
    if (!data?.field || data.field.length === 0 || !data.current_gameweek) return null;
    const withLatest = data.field
      .map((m) => ({ ...m, latest: m.points.find((p) => p.gameweek === data.current_gameweek)?.points ?? null }))
      .filter((m) => m.latest !== null)
      .sort((a, b) => b.latest - a.latest);
    const youIdx = withLatest.findIndex((m) => m.is_you);
    if (youIdx === -1) return null;
    const you = withLatest[youIdx];
    const rank = youIdx + 1;
    if (rank === 1) {
      return `GW${data.current_gameweek}: you're leading with ${you.latest} pts.`;
    }
    const leader = withLatest[0];
    const gap = leader.latest - you.latest;
    return `GW${data.current_gameweek}: you're ${ordinal(rank)}, ${gap} pt${gap === 1 ? '' : 's'} behind ${leader.manager_name || leader.team_name}.`;
  }, [data]);

  return (
    <div className="trends-page">
      <h2>Your trends</h2>
      <p className="scope-note">Always spans every season on record for the manager you pick below — the season selector above doesn't apply on this tab.</p>

      <div className="trends-manager-picker">
        <label htmlFor="trends-manager-select">Manager</label>
        <select
          id="trends-manager-select"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          disabled={managersLoading || managers.length === 0}
        >
          {managers.map((m) => (
            <option key={m.team_name} value={m.team_name}>
              {m.manager_name ? `${m.team_name} (${m.manager_name})` : m.team_name}
            </option>
          ))}
        </select>
      </div>

      {managersLoading && <div className="loading">Loading managers...</div>}
      {!managersLoading && managers.length === 0 && (
        <p className="no-data">No manager data available yet.</p>
      )}

      {loading && <div className="loading">Loading trends...</div>}
      {error && !loading && <p className="no-data">{error}</p>}

      {data && !loading && !error && (
        <>
          <div className="trends-subtabs">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`trends-subtab ${activeSection === s.id ? 'active' : ''}`}
                onClick={() => setActiveSection(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="trends-sections">
            <div className={`trends-section ${activeSection === 'field' ? 'active' : ''}`}>
              <div className="trends-card">
                <div className="trends-card-title">Vs the field</div>
                <div className="trends-card-subtitle">Cumulative points this season, everyone in the league</div>

                {fieldChartData.length === 0 ? (
                  <p className="no-data">No games played yet this season — check back once it kicks off.</p>
                ) : (
                  <>
                    <ResponsiveContainer width="100%" height={220}>
                      <ComposedChart data={fieldChartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                        <XAxis
                          dataKey="gameweek"
                          tickFormatter={(gw) => `GW${gw}`}
                          tick={axisTick}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis tick={axisTick} axisLine={false} tickLine={false} width={40} />
                        <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} labelFormatter={(gw) => `Gameweek ${gw}`} />
                        {fieldRenderOrder.map((idx) => {
                          const m = data.field[idx];
                          const highlighted = m.is_you || m.is_leader;
                          const stroke = m.is_you ? 'var(--accent)' : m.is_leader ? 'var(--primary)' : 'var(--gray-200)';
                          return (
                            <Line
                              key={idx}
                              type="monotone"
                              dataKey={`m${idx}`}
                              stroke={stroke}
                              strokeWidth={highlighted ? 2.5 : 1.5}
                              dot={false}
                              isAnimationActive={false}
                              connectNulls
                            />
                          );
                        })}
                      </ComposedChart>
                    </ResponsiveContainer>

                    <div className="trends-legend">
                      <span><i className="trends-legend-swatch solid" style={{ background: 'var(--accent)' }} /> You</span>
                      {data.field.some((m) => m.is_leader) && (
                        <span><i className="trends-legend-swatch solid" style={{ background: 'var(--primary)' }} /> Leader</span>
                      )}
                      <span><i className="trends-legend-swatch band" /> Everyone else</span>
                    </div>

                    {fieldSummary && <div className="trends-callout">{fieldSummary}</div>}
                  </>
                )}
              </div>
            </div>

            <div className={`trends-section ${activeSection === 'pace' ? 'active' : ''}`}>
              <div className="trends-card">
                <div className="trends-card-title">Pace vs your history</div>
                <div className="trends-card-subtitle">Cumulative points by gameweek, this season vs. your average</div>

                {paceChartData.length === 0 ? (
                  <p className="no-data">Not enough data yet to chart this.</p>
                ) : (
                  <>
                    <ResponsiveContainer width="100%" height={220}>
                      <ComposedChart data={paceChartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                        <XAxis
                          dataKey="gameweek"
                          tickFormatter={(gw) => `GW${gw}`}
                          tick={axisTick}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis tick={axisTick} axisLine={false} tickLine={false} width={40} />
                        <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} labelFormatter={(gw) => `Gameweek ${gw}`} />
                        <Area
                          dataKey="range"
                          name="Historical range"
                          stroke="none"
                          fill="var(--gray-200)"
                          fillOpacity={0.6}
                          isAnimationActive={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="avg"
                          name="Your average"
                          stroke="var(--text-tertiary)"
                          strokeWidth={2}
                          strokeDasharray="5 4"
                          dot={false}
                          isAnimationActive={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="this_season"
                          name="This season"
                          stroke="var(--accent)"
                          strokeWidth={2.5}
                          dot={false}
                          isAnimationActive={false}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>

                    <div className="trends-legend">
                      <span><i className="trends-legend-swatch solid" /> This season</span>
                      <span><i className="trends-legend-swatch dashed" /> Your average</span>
                      <span><i className="trends-legend-swatch band" /> Historical range</span>
                    </div>

                    {data.pace.at_current_gw && (
                      <div className="trends-callout">
                        GW{data.current_gameweek}: {data.pace.at_current_gw.this_season} pts —{' '}
                        {data.pace.at_current_gw.diff >= 0 ? (
                          <strong className="trends-positive">{data.pace.at_current_gw.diff} pts ahead</strong>
                        ) : (
                          <strong className="trends-negative">{Math.abs(data.pace.at_current_gw.diff)} pts behind</strong>
                        )}{' '}
                        of your average ({data.pace.at_current_gw.avg}) at this point.
                      </div>
                    )}
                    {!data.pace.at_current_gw && data.pace.this_season.length > 0 && (
                      <div className="trends-callout">
                        No prior-season data at GW{data.current_gameweek} yet to compare against.
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            <div className={`trends-section trends-section-wide ${activeSection === 'seasons' ? 'active' : ''}`}>
              <div className="trends-card">
                <div className="trends-card-title">Season by season</div>
                <div className="trends-card-subtitle">Total points, finish, and pace across every season on record</div>

                {(!data.seasons || data.seasons.length === 0) ? (
                  <p className="no-data">No season data available yet.</p>
                ) : (
                  <table className="trends-seasons-table">
                    <thead>
                      <tr>
                        <th>Season</th>
                        <th>Finish</th>
                        <th>Total pts</th>
                        <th>Avg/GW</th>
                        <th>Gap to 1st</th>
                        <th>Hits taken</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.seasons.map((s) => (
                        <tr key={s.season} className={s.is_current ? 'is-current' : ''}>
                          <td>
                            {s.season}
                            {s.is_current && <span className="trends-seasons-current-tag">Current</span>}
                          </td>
                          <td className={s.final_rank === 1 ? 'trends-seasons-won' : ''}>{ordinal(s.final_rank)}</td>
                          <td>{s.final_points ?? '—'}</td>
                          <td>{s.avg_points_per_gw ?? '—'}</td>
                          <td className={s.gap_to_first ? 'trends-negative' : s.gap_to_first === 0 ? 'trends-seasons-won' : ''}>
                            {s.gap_to_first === null ? '—' : s.gap_to_first === 0 ? '—' : `${s.gap_to_first} pts`}
                          </td>
                          <td className={s.total_transfer_cost > 0 ? 'trends-negative' : ''}>
                            {s.total_transfer_cost > 0 ? `-${s.total_transfer_cost}` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
