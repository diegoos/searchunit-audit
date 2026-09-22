import type { CheckStatus } from '../lib/output';

export type { CheckStatus };

const STATUS_WEIGHT: Record<CheckStatus, number> = { pass: 1, warn: 0.5, fail: 0 };

/** Maps a 0–100 score to pass/warn/fail using the standard 80/50 thresholds. */
export function scoreToCheckStatus(score: number): CheckStatus {
  if (score >= 80) {
    return 'pass';
  }

  if (score >= 50) {
    return 'warn';
  }

  return 'fail';
}

/** Weighted average of pass/warn/fail checks as a 0–100 score. `info` rows are ignored. Empty input is 0. */
export function statusWeightedScore(checks: readonly { status: CheckStatus | 'info' }[]): number {
  const scored = checks.filter(
    (check): check is { status: CheckStatus } => check.status !== 'info',
  );

  if (scored.length === 0) {
    return 0;
  }

  const sum = scored.reduce((total, check) => total + STATUS_WEIGHT[check.status], 0);

  return Math.round((sum / scored.length) * 100);
}

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  value?: string;
}
