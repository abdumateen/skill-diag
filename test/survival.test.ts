import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SURVIVAL_PARAMS,
  PUBLISHED_CALIBRATION,
  breakPoint,
  marginalEffect,
  parseRoutingParams,
  top1,
} from '../src/model/survival.js';

describe('survival model', () => {
  it('reproduces the published calibration point within tolerance', () => {
    const estimate = top1(PUBLISHED_CALIBRATION.n);
    expect(estimate).toBeGreaterThan(PUBLISHED_CALIBRATION.pTop1 - PUBLISHED_CALIBRATION.tolerance);
    expect(estimate).toBeLessThan(PUBLISHED_CALIBRATION.pTop1 + PUBLISHED_CALIBRATION.tolerance);
  });

  it('estimates 0.633 at the live corpus size', () => {
    expect(top1(1115)).toBeCloseTo(0.633, 2);
  });

  it('is monotonic decreasing and starts at r', () => {
    expect(top1(1)).toBeCloseTo(DEFAULT_SURVIVAL_PARAMS.r, 10);
    expect(top1(500)).toBeGreaterThan(top1(1000));
    expect(top1(1000)).toBeGreaterThan(top1(2000));
  });

  it('finds the first N at or below the threshold, not a rounded guess', () => {
    const nStar = breakPoint(0.5);
    // P(1946) = 0.499998 is already at the floor; P(1945) = 0.500184 is not.
    expect(nStar).toBe(1946);
    expect(top1(nStar)).toBeLessThanOrEqual(0.5);
    expect(top1(nStar - 1)).toBeGreaterThan(0.5);
  });

  it('finds the 0.60 warning crossing', () => {
    const nStar = breakPoint(0.6);
    expect(nStar).toBe(1302);
    expect(top1(nStar)).toBeLessThanOrEqual(0.6);
    expect(top1(nStar - 1)).toBeGreaterThan(0.6);
  });

  it('handles thresholds outside the model range honestly', () => {
    // Above r the first skill is already below the line, so the break point is 1.
    expect(breakPoint(0.9)).toBe(1);
    expect(() => breakPoint(0)).toThrow();
    expect(() => breakPoint(1.5)).toThrow();
  });

  it('parses an override and labels its provenance', () => {
    const params = parseRoutingParams('0.9,0.001');
    expect(params.r).toBe(0.9);
    expect(params.p).toBe(0.001);
    expect(params.source).toContain('--routing-params');
    expect(() => parseRoutingParams('0.9')).toThrow();
    expect(() => parseRoutingParams('1.5,0.001')).toThrow();
    expect(() => parseRoutingParams('0.9,-1')).toThrow();
  });

  it('reports a positive marginal effect of adding one skill', () => {
    expect(marginalEffect(1000)).toBeGreaterThan(0);
    expect(marginalEffect(1)).toBeCloseTo(0, 12);
  });
});
