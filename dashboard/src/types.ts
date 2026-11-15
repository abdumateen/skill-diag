/** Shape of GET /api/summary — see src/dashboard/server.ts liveSummary(). */
export interface Summary {
  version: string;
  tool: { name: string; version: string };
  source: string;
  generatedAt: string;
  totalSkills: number;
  totalCommands: number;
  findings: { total: number; errors: number; warnings: number; info: number };
  routing: {
    status: 'ok' | 'at-risk' | 'critical';
    naiveTop1: number;
    adjustedTop1: number;
    n: number;
    nEff: number;
  };
}
