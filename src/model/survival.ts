/**
 * Routing survival model (Phase 2b).
 *
 * P_top1(N) = r * exp(-p * (N - 1))
 *
 * The model answers one question: as the number of listed skills grows, what is
 * the chance the router picks the right one first? It is deliberately simple —
 * a single exponential with two parameters — because the point is to make the
 * *shape* of the problem visible, not to simulate a particular router.
 *
 * The parameters are published, not fitted here. The calibration point we check
 * against is P_top1(2029) = 0.488.
 */

export interface SurvivalParams {
  /** Top-1 accuracy as N approaches 1. */
  readonly r: number;
  /** Decay rate per additional listed skill. */
  readonly p: number;
  /** Provenance label, printed in output so a number is never bare. */
  readonly source: string;
  /** Where the parameters came from, in words. */
  readonly citation: string;
}

export const PUBLISHED_CALIBRATION = {
  n: 2029,
  pTop1: 0.488,
  tolerance: 0.05,
} as const;

export const DEFAULT_SURVIVAL_PARAMS: SurvivalParams = {
  r: 0.867,
  p: 2.83e-4,
  source: 'curse-of-skills-2026',
  citation:
    "published top-1 calibration P_top1(2029) = 0.488 with r = 0.867, p = 2.83e-4; parameters taken as given in the phase-2b brief under the name 'curse-of-skills-2026'. The parameters are the paper's; the harness (this corpus, this tokenisation) is ours.",
};

/** Probability the correct skill is ranked first when N skills are listed. */
export function top1(n: number, params: SurvivalParams = DEFAULT_SURVIVAL_PARAMS): number {
  if (!Number.isFinite(n)) return 0;
  const size = Math.max(1, n);
  return params.r * Math.exp(-params.p * (size - 1));
}

/**
 * Smallest integer N at which top-1 falls to `theta`.
 *
 * N_star(theta) = 1 + ln(r / theta) / p, rounded up because N is a count of
 * skills: the break point is the first N whose estimate is *at or below* theta.
 */
export function breakPoint(
  theta: number,
  params: SurvivalParams = DEFAULT_SURVIVAL_PARAMS,
): number {
  if (!(theta > 0) || theta > 1) {
    throw new Error(`break point threshold must be in (0, 1]: got ${theta}`);
  }
  // A threshold at or above r is already crossed by a single listed skill; the
  // caller (a fixture with its own r, say) is not misconfigured, just early.
  if (theta >= params.r) return 1;
  // The closed form is continuous; the smallest integer N whose estimate is at
  // or below theta can differ from its ceil by one because the model is
  // exponential, so check the boundary instead of trusting the rounding.
  let n = Math.max(1, Math.ceil(1 + Math.log(params.r / theta) / params.p));
  while (n > 1 && top1(n - 1, params) <= theta) n -= 1;
  while (top1(n, params) > theta) n += 1;
  return n;
}

/**
 * Change in top-1 from removing `drop` listed skills. Positive means removal
 * helps: it is the routing gain, which is the same magnitude as the routing cost
 * of having them.
 */
export function marginalEffect(
  n: number,
  params: SurvivalParams = DEFAULT_SURVIVAL_PARAMS,
  drop = 1,
): number {
  return top1(Math.max(1, n - drop), params) - top1(n, params);
}

export interface ParamOverride {
  readonly r: number;
  readonly p: number;
  readonly source: string;
}

/**
 * Parse `--routing-params r,p`.
 *
 * Users whose harness differs from the published one can recalibrate without
 * waiting for us; the source label changes so the output never claims published
 * provenance for hand-supplied numbers.
 */
export function parseRoutingParams(
  spec: string,
  base: SurvivalParams = DEFAULT_SURVIVAL_PARAMS,
): SurvivalParams {
  const parts = spec.split(',').map((s) => s.trim());
  if (parts.length !== 2) {
    throw new Error('--routing-params expects two numbers: r,p (e.g. 0.867,0.000283)');
  }
  const r = Number(parts[0]);
  const p = Number(parts[1]);
  if (!Number.isFinite(r) || r <= 0 || r > 1) {
    throw new Error(`--routing-params: r must be in (0,1], got ${parts[0]}`);
  }
  if (!Number.isFinite(p) || p <= 0) {
    throw new Error(`--routing-params: p must be > 0, got ${parts[1]}`);
  }
  return {
    r,
    p,
    source: `${base.source} (overridden via --routing-params)`,
    citation: base.citation,
  };
}
