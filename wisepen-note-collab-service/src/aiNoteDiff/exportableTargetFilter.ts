import { NoteBlock, SkippedTargetSummary } from './types';
import { deepClone, hasPendingAiDiff } from './utils';

export type FilterExportableTargetsResult = {
  blocks: NoteBlock[];
  skippedTargets: SkippedTargetSummary[];
};

export function filterExportableTargets(blocks: NoteBlock[]): FilterExportableTargetsResult {
  const skippedTargets: SkippedTargetSummary[] = [];
  const filtered = filterBlocks(blocks, skippedTargets);
  if (filtered.length === 0) {
    throw new Error('empty_exportable_scope');
  }
  return { blocks: filtered, skippedTargets };
}

function filterBlocks(blocks: NoteBlock[], skippedTargets: SkippedTargetSummary[]): NoteBlock[] {
  const out: NoteBlock[] = [];
  for (const block of blocks) {
    if (hasPendingAiDiff(block)) {
      skippedTargets.push({
        kind: 'block',
        reason: 'pending_ai_diff_exists',
      });
      continue;
    }
    out.push({
      ...deepClone(block),
      children: filterBlocks(block.children, skippedTargets),
    });
  }
  return out;
}
