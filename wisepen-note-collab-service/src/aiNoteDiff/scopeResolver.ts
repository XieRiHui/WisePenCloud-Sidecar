import { NormalizedNoteXmlScope, NoteBlock, NoteXmlScope } from './types';
import { flattenBlocks } from './utils';

export type ResolvedScope = {
  scope: NormalizedNoteXmlScope;
  blocks: NoteBlock[];
};

export function resolveNoteScope(blocks: NoteBlock[], scope?: NoteXmlScope): ResolvedScope {
  if (!scope || scope.type === 'whole_note') {
    return { scope: { type: 'whole_note' }, blocks };
  }

  const flat = flattenBlocks(blocks);
  const byId = new Map(flat.map((block) => [block.id, block]));

  if (scope.type === 'blocks') {
    const blockIds = Array.isArray(scope.block_ids) ? scope.block_ids : [];
    const selected = blockIds.map((id) => byId.get(id)).filter((block): block is NoteBlock => Boolean(block));
    if (selected.length !== blockIds.length) {
      throw new Error('scope_block_not_found');
    }
    const includeChildren = Boolean(scope.include_children);
    return {
      scope: { type: 'blocks', block_ids: blockIds, include_children: includeChildren },
      blocks: includeChildren ? selected : selected.map((block) => ({ ...block, children: [] })),
    };
  }

  if (scope.type === 'subtree') {
    const root = byId.get(scope.root_block_id);
    if (!root) {
      throw new Error('scope_block_not_found');
    }
    return { scope: { type: 'subtree', root_block_id: scope.root_block_id }, blocks: [root] };
  }

  if (scope.type === 'block_range') {
    const start = flat.findIndex((block) => block.id === scope.start_block_id);
    const end = flat.findIndex((block) => block.id === scope.end_block_id);
    if (start < 0 || end < 0) {
      throw new Error('scope_block_not_found');
    }
    if (start > end) {
      throw new Error('invalid_scope_range');
    }
    return {
      scope: {
        type: 'block_range',
        start_block_id: scope.start_block_id,
        end_block_id: scope.end_block_id,
        include_partial: false,
      },
      blocks: flat.slice(start, end + 1).map((block) => ({ ...block, children: [] })),
    };
  }

  throw new Error('invalid_scope');
}
