import {
  ApplyOperation,
  ClassifiedApplyOperation,
  InlineMathTargetInfo,
  LinkTargetInfo,
  MathExpressionTargetInfo,
  NoteBlock,
  TargetInfo,
  TextTargetInfo,
} from './types';
import { findBlockById, hasPendingAiDiff, isRecord, sha256 } from './utils';

export function classifyYDocTargets(
  currentBlocks: NoteBlock[],
  operations: ApplyOperation[],
): ClassifiedApplyOperation[] {
  return operations.map((operation) => classifyOperation(currentBlocks, operation));
}

function classifyOperation(
  currentBlocks: NoteBlock[],
  operation: ApplyOperation,
): ClassifiedApplyOperation {
  const info = operation.targetInfo ?? operation.anchorInfo;
  if (!info) {
    return { ...operation, status: 'conflict', reason: 'unsupported_target' };
  }

  const block = findBlockById(currentBlocks, info.blockId);
  if (!block) {
    if (operation.kind === 'delete_block' || operation.kind === 'delete_target') {
      return { ...operation, status: 'skipped', reason: 'delete_target_missing' };
    }
    return {
      ...operation,
      status: 'conflict',
      reason: operation.kind.startsWith('add_') ? 'add_anchor_missing' : 'block_missing',
    };
  }

  if (block.type !== info.blockType) {
    return { ...operation, status: 'conflict', reason: 'block_type_changed' };
  }

  if (hasPendingAiDiff(block)) {
    return { ...operation, status: 'conflict', reason: 'pending_ai_diff_exists' };
  }

  if (operation.kind.startsWith('add_')) {
    const anchorOk = validateCurrentTarget(block, info);
    if (anchorOk === 'missing') {
      return { ...operation, status: 'conflict', reason: 'add_anchor_missing' };
    }
    if (anchorOk === 'kind_changed') {
      return { ...operation, status: 'conflict', reason: 'add_anchor_kind_changed' };
    }
    return {
      ...operation,
      status: anchorOk === 'same' ? 'applied' : 'staleApplied',
    };
  }

  const targetOk = validateCurrentTarget(block, info);
  if (targetOk === 'missing') {
    if (operation.kind === 'delete_target' || operation.kind === 'delete_block') {
      return { ...operation, status: 'skipped', reason: 'delete_target_missing' };
    }
    return { ...operation, status: 'conflict', reason: 'target_path_unlocatable' };
  }
  if (targetOk === 'kind_changed') {
    return { ...operation, status: 'conflict', reason: 'target_kind_changed' };
  }
  if (targetOk === 'changed') {
    return { ...operation, status: 'conflict', reason: 'target_value_changed' };
  }
  return { ...operation, status: 'applied' };
}

type TargetValidation = 'same' | 'changed' | 'missing' | 'kind_changed';

function validateCurrentTarget(block: NoteBlock, info: TargetInfo): TargetValidation {
  if (info.kind === 'block') {
    return sha256(block) === info.blockHash ? 'same' : 'changed';
  }
  if (info.kind === 'mathExpression') {
    return validateMathExpression(block, info);
  }
  if (!Array.isArray(block.content)) {
    return 'missing';
  }
  const item = block.content[info.contentIndex];
  if (!isRecord(item)) {
    return 'missing';
  }
  if (item.type !== expectedInlineType(info.kind)) {
    return 'kind_changed';
  }
  if (info.kind === 'text') {
    return validateText(item, info);
  }
  if (info.kind === 'link') {
    return validateLink(item, info);
  }
  return validateInlineMath(item, info);
}

function expectedInlineType(kind: TargetInfo['kind']): string {
  if (kind === 'text') return 'text';
  if (kind === 'link') return 'link';
  if (kind === 'inlineMath') return 'inlineMath';
  return '';
}

function validateText(item: Record<string, unknown>, info: TextTargetInfo): TargetValidation {
  return sha256(typeof item.text === 'string' ? item.text : '') === info.textHash ? 'same' : 'changed';
}

function validateLink(item: Record<string, unknown>, info: LinkTargetInfo): TargetValidation {
  const hrefOk = sha256(typeof item.href === 'string' ? item.href : '') === info.hrefHash;
  const text = Array.isArray(item.content)
    ? item.content
        .map((child) => (isRecord(child) && typeof child.text === 'string' ? child.text : ''))
        .join('')
    : '';
  const textOk = sha256(text) === info.textHash;
  return hrefOk && textOk ? 'same' : 'changed';
}

function validateInlineMath(
  item: Record<string, unknown>,
  info: InlineMathTargetInfo,
): TargetValidation {
  const props = isRecord(item.props) ? item.props : {};
  return sha256(typeof props.expression === 'string' ? props.expression : '') === info.expressionHash
    ? 'same'
    : 'changed';
}

function validateMathExpression(
  block: NoteBlock,
  info: MathExpressionTargetInfo,
): TargetValidation {
  return sha256(typeof block.props.expression === 'string' ? block.props.expression : '') ===
    info.expressionHash
    ? 'same'
    : 'changed';
}
