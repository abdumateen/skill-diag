/**
 * Contract loader (Layer 2). Contracts are data: the check engine reads limits
 * from here and never hard-codes a host's numbers.
 */

import raw from './claude-code.json';

export interface Contract {
  host: string;
  versionRange: string;
  skillRoots: readonly string[];
  commandRoots: readonly string[];
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
    dropOrder: string;
    dropOrderConfidence: string;
  };
  priorityOrder: readonly string[];
}

export const CLAUDE_CODE: Contract = raw as Contract;

export function loadContract(host = 'claude-code'): Contract {
  if (host !== 'claude-code') {
    throw new Error(
      `unsupported host contract: ${host} (only claude-code ships in v0.1; cross-host is Phase 7)`,
    );
  }
  return CLAUDE_CODE;
}
