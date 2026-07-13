import { ApplyPlanResult, ClassifiedApplyOperation } from './types';

export function buildApplyResult(classified: ClassifiedApplyOperation[]): ApplyPlanResult {
  const result: ApplyPlanResult = {
    summary: { applied: 0, staleApplied: 0, conflicts: 0, skipped: 0 },
    applied: [],
    staleApplied: [],
    conflicts: [],
    skipped: [],
  };

  for (const operation of classified) {
    if (operation.status === 'applied') {
      result.applied.push(operation.opId);
      result.summary.applied += 1;
      continue;
    }
    if (operation.status === 'staleApplied') {
      result.staleApplied.push(operation.opId);
      result.summary.staleApplied += 1;
      continue;
    }
    if (operation.status === 'conflict') {
      result.conflicts.push({
        opId: operation.opId,
        reason: operation.reason ?? 'unsupported_target',
      });
      result.summary.conflicts += 1;
      continue;
    }
    result.skipped.push({
      opId: operation.opId,
      reason: operation.reason ?? 'unsupported_target',
    });
    result.summary.skipped += 1;
  }

  return result;
}
