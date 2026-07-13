import { NoteXmlBundle, PatchOperation, TargetInfo } from './types';
import { getString, isRecord } from './utils';

const MAX_OPERATIONS = 200;
const MAX_TEXT_LENGTH = 20000;
const MAX_HREF_LENGTH = 2048;
const SUPPORTED_BLOCK_TYPES = new Set(['paragraph', 'heading', 'quote', 'bulletListItem', 'numberedListItem', 'math']);

export function parsePatchPlan(plan: unknown, bundle: NoteXmlBundle): PatchOperation[] {
  if (!isRecord(plan) || plan.version !== 1 || !Array.isArray(plan.operations)) {
    throw new Error('invalid_plan');
  }
  if (plan.operations.length > MAX_OPERATIONS) {
    throw new Error('invalid_plan');
  }
  const operations = plan.operations.map((operation) => parseOperation(operation, bundle));
  const opIds = new Set<string>();
  for (const operation of operations) {
    if (opIds.has(operation.opId)) {
      throw new Error('invalid_plan');
    }
    opIds.add(operation.opId);
  }
  return operations;
}

function parseOperation(raw: unknown, bundle: NoteXmlBundle): PatchOperation {
  if (!isRecord(raw)) {
    throw new Error('invalid_plan');
  }
  rejectProtectedFields(raw);

  const opId = requireNonEmptyString(raw.opId);
  const kind = requireNonEmptyString(raw.kind);

  switch (kind) {
    case 'replace_text': {
      const target = requireTarget(raw.target, bundle, 'text');
      return { opId, kind, target: target.xmlId, text: requireText(raw.text) };
    }
    case 'replace_link': {
      const target = requireTarget(raw.target, bundle, 'link');
      return {
        opId,
        kind,
        target: target.xmlId,
        text: requireText(raw.text),
        href: requireHref(raw.href),
      };
    }
    case 'replace_inline_math': {
      const target = requireTarget(raw.target, bundle, 'inlineMath');
      return { opId, kind, target: target.xmlId, expression: requireText(raw.expression) };
    }
    case 'replace_math_expression': {
      const target = requireTarget(raw.target, bundle, 'mathExpression');
      return { opId, kind, target: target.xmlId, expression: requireText(raw.expression) };
    }
    case 'add_text': {
      const anchor = requireAnchor(raw.anchor, bundle);
      return { opId, kind, anchor: anchor.xmlId, position: requirePosition(raw.position), text: requireText(raw.text) };
    }
    case 'add_link': {
      const anchor = requireAnchor(raw.anchor, bundle);
      return {
        opId,
        kind,
        anchor: anchor.xmlId,
        position: requirePosition(raw.position),
        text: requireText(raw.text),
        href: requireHref(raw.href),
      };
    }
    case 'add_inline_math': {
      const anchor = requireAnchor(raw.anchor, bundle);
      return {
        opId,
        kind,
        anchor: anchor.xmlId,
        position: requirePosition(raw.position),
        expression: requireText(raw.expression),
      };
    }
    case 'add_block': {
      const anchor = requireTarget(raw.anchor, bundle, 'block');
      const blockType = requireNonEmptyString(raw.blockType);
      if (!SUPPORTED_BLOCK_TYPES.has(blockType)) {
        throw new Error('invalid_plan');
      }
      const operation: PatchOperation = {
        opId,
        kind,
        anchor: anchor.xmlId,
        position: requirePosition(raw.position),
        blockType,
      };
      if (typeof raw.text === 'string') {
        operation.text = requireText(raw.text);
      }
      if (typeof raw.expression === 'string') {
        operation.expression = requireText(raw.expression);
      }
      return operation;
    }
    case 'delete_target': {
      const target = requireTarget(raw.target, bundle);
      if (target.kind === 'block') {
        throw new Error('invalid_plan');
      }
      return { opId, kind, target: target.xmlId };
    }
    case 'delete_block': {
      const target = requireTarget(raw.target, bundle, 'block');
      return { opId, kind, target: target.xmlId };
    }
    default:
      throw new Error('invalid_plan');
  }
}

function rejectProtectedFields(operation: Record<string, unknown>): void {
  const protectedFields = ['blockId', 'path', 'hash', 'props', 'styles', 'contentIndex', 'itemPath'];
  for (const field of protectedFields) {
    if (field in operation) {
      throw new Error('invalid_plan');
    }
  }
}

function requireTarget(value: unknown, bundle: NoteXmlBundle, kind?: TargetInfo['kind']): TargetInfo {
  const targetId = requireNonEmptyString(value);
  const target = bundle.targetIndex.targets[targetId];
  if (!target || (kind && target.kind !== kind)) {
    throw new Error('invalid_plan');
  }
  return target;
}

function requireAnchor(value: unknown, bundle: NoteXmlBundle): TargetInfo {
  const anchor = requireTarget(value, bundle);
  if (anchor.kind === 'block' || anchor.kind === 'mathExpression') {
    throw new Error('invalid_plan');
  }
  return anchor;
}

function requireNonEmptyString(value: unknown): string {
  const text = getString(value).trim();
  if (!text) {
    throw new Error('invalid_plan');
  }
  return text;
}

function requireText(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) {
    throw new Error('invalid_plan');
  }
  return value;
}

function requireHref(value: unknown): string {
  const href = requireText(value);
  if (href.length > MAX_HREF_LENGTH) {
    throw new Error('invalid_plan');
  }
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    throw new Error('invalid_plan');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('invalid_plan');
  }
  return href;
}

function requirePosition(value: unknown): 'before' | 'after' {
  if (value === 'before' || value === 'after') {
    return value;
  }
  throw new Error('invalid_plan');
}
