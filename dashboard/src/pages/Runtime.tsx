import { useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { pct, Panel, useReducedMotion } from '../components/bits';
import type { RuntimeResponse } from '../types';

/** Runtime telemetry: what actually fired versus what the static scan believes. */
export default function Runtime() {
  const [data, setData] = useState<RuntimeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    fetch('/api/runtime')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((json) => setData(json as RuntimeResponse))
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <p className="text-red-600">Failed to load /api/runtime: {error}</p>;
  if (!data) return <p className="text-slate-500">Loading…</p>;

  if (!data.hasData) {
    return (
      <div>
        <h1 className="mb-6 text-2xl font-semibold text-slate-900">Runtime Telemetry</h1>
        <div className="rounded-lg bg-white p-10 text-center shadow">
          <p className="text-sm text-slate-700">
            No OTEL logs ingested yet. Run{' '}
            <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">skill-diag runtime ingest</code>{' '}
            to see telemetry.
          </p>
          <p className="mt-3 text-xs text-slate-500">
            Watching {data.storePath} · zero-activation detection needs at least {data.minSessions}{' '}
            sessions.
          </p>
        </div>
      </div>
    );
  }

  const skills = data.skills ?? [];
  const theft = data.theft ?? [];
  const topFiring = data.topFiring ?? [];
  const zero = skills.filter((skill) => skill.zeroActivation);

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-slate-900">Runtime Telemetry</h1>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
            {(data.sessions ?? 0).toLocaleString()} sessions
          </span>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          {data.observedSkills ?? 0} of {skills.length} skills fired at least once.
        </p>
      </div>

      <Panel title="Zero-activation skills">
        {zero.length === 0 ? (
          <p className="text-sm text-slate-500">Every skill fired at least once.</p>
        ) : (
          <>
            <p className="mb-3 text-xs text-slate-500">
              {zero.length} skill{zero.length === 1 ? '' : 's'} pass static checks but fired 0 times —
              pruning candidates.
            </p>
            <div className="flex flex-wrap gap-2">
              {zero.map((skill) => (
                <span
                  key={skill.path}
                  className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700"
                >
                  {skill.name}
                  {skill.plugin ? <span className="ml-1.5 text-slate-400">{skill.plugin}</span> : null}
                </span>
              ))}
            </div>
          </>
        )}
      </Panel>

      <div className="mt-6">
        <Panel title="Trigger theft">
          {theft.length === 0 ? (
            <p className="text-sm text-slate-500">No trigger theft detected.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs text-slate-500">
                    <th className="pb-2 font-medium">Victim</th>
                    <th className="pb-2 font-medium">Thief</th>
                    <th className="pb-2 font-medium">Similarity</th>
                    <th className="pb-2 font-medium">Thief activations</th>
                  </tr>
                </thead>
                <tbody>
                  {theft.map((row) => (
                    <tr key={`${row.victim}|${row.thief}`} className="border-t border-slate-100">
                      <td className="py-2 pr-4 font-medium text-slate-900">{row.victim}</td>
                      <td className="py-2 pr-4 text-slate-700">{row.thief}</td>
                      <td className="py-2 pr-4 tabular-nums">
                        {row.similarity === null ? '—' : pct(row.similarity)}
                      </td>
                      <td className="py-2 tabular-nums">{row.thiefActivations.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-slate-500">
                The thief fires while its near-duplicate victim never does — the victim's trigger is
                being stolen.
              </p>
            </div>
          )}
        </Panel>
      </div>

      <div className="mt-6">
        <Panel title="Top firing skills">
          {topFiring.length === 0 ? (
            <p className="text-sm text-slate-500">No activations recorded.</p>
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(220, topFiring.length * 36)}>
              <BarChart data={topFiring} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                <XAxis
                  type="number"
                  stroke="#94a3b8"
                  fontSize={12}
                  tickFormatter={(v: number) => v.toLocaleString()}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={190}
                  stroke="#94a3b8"
                  fontSize={12}
                  tickFormatter={(v: string) => (v.length > 26 ? `${v.slice(0, 25)}…` : v)}
                />
                <Tooltip />
                <Bar
                  dataKey="activations"
                  name="Activations"
                  fill="#10b981"
                  radius={[0, 4, 4, 0]}
                  barSize={14}
                  isAnimationActive={!reducedMotion}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Panel>
      </div>
    </div>
  );
}
