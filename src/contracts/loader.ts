/**
 * Contract loader (Layer 2). Contracts are data: the check engine reads limits
 * from here and never hard-codes a host's numbers.
 */

import rawClaude from './claude-code.json';
import rawCursor from './cursor.json';
import rawCodex from './codex.json';
import rawGemini from './gemini-cli.json';
import type { DropCalibrationMethod, DropConfidence, DropOrder } from '../types.js';

export interface Contract {
  host: string;
  versionRange: string;
  skillRoots: readonly string[];
  commandRoots: readonly string[];
  /**
   * Severity pins, keyed by check id. A check reads its own id; an absent key
   * means the check's own default stands. `description-capped` is pinned to
   * `error` because a host-truncated description is a load-breaker, not a style
   * warning: the skill still lists, but the router never sees the text that
   * would have selected it.
   */
  severity: Readonly<Record<string, 'error' | 'warning' | 'info'>>;
  frontmatter: {
    required: readonly string[];
    recommended: readonly string[];
    namePattern: string;
    nameMaxLength: number;
    nameMustMatchDirectory: boolean;
    descriptionMaxLength: number;
    allowedFields: readonly string[];
    openStandardFields: readonly string[];
    rejectedOnUploadPath: readonly string[];
  };
  listingBudget: {
    mode: string;
    fraction: number;
    absoluteDefaultChars: number;
    envOverride: string;
    perEntryCapChars: number;
    defaultContextWindow: number;
    charsPerToken: number;
    overheadCharsPerEntry: number;
    overheadCalibrated: boolean;
    overheadNote: string;
    /** Verbatim explanation of why calibration could not run. Surfaced in every format. */
    calibrationUnavailableReason: string;
    limitVerification: {
      measured: boolean;
      competingValue: number;
      competingSource: string;
    };
  };
  dropBehavior: {
    namesAlwaysListed: boolean;
    dropTarget: string;
    /** `unknown` until a 5-trial harness observes the host's real drop order. */
    dropOrder: DropOrder;
    confidence: DropConfidence;
    calibrationMethod: DropCalibrationMethod;
    /** Result file a calibration run would write. */
    evidence: string;
    reason?: string;
  };
  priorityOrder: readonly string[];
}

export const CLAUDE_CODE: Contract = rawClaude as Contract;

/**
 * Phase 4c: one contract per supported host. The imports stay static because
 * the bundler (tsup/esbuild) inlines them into dist/cli.js — a runtime
 * `await import()` of a JSON path would not survive bundling, and loadContract
 * must stay synchronous for every caller.
 */
const CONTRACTS: Readonly<Record<string, Contract>> = {
  'claude-code': CLAUDE_CODE,
  cursor: rawCursor as Contract,
  codex: rawCodex as Contract,
  'gemini-cli': rawGemini as Contract,
};

export function loadContract(host = 'claude-code'): Contract {
  const contract = CONTRACTS[host];
  if (!contract) {
    throw new Error(
      `unsupported host contract: ${host} (known hosts: ${Object.keys(CONTRACTS).join(', ')})`,
    );
  }
  return contract;
}
