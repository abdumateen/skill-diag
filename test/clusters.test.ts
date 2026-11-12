import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLUSTER_OPTIONS,
  detectClusters,
  jaccard,
  shingles,
  tokenize,
} from '../src/model/clusters.js';
import { effectiveN } from '../src/model/routing.js';

const DESC =
  'Reviews pull requests for correctness and security, then writes a summary of the findings for the maintainer';

function input(id: string, description: string, plugin: string | null = 'plug') {
  return { id, name: id, description, plugin };
}

describe('cluster detection', () => {
  it('tokenizes to lowercase words without punctuation', () => {
    expect(tokenize('Fix: Bugs, FAST!')).toEqual(['fix', 'bugs', 'fast']);
  });

  it('scores identical shingle sets at 1 and disjoint at 0', () => {
    const a = shingles(tokenize(DESC), 3);
    const b = shingles(tokenize(DESC), 3);
    const c = shingles(tokenize('Totally unrelated words about cooking pasta with tomato sauce'), 3);
    expect(jaccard(a, b)).toBe(1);
    expect(jaccard(a, c)).toBe(0);
  });

  it('groups near-identical descriptions into one cluster with pair scores', () => {
    const report = detectClusters([
      input('a', DESC),
      input('b', `${DESC}.`),
      input('c', 'An entirely different skill that handles deployment pipelines for mobile releases and rollbacks'),
    ]);
    expect(report.clusters.length).toBe(1);
    expect(report.clusters[0]?.size).toBe(2);
    expect(report.clusters[0]?.pairs[0]?.similarity).toBeGreaterThan(0.99);
  });

  it('skips descriptions too short to cluster and says so', () => {
    const report = detectClusters([input('a', 'short one'), input('b', 'short one')]);
    expect(report.clusters.length).toBe(0);
    expect(report.insufficient).toEqual(['a', 'b']);
  });

  it('respects the similarity threshold', () => {
    const near = `${DESC} carefully`;
    const loose = detectClusters([input('a', DESC), input('b', near)], {
      ...DEFAULT_CLUSTER_OPTIONS,
      threshold: 0.99,
    });
    const tight = detectClusters([input('a', DESC), input('b', near)], {
      ...DEFAULT_CLUSTER_OPTIONS,
      threshold: 0.5,
    });
    expect(loose.clusters.length).toBe(0);
    expect(tight.clusters.length).toBe(1);
  });

  it('links connected components, not just direct pairs', () => {
    // a~b and b~c clear 0.5; a and c do not. The component must still hold all
    // three, which is what makes this clustering rather than pair matching.
    const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen'];
    const a = words.slice(0, 12).join(' ');
    const b = words.slice(3, 15).join(' ');
    const c = words.slice(6, 18).join(' ');
    const report = detectClusters([input('a', a), input('b', b), input('c', c)], {
      ...DEFAULT_CLUSTER_OPTIONS,
      threshold: 0.5,
    });
    expect(report.clusters.length).toBe(1);
    expect(report.clusters[0]?.members.length).toBe(3);
    expect(report.clusters[0]?.pairs.length).toBe(2);
  });

  it('turns cluster sizes into N_eff with the collision weight', () => {
    expect(effectiveN(2000, [4, 4, 4], 1)).toBe(2009);
    expect(effectiveN(2000, [4], 2)).toBe(2006);
    expect(effectiveN(10, [], 1)).toBe(10);
  });
});
