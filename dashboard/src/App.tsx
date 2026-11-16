import { useEffect, useState } from 'react';
import { Activity, FlaskConical, LayoutDashboard, Route, Stethoscope, type LucideIcon } from 'lucide-react';
import Overview from './pages/Overview';
import Routing from './pages/Routing';
import Runtime from './pages/Runtime';
import Simulation from './pages/Simulation';
import type { Summary } from './types';

type View = 'overview' | 'routing' | 'runtime' | 'simulation';

const NAV: { id: View; label: string; icon: LucideIcon }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'routing', label: 'Routing Health', icon: Route },
  { id: 'runtime', label: 'Runtime Telemetry', icon: Activity },
  { id: 'simulation', label: 'Simulation', icon: FlaskConical },
];

export default function App() {
  const [view, setView] = useState<View>('overview');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/summary')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => setSummary(data as Summary))
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="flex h-screen bg-slate-100">
      <aside className="flex w-60 shrink-0 flex-col bg-slate-900 text-slate-100">
        <div className="flex items-center gap-2 px-4 py-5">
          <Stethoscope className="h-6 w-6 text-emerald-400" />
          <div>
            <div className="text-sm font-semibold">skill-diag</div>
            <div className="text-xs text-slate-400">
              {summary ? `v${summary.tool.version}` : 'v—'}
            </div>
          </div>
        </div>
        <nav className="flex-1 space-y-1 px-2">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400 ${
                view === id ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </nav>
        <div className="px-4 py-3 text-xs text-slate-500">local-first · no telemetry</div>
      </aside>
      <main className="flex-1 overflow-auto p-8">
        {error ? (
          <p className="text-red-600">Failed to load /api/summary: {error}</p>
        ) : view === 'overview' ? (
          <Overview summary={summary} />
        ) : view === 'routing' ? (
          <Routing />
        ) : view === 'runtime' ? (
          <Runtime />
        ) : (
          <Simulation />
        )}
      </main>
    </div>
  );
}
