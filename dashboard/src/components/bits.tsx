import { useEffect, useState, type ReactNode } from 'react';

/** Status → label + Tailwind classes, shared by every view's badge and dot. */
export const STATUS: Record<string, { label: string; badge: string; dot: string }> = {
  ok: { label: 'Healthy', badge: 'bg-emerald-100 text-emerald-800', dot: 'bg-emerald-500' },
  'at-risk': { label: 'Needs Attention', badge: 'bg-amber-100 text-amber-800', dot: 'bg-amber-500' },
  critical: { label: 'Critical', badge: 'bg-red-100 text-red-800', dot: 'bg-red-500' },
};

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg bg-white p-5 shadow">
      <div className="text-sm text-slate-500">{title}</div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg bg-white p-5 shadow">
      <h2 className="text-sm font-medium text-slate-500">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

/** Recharts animates in JS, so honour the media query ourselves. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent): void => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
