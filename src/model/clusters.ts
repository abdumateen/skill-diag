/**
 * Duplicate cluster detection (Phase 2b).
 *
 * Two skills that describe themselves the same way compete for the same prompts,
 * so they add hazard without adding capability. We detect that by comparing
 * descriptions as token shingles and taking connected components of the
 * "similar enough" graph.
 *
 * This is deliberately lexical. It cannot see two skills that describe the same
 * job in different words; it only sees reworded duplicates and re-releases. That
 * limit is stated in output rather than hidden.
 */

export interface ClusterOptions {
  /** Words per shingle. 3 keeps short descriptions from matching on one word. */
  readonly shingleSize: number;
  /** Jaccard similarity at or above which two skills are linked. */
  readonly threshold: number;
  /** Descriptions shorter than this cannot be clustered reliably. */
  readonly minTokens: number;
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = {
  shingleSize: 3,
  threshold: 0.72,
  minTokens: 10,
};

export interface ClusterInput {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Plugin key when the skill is a plugin skill; null otherwise. */
  readonly plugin: string | null;
}

export interface ClusterPair {
  readonly a: string;
  readonly b: string;
  readonly similarity: number;
}

export interface Cluster {
  /** Member ids, sorted for deterministic output. */
  readonly members: readonly string[];
  readonly size: number;
  /** Every linked pair inside the cluster, with its similarity. */
  readonly pairs: readonly ClusterPair[];
}

export interface ClusterReport {
  readonly clusters: readonly Cluster[];
  /** Ids skipped because their description is too short to compare. */
  readonly insufficient: readonly string[];
  readonly eligible: number;
  readonly comparedPairs: number;
}

const PUNCTUATION = /[^\p{L}\p{N}\s]+/gu;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(PUNCTUATION, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

export function shingles(tokens: readonly string[], size: number): Set<string> {
  const out = new Set<string>();
  if (tokens.length === 0) return out;
  const width = Math.max(1, size);
  if (tokens.length < width) {
    out.add(tokens.join(' '));
    return out;
  }
  for (let i = 0; i + width <= tokens.length; i += 1) {
    out.add(tokens.slice(i, i + width).join(' '));
  }
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const item of small) if (large.has(item)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Union-find over ids, so clusters are connected components, not pairs. */
class Components {
  private parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: string): string {
    let root = id;
    while (this.parent.get(root) !== root) {
      const next = this.parent.get(root) as string;
      this.parent.set(root, next);
      root = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export function detectClusters(
  inputs: readonly ClusterInput[],
  options: ClusterOptions = DEFAULT_CLUSTER_OPTIONS,
): ClusterReport {
  const insufficient: string[] = [];
  const eligible: Array<{ input: ClusterInput; shingleSet: Set<string> }> = [];

  for (const input of inputs) {
    const tokens = tokenize(input.description);
    if (tokens.length < options.minTokens) {
      insufficient.push(input.id);
      continue;
    }
    eligible.push({ input, shingleSet: shingles(tokens, options.shingleSize) });
  }

  // Candidate pairs from an inverted shingle index. Two descriptions with no
  // shingle in common have Jaccard 0 and cannot clear any positive threshold, so
  // this is exact — it just skips the O(n²) comparisons that could not match.
  const index = new Map<string, number[]>();
  eligible.forEach((entry, i) => {
    for (const shingle of entry.shingleSet) {
      const bucket = index.get(shingle);
      if (bucket) bucket.push(i);
      else index.set(shingle, [i]);
    }
  });

  // Numeric pair keys: this map is the hot path on corpora where many skills
  // share boilerplate shingles, and string keys dominated the cost.
  const width = Math.max(1, eligible.length);
  const sharedCounts = new Map<number, number>();
  for (const bucket of index.values()) {
    if (bucket.length < 2) continue;
    for (let x = 0; x < bucket.length; x += 1) {
      for (let y = x + 1; y < bucket.length; y += 1) {
        const a = bucket[x] as number;
        const b = bucket[y] as number;
        const key = a < b ? a * width + b : b * width + a;
        sharedCounts.set(key, (sharedCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const pairs: ClusterPair[] = [];
  const comparedPairs = sharedCounts.size;
  for (const [key, shared] of sharedCounts) {
    const left = eligible[Math.floor(key / width)];
    const right = eligible[key % width];
    if (!left || !right) continue;
    const union = left.shingleSet.size + right.shingleSet.size - shared;
    const similarity = union === 0 ? 0 : shared / union;
    if (similarity >= options.threshold) {
      pairs.push({ a: left.input.id, b: right.input.id, similarity: Number(similarity.toFixed(4)) });
    }
  }

  const components = new Components();
  for (const { input } of eligible) components.add(input.id);
  for (const pair of pairs) components.union(pair.a, pair.b);

  const grouped = new Map<string, string[]>();
  for (const { input } of eligible) {
    const root = components.find(input.id);
    const list = grouped.get(root) ?? [];
    list.push(input.id);
    grouped.set(root, list);
  }

  const clusters: Cluster[] = [];
  for (const members of grouped.values()) {
    if (members.length < 2) continue;
    const set = new Set(members);
    clusters.push({
      members: [...members].sort(),
      size: members.length,
      pairs: pairs.filter((p) => set.has(p.a) && set.has(p.b)),
    });
  }
  clusters.sort((a, b) => b.size - a.size || (a.members[0] ?? '').localeCompare(b.members[0] ?? ''));

  return { clusters, insufficient, eligible: eligible.length, comparedPairs };
}
