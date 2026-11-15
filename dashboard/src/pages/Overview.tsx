import { Card, pct, STATUS } from '../components/bits';
import type { Summary } from '../types';

export default function Overview({ summary }: { summary: Summary | null }) {
  if (!summary) return <p className="text-slate-500">Loading…</p>;
  const status = STATUS[summary.routing.status] ?? STATUS.ok;
  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-2xl font-semibold text-slate-900">Overview</h1>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${status.badge}`}>
          {status.label}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card title="Total Skills">
          <div className="text-3xl font-bold text-slate-900">{summary.totalSkills}</div>
          <div className="mt-1 text-xs text-slate-500">{summary.totalCommands} commands discovered</div>
        </Card>
        <Card title="Total Findings">
          <div className="text-3xl font-bold text-slate-900">{summary.findings.total}</div>
          <div className="mt-1 text-xs">
            <span className="text-red-600">{summary.findings.errors} errors</span>
            {' · '}
            <span className="text-amber-600">{summary.findings.warnings} warnings</span>
          </div>
        </Card>
        <Card title="Routing Top-1">
          <div className="flex items-center gap-2">
            <span className={`h-3 w-3 rounded-full ${status.dot}`} />
            <span className="text-3xl font-bold text-slate-900">
              {pct(summary.routing.adjustedTop1)}
            </span>
          </div>
          <div className="mt-1 text-xs text-slate-500">
            adjusted · naive {pct(summary.routing.naiveTop1)}
          </div>
        </Card>
        <Card title="Dual-N">
          <div className="text-3xl font-bold text-slate-900">
            {summary.routing.nEff}
            <span className="text-base font-normal text-slate-400"> / {summary.routing.n}</span>
          </div>
          <div className="mt-1 text-xs text-slate-500">effective n / raw n</div>
        </Card>
      </div>
    </div>
  );
}
