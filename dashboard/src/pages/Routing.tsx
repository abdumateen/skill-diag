import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { pct, Panel, STATUS, useReducedMotion } from '../components/bits';
import type { HistorySnapshot, RoutingResponse } from '../types';

/**
 * The survival curve in closed form: top1(N) = r · e^(−p·(N−1)). The params
 * come from the report itself (config.params), so the chart can never drift
 * from what the CLI computes — same formula, same numbers (src/model/survival.ts).
 */
export default function Routing() {
  const [report, setReport] = useState<RoutingResponse['routing'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistorySnapshot[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    fetch('/api/routing')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => setReport((data as RoutingResponse).routing))
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    fetch('/api/history')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((rows) => setHistory(rows as HistorySnapshot[]))
      .catch((e: Error) => setHistoryError(e.message));
  }, []);

  const curve = useMemo(() => {
    if (!report) return [];
    const { r, p } = report.config.params;
    const xMax = Math.ceil(Math.max(report.nEff, report.breakPoints.critical.nStar) * 1.05);
    const step = Math.max(1, Math.round(xMax / 120));
    const points: { n: number; top1: number }[] = [];
    for (let n = 1; n <= xMax; n += step) points.push({ n, top1: r * Math.exp(-p * (n - 1)) });
    if (points[points.length - 1].n !== xMax) points.push({ n: xMax, top1: r * Math.exp(-p * (xMax - 1)) });
    return points;
  }, [report]);

  // Timestamps parse to epoch millis so recharts can put a real time axis under them.
  const historyPoints = useMemo(
    () =>
      history
        .map((snapshot) => ({ t: Date.parse(snapshot.timestamp), top1: snapshot.routingTop1 }))
        .filter((point) => Number.isFinite(point.t))
        .sort((a, z) => a.t - z.t),
    [history],
  );

  if (error) return <p className="text-red-600">Failed to load /api/routing: {error}</p>;
  if (!report) return <p className="text-slate-500">Loading…</p>;
  const status = STATUS[report.status] ?? STATUS.ok;

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-2xl font-semibold text-slate-900">Routing Health</h1>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${status.badge}`}>
          {status.label}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Raw scan">
          <div className="text-3xl font-bold text-slate-900">{report.n}</div>
          <div className="mt-1 text-xs text-slate-500">
            skills listed · naive top-1 {pct(report.naiveTop1)}
          </div>
        </Panel>
        <Panel title="Deduped (N_eff)">
          <div className="text-3xl font-bold text-slate-900">{report.nEff}</div>
          <div className="mt-1 text-xs text-slate-500">
            effective skills · adjusted top-1 {pct(report.adjustedTop1)}
          </div>
        </Panel>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        N_eff / N = {report.density.toFixed(2)} — duplicate clusters inflate the effective corpus by{' '}
        {((report.density - 1) * 100).toFixed(1)}%.
      </p>

      <div className="mt-6">
        <Panel title="Routing history — top-1 accuracy over time">
          {historyError !== null ? (
            <p className="text-sm text-red-600">Failed to load /api/history: {historyError}</p>
          ) : historyPoints.length < 2 ? (
            <p className="text-sm text-slate-500">
              Run{' '}
              <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">skill-diag snapshot</code>{' '}
              in CI to track history over time.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={historyPoints} margin={{ top: 24, right: 16, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis
                  dataKey="t"
                  type="number"
                  scale="time"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(v: number) =>
                    new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                  }
                  stroke="#94a3b8"
                  fontSize={12}
                  minTickGap={24}
                />
                <YAxis
                  domain={[0.4, 0.9]}
                  tickFormatter={(v: number) => pct(v)}
                  stroke="#94a3b8"
                  fontSize={12}
                  width={52}
                />
                <Tooltip
                  formatter={(value) => pct(value as number)}
                  labelFormatter={(label) => new Date(Number(label)).toLocaleString()}
                />
                <ReferenceLine
                  y={0.6}
                  stroke="#f59e0b"
                  strokeDasharray="6 4"
                  label={{ value: 'warning 0.60', position: 'insideTopRight', fill: '#92400e', fontSize: 12 }}
                />
                <ReferenceLine
                  y={0.5}
                  stroke="#ef4444"
                  strokeDasharray="6 4"
                  label={{ value: 'critical 0.50', position: 'insideBottomRight', fill: '#991b1b', fontSize: 12 }}
                />
                <Line
                  type="monotone"
                  dataKey="top1"
                  name="Top-1"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={{ r: 3, fill: '#10b981' }}
                  activeDot={{ r: 4 }}
                  isAnimationActive={!reducedMotion}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Panel>
      </div>

      <div className="mt-6">
        <Panel title="Survival curve — top-1 accuracy as the corpus grows">
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={curve} margin={{ top: 24, right: 16, bottom: 4, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis
                dataKey="n"
                type="number"
                domain={[1, curve.length > 0 ? curve[curve.length - 1].n : 1]}
                tickFormatter={(v: number) => v.toLocaleString()}
                stroke="#94a3b8"
                fontSize={12}
              />
              <YAxis
                domain={[0.4, 0.9]}
                tickFormatter={(v: number) => pct(v)}
                stroke="#94a3b8"
                fontSize={12}
                width={52}
              />
              <Tooltip
                formatter={(value) => pct(value as number)}
                labelFormatter={(label) => `N = ${Number(label).toLocaleString()}`}
              />
              <ReferenceLine
                y={0.6}
                stroke="#f59e0b"
                strokeDasharray="6 4"
                label={{ value: 'warning 0.60', position: 'insideTopRight', fill: '#92400e', fontSize: 12 }}
              />
              <ReferenceLine
                y={0.5}
                stroke="#ef4444"
                strokeDasharray="6 4"
                label={{ value: 'critical 0.50', position: 'insideBottomRight', fill: '#991b1b', fontSize: 12 }}
              />
              <ReferenceLine
                x={report.n}
                stroke="#64748b"
                strokeDasharray="4 4"
              />
              <ReferenceLine
                x={report.nEff}
                stroke="#0f766e"
                strokeDasharray="4 4"
              />
              <Line
                type="monotone"
                dataKey="top1"
                stroke="#10b981"
                strokeWidth={2}
                dot={false}
                isAnimationActive={!reducedMotion}
              />
              <ReferenceDot x={report.n} y={report.naiveTop1} r={5} fill="#334155" />
              <ReferenceDot x={report.nEff} y={report.adjustedTop1} r={5} fill="#0f766e" />
            </LineChart>
          </ResponsiveContainer>
          <p className="mt-2 text-xs text-slate-500">
            <span className="inline-block h-2 w-2 rounded-full bg-slate-600" /> raw N ={' '}
            {report.n.toLocaleString()} (naive {pct(report.naiveTop1)}) ·{' '}
            <span className="inline-block h-2 w-2 rounded-full bg-teal-700" /> N_eff ={' '}
            {report.nEff.toLocaleString()} (adjusted {pct(report.adjustedTop1)})
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Headroom: warning (0.60) reached at N = {report.breakPoints.warning.nStar.toLocaleString()}{' '}
            ({report.breakPoints.warning.naiveHeadroom.toLocaleString()} skills of raw headroom,{' '}
            {report.breakPoints.warning.adjustedHeadroom.toLocaleString()} adjusted) · critical (0.50)
            at N = {report.breakPoints.critical.nStar.toLocaleString()} (
            {report.breakPoints.critical.naiveHeadroom.toLocaleString()} raw,{' '}
            {report.breakPoints.critical.adjustedHeadroom.toLocaleString()} adjusted).
          </p>
        </Panel>
      </div>

      <div className="mt-6">
        <Panel title="Duplicate clusters">
          {report.pruning.length === 0 ? (
            <p className="text-sm text-slate-500">
              No duplicate clusters at the configured similarity threshold (
              {report.config.similarityThreshold}).
            </p>
          ) : (
            <>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs text-slate-500">
                    <th className="pb-2 font-medium">Cluster</th>
                    <th className="pb-2 font-medium">Size</th>
                    <th className="pb-2 font-medium">Top-1 cost</th>
                  </tr>
                </thead>
                <tbody>
                  {report.pruning.map((entry, index) => (
                    <tr key={entry.cluster.join('|')} className="border-t border-slate-100">
                      <td className="py-2 pr-4">
                        <span className="font-medium text-slate-900">C{index + 1}</span>
                        <span className="ml-2 text-slate-500">
                          {entry.cluster.slice(0, 3).join(', ')}
                          {entry.cluster.length > 3 ? ` +${entry.cluster.length - 3} more` : ''}
                        </span>
                      </td>
                      <td className="py-2 pr-4 tabular-nums">{entry.size}</td>
                      <td className="py-2 tabular-nums text-amber-700">
                        +{(entry.gain * 100).toFixed(1)} pp
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-slate-500">
                Top {report.pruning.length} of {report.clusters.count} cluster(s) by accuracy cost ·{' '}
                {report.clusters.clusteredSkills} skills clustered ·{' '}
                {report.clusters.insufficient} skipped as too short to cluster reliably.
              </p>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}
