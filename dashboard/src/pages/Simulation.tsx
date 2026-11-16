import { AlertTriangle } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { pct, Panel, STATUS } from '../components/bits';
import type { SimulationResponse } from '../types';

/**
 * The dashboard face of `simulate_add`: paste a draft skill description, see
 * what it would cost the corpus. Same `/api/simulate` math the MCP tool uses,
 * so the human and the agent read the same projection.
 */
export default function Simulation() {
  const [text, setText] = useState('');
  const [result, setResult] = useState<SimulationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const description = text.trim();
    if (description === '' || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `HTTP ${res.status}`);
      }
      setResult((await res.json()) as SimulationResponse);
    } catch (e) {
      setError((e as Error).message);
      setResult(null);
    } finally {
      setPending(false);
    }
  }

  const projectedTop1 = result?.projected.top1 ?? 0;
  const state = projectedTop1 < 0.5 ? 'critical' : projectedTop1 < 0.6 ? 'at-risk' : 'ok';
  const status = STATUS[state];
  const critical = projectedTop1 < 0.5;
  const maxNEff = result ? Math.max(result.current.nEff, result.projected.nEff, 1) : 1;
  const deltaPp = result ? result.delta * 100 : 0;
  // One add on a 1000-skill corpus moves top-1 by a few hundredths of a point;
  // one decimal would round that to "-0.0". Give small deltas a second decimal.
  const magnitude = Math.abs(deltaPp);
  const decimals = magnitude < 0.1 ? 2 : 1;
  const rounded = Number(magnitude.toFixed(decimals));
  const deltaLabel = rounded === 0 ? '0.0' : `-${rounded.toFixed(decimals)}`;

  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">Simulation</h1>
      <p className="mt-1 text-sm text-slate-500">
        Project what one more skill would cost. The new description joins the real duplicate-cluster
        pass, so N_eff reflects the overlaps it would actually create.
      </p>

      <form onSubmit={onSubmit} className="mt-6">
        <label htmlFor="sim-description" className="text-sm font-medium text-slate-700">
          Describe the skill you want to add
        </label>
        <textarea
          id="sim-description"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={4}
          placeholder="e.g. Reviews pull requests for security and writes a changelog entry"
          className="mt-2 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus-visible:border-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400"
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            type="submit"
            disabled={pending || text.trim() === ''}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {pending ? 'Simulating...' : 'Simulate Impact'}
          </button>
          <span className="text-xs text-slate-500">
            Reads the local corpus only. Nothing leaves this machine.
          </span>
        </div>
      </form>

      {error !== null && (
        <p className="mt-4 text-sm text-red-600" role="alert">
          Simulation failed: {error}
        </p>
      )}

      {result && (
        <div className="mt-8 space-y-4" aria-live="polite">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Panel title="Top-1 accuracy lost">
              <div
                className={`text-4xl font-bold tabular-nums ${
                  critical ? 'text-red-600' : deltaPp > 0 ? 'text-amber-600' : 'text-teal-700'
                }`}
              >
                {deltaLabel}
                <span className="ml-1 text-lg font-medium">pp</span>
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {pct(result.current.top1)} now, {pct(result.projected.top1)} after the add
              </div>
            </Panel>
            <Panel title="Projected status">
              <span className={`inline-block rounded-full px-3 py-1 text-xs font-medium ${status.badge}`}>
                {status.label}
              </span>
              <div className="mt-2 text-xs text-slate-500">
                Thresholds: warning below {pct(0.6)}, critical below {pct(0.5)}.
              </div>
            </Panel>
            <Panel title="Corpus size">
              <div className="text-3xl font-bold tabular-nums text-slate-900">
                {result.current.n}
                <span className="mx-2 text-lg font-normal text-slate-400">&rarr;</span>
                {result.projected.n}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                listed skills before and after the add
              </div>
            </Panel>
          </div>

          <Panel title="N_eff — current vs projected">
            <div className="space-y-3">
              {[
                { label: 'Current', value: result.current.nEff, bar: 'bg-slate-600' },
                { label: 'Projected', value: result.projected.nEff, bar: 'bg-teal-700' },
              ].map((row) => (
                <div key={row.label} className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-xs text-slate-500">{row.label}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded bg-slate-100">
                    <div
                      className={`h-full rounded ${row.bar}`}
                      style={{ width: `${(row.value / maxNEff) * 100}%` }}
                    />
                  </div>
                  <span className="w-14 shrink-0 text-right text-sm font-medium tabular-nums text-slate-900">
                    {row.value.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-500">
              N_eff counts duplicate clusters at collision weight 1, so a skill that overlaps adds
              more than one to the effective corpus.
            </p>
          </Panel>

          {result.warnings.length > 0 && (
            <div
              className={`rounded-md border px-4 py-3 ${
                critical
                  ? 'border-red-200 bg-red-50 text-red-700'
                  : 'border-amber-200 bg-amber-50 text-amber-800'
              }`}
              role="alert"
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <AlertTriangle className="h-4 w-4" />
                This skill would cross a routing threshold
              </div>
              <ul className="mt-2 space-y-1 text-sm">
                {result.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          <Panel title="Collisions">
            {result.collisions.length === 0 ? (
              <p className="text-sm text-slate-500">
                No description overlap above the clustering threshold. The add costs one clean slot.
              </p>
            ) : (
              <ul className="space-y-3">
                {result.collisions.map((collision) => (
                  <li key={collision.name}>
                    <p className="text-sm text-slate-900">
                      This skill overlaps with{' '}
                      <span className="font-medium">{collision.name}</span> (
                      {Math.round(collision.similarity * 100)}% similarity).
                    </p>
                    <div className="mt-1.5 flex items-center gap-3">
                      <div className="h-1.5 flex-1 overflow-hidden rounded bg-slate-100">
                        <div
                          className="h-full rounded bg-amber-500"
                          style={{ width: `${collision.similarity * 100}%` }}
                        />
                      </div>
                      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-slate-500">
                        {Math.round(collision.similarity * 100)}%
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}