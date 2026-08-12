// src/pages/Trends.jsx
import { useEffect, useMemo, useState } from 'react';
import {
  ComposedChart, Area, Line, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import { getTrendsManagers, getTrends } from '../api/client';
import '../styles/Trends.css';

const MANAGER_STORAGE_KEY = 'trends_manager';

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

const tooltipStyle = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--text-primary)'
};

const axisTick = { fontSize: 11, fill: 'var(--text-muted)' };

export default function Trends() {
  const [managers, setManagers] = useState([]);
  const [managersLoading, setManagersLoading] = useState(true);
  const [selected, setSelected] = useState(() => localStorage.getItem(MANAGER_STORAGE_KEY) || '');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

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
  const midGameweek = data?.seasons?.[0]?.mid_gameweek;

  const rankRows = useMemo(
    () => (data?.seasons || []).filter((s) => s.mid_rank != null && s.final_rank != null),
    [data]
  );

  const finishSummary = useMemo(() => {
    if (rankRows.length === 0) return null;
    const improved = rankRows.filter((s) => s.final_rank < s.mid_rank).length;
    if (improved > rankRows.length / 2) {
      return `Strong finisher: ranked higher at season end than at GW${midGameweek} in ${improved} of your last ${rankRows.length} seasons.`;
    }
    return `Rank at GW${midGameweek} tends to hold: it improved by the finish in ${improved} of ${rankRows.length} seasons.`;
  }, [rankRows, midGameweek]);

  return (
    <div className="trends-page">
      <h2>Your trends <span className="page-title-note">Beta</span></h2>
      <p className="scope-note">Spans every season on record for the selected manager, not just one season.</p>

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
                    <Tooltip contentStyle={tooltipStyle} labelFormatter={(gw) => `Gameweek ${gw}`} />
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

          <div className="trends-card">
            <div className="trends-card-title">Season by season</div>
            <div className="trends-card-subtitle">Final points, and how your rank moved from GW{midGameweek ?? '10'} to the finish</div>

            {data.seasons.length === 0 ? (
              <p className="no-data">No season data available.</p>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={data.seasons} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="season" tick={axisTick} axisLine={false} tickLine={false} />
                    <YAxis tick={axisTick} axisLine={false} tickLine={false} width={40} />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(value) => [`${value} pts`, 'Final points']}
                    />
                    <Bar dataKey="final_points" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                      {data.seasons.map((s) => (
                        <Cell key={s.season} fill={s.is_current ? 'var(--accent)' : 'var(--gray-200)'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>

                {rankRows.length > 0 && (
                  <div className="trends-rank-block">
                    <div className="trends-rank-heading">GW{midGameweek} rank &rarr; final rank</div>
                    <div className="trends-rank-rows">
                      {rankRows.map((s) => (
                        <div className="trends-rank-row" key={s.season}>
                          <span className="trends-rank-season">{s.season}</span>
                          <span className="trends-rank-value">{ordinal(s.mid_rank)}</span>
                          <span className="trends-rank-bar" />
                          <span className={
                            `trends-rank-value ${s.final_rank < s.mid_rank ? 'trends-positive' : s.final_rank > s.mid_rank ? 'trends-negative' : ''}`
                          }>
                            {ordinal(s.final_rank)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {finishSummary && <div className="trends-callout">{finishSummary}</div>}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
