import crypto from 'crypto';

import { Room } from '../types';
import {
  insertBlockContainerSync,
  replaceBlockContainerSync,
} from './blockNoteYDocAdapter';
import {
  ClassifiedApplyOperation,
  InlineMathTargetInfo,
  LinkTargetInfo,
  MathExpressionTargetInfo,
  NoteBlock,
  NoteInlineContent,
  TextTargetInfo,
} from './types';
import { deepClone, findBlockById, inlineToText, isRecord, makeAiDiffKey } from './utils';
import { buildAiEditJsonUnits } from './wordDiff';

export type ReviewContentWriteOptions = {
  selectedText?: string;
  selectedTextBoundary?: boolean;
};

type TextInlineContent = NoteInlineContent & { type: 'text'; text: string };

export function writeReviewContentSync(
  room: Room,
  currentBlocks: NoteBlock[],
  operations: ClassifiedApplyOperation[],
  exportHandle: string,
  options: ReviewContentWriteOptions = {},
): void {
  const dirtyBlocks = new Map<string, NoteBlock>();

  const getWritableBlock = (blockId: string): NoteBlock | undefined => {
    const existing = dirtyBlocks.get(blockId);
    if (existing) {
      return existing;
    }
    const source = findBlockById(currentBlocks, blockId);
    if (!source) {
      return undefined;
    }
    const next = deepClone(source);
    dirtyBlocks.set(blockId, next);
    return next;
  };

  for (const operation of operations) {
    if (operation.status !== 'applied' && operation.status !== 'staleApplied') {
      continue;
    }
    if (operation.kind === 'add_block') {
      const anchorInfo = operation.anchorInfo;
      if (!anchorInfo) continue;
      insertBlockContainerSync(
        room,
        anchorInfo.blockId,
        operation.position,
        materializeReviewBlock(buildReviewBlock(operation), exportHandle),
      );
      continue;
    }

    const info = operation.targetInfo ?? operation.anchorInfo;
    if (!info) continue;
    const nextBlock = getWritableBlock(info.blockId);
    if (!nextBlock) continue;

    switch (operation.kind) {
      case 'replace_text':
        replaceText(nextBlock, operation.targetInfo as TextTargetInfo, operation.text, options);
        break;
      case 'replace_link':
        replaceLink(nextBlock, operation.targetInfo as LinkTargetInfo, operation.text, operation.href);
        break;
      case 'replace_inline_math':
        replaceInlineMath(nextBlock, operation.targetInfo as InlineMathTargetInfo, operation.expression);
        break;
      case 'replace_math_expression':
        replaceMathExpression(nextBlock, operation.targetInfo as MathExpressionTargetInfo, operation.expression);
        break;
      case 'add_text':
        addInline(nextBlock, operation.anchorInfo, operation.position, textInline(operation.text));
        break;
      case 'add_link':
        addInline(nextBlock, operation.anchorInfo, operation.position, linkInline(operation.text, operation.href));
        break;
      case 'add_inline_math':
        addInline(nextBlock, operation.anchorInfo, operation.position, inlineMath(operation.expression));
        break;
      case 'delete_target':
        deleteTarget(nextBlock, operation.targetInfo);
        break;
      case 'delete_block':
        deleteReviewBlock(nextBlock);
        break;
      default:
        continue;
    }
  }

  for (const block of dirtyBlocks.values()) {
    normalizeBlockAiContentForSelectedBoundary(block, options);
    replaceBlockContainerSync(room, materializeReviewBlock(block, exportHandle));
  }
}

function replaceText(
  block: NoteBlock,
  info: TextTargetInfo,
  replace: string,
  options: ReviewContentWriteOptions,
): void {
  const content = ensureAiContent(block);
  const current = content[info.contentIndex];
  content[info.contentIndex] = textInline(
    normalizeSelectedTextReplacement(info.text, replace, options),
    inlineStyles(current),
  );
}

function replaceLink(
  block: NoteBlock,
  info: LinkTargetInfo,
  text: string,
  href: string,
): void {
  const content = ensureAiContent(block);
  content[info.contentIndex] = linkInline(text, href, linkStyles(content[info.contentIndex]));
}

function replaceInlineMath(
  block: NoteBlock,
  info: InlineMathTargetInfo,
  replace: string,
): void {
  const content = ensureAiContent(block);
  const current: Record<string, unknown> = isRecord(content[info.contentIndex])
    ? (content[info.contentIndex] as Record<string, unknown>)
    : {};
  content[info.contentIndex] = {
    ...current,
    type: 'inlineMath',
    props: {
      ...(isRecord(current.props) ? current.props : {}),
      expression: replace || info.expression,
      autoOpenEdit: false,
    },
  };
}

function replaceMathExpression(
  block: NoteBlock,
  info: MathExpressionTargetInfo,
  replace: string,
): void {
  block['AI-content'] = [textInline(replace || info.expression)];
}

function addInline(
  block: NoteBlock,
  info: ClassifiedApplyOperation['anchorInfo'],
  position: 'before' | 'after',
  node: NoteInlineContent,
): void {
  if (!info || info.kind === 'block' || info.kind === 'mathExpression') {
    return;
  }
  const content = ensureAiContent(block);
  const index = position === 'before' ? info.contentIndex : info.contentIndex + 1;
  content.splice(index, 0, node);
}

function deleteTarget(
  block: NoteBlock,
  info: ClassifiedApplyOperation['targetInfo'],
): void {
  if (!info) return;
  if (info.kind === 'text' || info.kind === 'link' || info.kind === 'inlineMath') {
    ensureAiContent(block).splice(info.contentIndex, 1);
  } else if (info.kind === 'mathExpression') {
    block['AI-content'] = [];
  }
}

function deleteReviewBlock(block: NoteBlock): void {
  block['AI-content'] = [];
}

function buildReviewBlock(
  operation: Extract<ClassifiedApplyOperation, { kind: 'add_block' }>,
): NoteBlock {
  const id = `ai_${crypto.randomBytes(8).toString('hex')}`;
  if (operation.blockType === 'math') {
    const expression = operation.expression ?? operation.text ?? '';
    return {
      id,
      type: 'math',
      props: {
        expression,
        autoEdit: false,
        ...(expression
          ? {
              aiDiffType: 'create',
              aiDiffKey: `${id}:math`,
              aiDiffOrigin: '',
              aiDiffReplace: expression,
            }
          : {}),
      },
      content: [],
      'AI-content': expression ? [textInline(expression)] : [],
      children: [],
    };
  }
  return {
    id,
    type: operation.blockType,
    props: defaultInlineBlockProps(operation.blockType),
    content: [],
    'AI-content': operation.text ? [textInline(operation.text)] : [],
    children: [],
  };
}

function materializeReviewBlock(block: NoteBlock, exportHandle: string): NoteBlock {
  const next = deepClone(block);
  if (!Object.prototype.hasOwnProperty.call(next, 'AI-content')) {
    return next;
  }

  const aiContent = Array.isArray(next['AI-content']) ? next['AI-content'] : [];
  if (next.type === 'math') {
    next.props = materializeMathProps(next, aiContent, exportHandle);
    delete next['AI-content'];
    return next;
  }

  const originalContent = ensureInlineContent(next);
  next.content = materializeInlineDiffContent(
    originalContent,
    aiContent as NoteInlineContent[],
    exportHandle,
    next.id,
  );
  delete next['AI-content'];
  return next;
}

function materializeMathProps(
  block: NoteBlock,
  aiContent: unknown[],
  exportHandle: string,
): Record<string, unknown> {
  const existingAiDiffType = String(block.props.aiDiffType ?? '');
  if (existingAiDiffType === 'edit' || existingAiDiffType === 'create' || existingAiDiffType === 'delete') {
    return block.props;
  }

  const origin = String(block.props.expression ?? inlineListToText(ensureInlineContent(block)));
  const replace = inlineListToText(aiContent as NoteInlineContent[]);
  const key = makeAiDiffKey(exportHandle, block.id, 1);
  if (!origin && replace) {
    return {
      ...block.props,
      expression: replace,
      aiDiffType: 'create',
      aiDiffKey: key,
      aiDiffOrigin: '',
      aiDiffReplace: replace,
    };
  }
  if (origin && !replace) {
    return {
      ...block.props,
      expression: origin,
      aiDiffType: 'delete',
      aiDiffKey: key,
      aiDiffOrigin: origin,
      aiDiffReplace: '',
    };
  }
  return {
    ...block.props,
    expression: replace || origin,
    aiDiffType: 'edit',
    aiDiffKey: key,
    aiDiffOrigin: origin,
    aiDiffReplace: replace,
  };
}

function materializeInlineDiffContent(
  originalContent: NoteInlineContent[],
  aiContent: NoteInlineContent[],
  exportHandle: string,
  blockId: string,
): NoteInlineContent[] {
  const keyFactory = createBlockKeyFactory(exportHandle, blockId);
  if (areInlineListsEqual(originalContent, aiContent)) {
    return deepClone(aiContent);
  }
  if (isTextOnlyList(originalContent) && isTextOnlyList(aiContent)) {
    return materializeTextEdit(
      inlineListToText(originalContent),
      inlineListToText(aiContent),
      mergeTextStyles(originalContent, aiContent),
      keyFactory,
    );
  }

  const prefixLength = commonPrefixLength(originalContent, aiContent, areInlineItemsEqual);
  const suffixLength = commonSuffixLength(
    originalContent,
    aiContent,
    prefixLength,
    areInlineItemsEqual,
  );
  const oldMiddle = originalContent.slice(prefixLength, originalContent.length - suffixLength);
  const newMiddle = aiContent.slice(prefixLength, aiContent.length - suffixLength);
  const materializedMiddle =
    oldMiddle.length === newMiddle.length
      ? oldMiddle.flatMap((item, index) => materializeEditInlinePair(item, newMiddle[index], keyFactory))
      : [
          ...oldMiddle.flatMap((item) => materializeDeleteInline(item, keyFactory)),
          ...newMiddle.flatMap((item) => materializeCreateInline(item, keyFactory)),
        ];

  return mergeAdjacentText([
    ...deepClone(aiContent.slice(0, prefixLength)),
    ...materializedMiddle,
    ...deepClone(aiContent.slice(aiContent.length - suffixLength)),
  ]);
}

function createBlockKeyFactory(exportHandle: string, blockId: string): () => string {
  let serial = 0;
  return () => makeAiDiffKey(exportHandle, blockId, ++serial);
}

function materializeTextEdit(
  origin: string,
  replace: string,
  styles: Record<string, unknown>,
  nextKey: () => string,
): NoteInlineContent[] {
  if (origin === replace) {
    return origin ? [textInline(origin, styles)] : [];
  }

  const out: NoteInlineContent[] = [];
  for (const unit of buildAiEditJsonUnits(origin, replace)) {
    if (unit.type === 'plain') {
      if (unit.text) out.push(textInline(unit.text, styles));
      continue;
    }
    if (unit.origin && unit.replace) {
      out.push({
        type: 'ai-diff',
        props: {
          origin: unit.origin,
          replace: unit.replace,
          key: nextKey(),
          granularity: 'word',
        },
      });
    } else if (unit.replace) {
      out.push({ type: 'ai-add', props: { text: unit.replace, key: nextKey() } });
    } else if (unit.origin) {
      out.push({ type: 'ai-delete', props: { text: unit.origin, key: nextKey() } });
    }
  }

  return out;
}

function materializeCreateInline(
  item: NoteInlineContent,
  nextKey: () => string,
): NoteInlineContent[] {
  if (item.type === 'text') {
    return item.text ? [{ type: 'ai-add', props: { text: item.text, key: nextKey() } }] : [];
  }
  if (item.type === 'link') {
    const content = normalizeLinkContent(item.content);
    return [
      {
        type: 'ai-link-add',
        props: {
          text: inlineListToText(content),
          href: item.href ?? '',
          content: JSON.stringify(content),
          key: nextKey(),
        },
      },
    ];
  }
  if (item.type === 'inlineMath') {
    const expression = String(item.props?.expression ?? '');
    return [
      {
        ...deepClone(item),
        props: {
          ...(item.props ?? {}),
          expression,
          autoOpenEdit: false,
          aiDiffType: 'create',
          aiDiffKey: nextKey(),
          aiDiffOrigin: '',
          aiDiffReplace: expression,
        },
      },
    ];
  }
  return deepClone([item]);
}

function materializeEditInlinePair(
  origin: NoteInlineContent,
  replace: NoteInlineContent | undefined,
  nextKey: () => string,
): NoteInlineContent[] {
  if (!replace) return materializeDeleteInline(origin, nextKey);
  if (areInlineItemsEqual(origin, replace)) return deepClone([replace]);
  if (origin.type === 'text' && replace.type === 'text') {
    return materializeTextEdit(
      origin.text ?? '',
      replace.text ?? '',
      { ...(origin.styles ?? {}), ...(replace.styles ?? {}) },
      nextKey,
    );
  }
  if (origin.type === 'inlineMath' && replace.type === 'inlineMath') {
    const originExpression = String(origin.props?.expression ?? '');
    const replaceExpression = String(replace.props?.expression ?? '');
    return [
      {
        ...deepClone(replace),
        props: {
          ...(replace.props ?? {}),
          expression: replaceExpression || originExpression,
          autoOpenEdit: false,
          aiDiffType: 'edit',
          aiDiffKey: nextKey(),
          aiDiffOrigin: originExpression,
          aiDiffReplace: replaceExpression,
        },
      },
    ];
  }
  return [
    ...materializeDeleteInline(origin, nextKey),
    ...materializeCreateInline(replace, nextKey),
  ];
}

function materializeDeleteInline(
  item: NoteInlineContent,
  nextKey: () => string,
): NoteInlineContent[] {
  if (item.type === 'text') {
    return item.text ? [{ type: 'ai-delete', props: { text: item.text, key: nextKey() } }] : [];
  }
  if (item.type === 'link') {
    const content = normalizeLinkContent(item.content);
    return [
      {
        type: 'ai-link-delete',
        props: {
          text: inlineListToText(content),
          href: item.href ?? '',
          content: JSON.stringify(content),
          key: nextKey(),
        },
      },
    ];
  }
  if (item.type === 'inlineMath') {
    const expression = String(item.props?.expression ?? '');
    return [
      {
        ...deepClone(item),
        props: {
          ...(item.props ?? {}),
          expression,
          autoOpenEdit: false,
          aiDiffType: 'delete',
          aiDiffKey: nextKey(),
          aiDiffOrigin: expression,
          aiDiffReplace: '',
        },
      },
    ];
  }
  return deepClone([item]);
}

function normalizeLinkContent(content: NoteInlineContent[] | undefined): NoteInlineContent[] {
  return Array.isArray(content) ? deepClone(content) : [];
}

function inlineListToText(content: NoteInlineContent[]): string {
  return content.map((item) => inlineToText(item)).join('');
}

function isTextOnlyList(content: NoteInlineContent[]): boolean {
  return content.every((item) => item.type === 'text');
}

function mergeTextStyles(
  originalContent: NoteInlineContent[],
  aiContent: NoteInlineContent[],
): Record<string, unknown> {
  const source = [...aiContent, ...originalContent].find((item) => item.type === 'text');
  return isRecord(source?.styles) ? (source?.styles ?? {}) : {};
}

function areInlineListsEqual(a: NoteInlineContent[], b: NoteInlineContent[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => areInlineItemsEqual(item, b[index]));
}

function areInlineItemsEqual(a: NoteInlineContent, b: NoteInlineContent | undefined): boolean {
  if (!b) return false;
  return JSON.stringify(normalizeInlineItem(a)) === JSON.stringify(normalizeInlineItem(b));
}

function normalizeInlineItem(item: NoteInlineContent): unknown {
  if (item.type === 'text') {
    return { type: 'text', text: item.text ?? '', styles: item.styles ?? {} };
  }
  if (item.type === 'inlineMath') {
    return {
      type: 'inlineMath',
      expression: String(item.props?.expression ?? ''),
      autoOpenEdit: Boolean(item.props?.autoOpenEdit),
    };
  }
  if (item.type === 'link') {
    return {
      type: 'link',
      href: item.href ?? '',
      content: normalizeLinkContent(item.content),
    };
  }
  return item;
}

function commonPrefixLength<T>(
  a: T[],
  b: T[],
  equals: (left: T, right: T | undefined) => boolean,
): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && equals(a[index], b[index])) index += 1;
  return index;
}

function commonSuffixLength<T>(
  a: T[],
  b: T[],
  prefixLength: number,
  equals: (left: T, right: T | undefined) => boolean,
): number {
  const limit = Math.min(a.length, b.length) - prefixLength;
  let count = 0;
  while (count < limit && equals(a[a.length - 1 - count], b[b.length - 1 - count])) {
    count += 1;
  }
  return count;
}

function mergeAdjacentText(content: NoteInlineContent[]): NoteInlineContent[] {
  const out: NoteInlineContent[] = [];
  for (const item of content) {
    const last = out[out.length - 1];
    if (
      item.type === 'text' &&
      last?.type === 'text' &&
      JSON.stringify(last.styles ?? {}) === JSON.stringify(item.styles ?? {})
    ) {
      last.text = `${last.text ?? ''}${item.text ?? ''}`;
      continue;
    }
    out.push(item);
  }
  return out;
}

function ensureAiContent(block: NoteBlock): NoteInlineContent[] {
  if (!Array.isArray(block['AI-content'])) {
    block['AI-content'] = deepClone(ensureInlineContent(block));
  }
  return block['AI-content'] as NoteInlineContent[];
}

function ensureInlineContent(block: NoteBlock): NoteInlineContent[] {
  if (Array.isArray(block.content)) {
    return block.content as NoteInlineContent[];
  }
  const text = typeof block.content === 'string' ? block.content : '';
  block.content = text ? [{ type: 'text', text, styles: {} }] : [];
  return block.content as NoteInlineContent[];
}

function normalizeBlockAiContentForSelectedBoundary(
  block: NoteBlock,
  options: ReviewContentWriteOptions,
): void {
  if (!options.selectedTextBoundary) {
    return;
  }

  const originalContent = asTextOnlyInlineContent(ensureInlineContent(block));
  const aiContent = asTextOnlyInlineContent(block['AI-content']);
  if (!originalContent || !aiContent) {
    return;
  }

  const originalText = originalContent.map((item) => item.text).join('');
  const aiText = aiContent.map((item) => item.text).join('');
  const normalizedText = normalizeSelectedTextReplacement(originalText, aiText, options);
  if (normalizedText === aiText || !normalizedText.trim()) {
    return;
  }

  block['AI-content'] = [textInline(normalizedText, inlineStyles(aiContent[0]))];
}

function asTextOnlyInlineContent(content: unknown): TextInlineContent[] | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const textItems: TextInlineContent[] = [];
  for (const item of content) {
    if (!isRecord(item) || item.type !== 'text' || typeof item.text !== 'string') {
      return null;
    }
    textItems.push(item as TextInlineContent);
  }
  return textItems;
}

function textInline(text: string, styles: Record<string, unknown> = {}): NoteInlineContent {
  return { type: 'text', text, styles };
}

function linkInline(
  text: string,
  href: string,
  styles: Record<string, unknown> = {},
): NoteInlineContent {
  return { type: 'link', href, content: [textInline(text, styles)] };
}

function inlineMath(expression: string): NoteInlineContent {
  return {
    type: 'inlineMath',
    props: {
      expression,
      autoOpenEdit: false,
    },
  };
}

function inlineStyles(item: NoteInlineContent | undefined): Record<string, unknown> {
  return isRecord(item?.styles) ? item.styles : {};
}

function linkStyles(item: NoteInlineContent | undefined): Record<string, unknown> {
  if (!Array.isArray(item?.content)) {
    return {};
  }
  return inlineStyles(item.content[0]);
}

function defaultInlineBlockProps(type: string): Record<string, unknown> {
  if (type === 'heading') {
    return { level: 1, backgroundColor: 'default', textColor: 'default', textAlignment: 'left' };
  }
  return { backgroundColor: 'default', textColor: 'default', textAlignment: 'left' };
}

function normalizeSelectedTextReplacement(
  originalTargetText: string,
  replacementText: string,
  options: ReviewContentWriteOptions,
): string {
  if (!options.selectedTextBoundary) {
    return replacementText;
  }

  const selectedText = (options.selectedText ?? '').trim();
  if (selectedText.length < 8) {
    return replacementText;
  }

  const span = resolveSelectedSpan(originalTargetText, selectedText);
  if (!span) {
    return replacementText;
  }

  const { prefix, selected, suffix } = span;
  const afterPrefix = replacementText.startsWith(prefix)
    ? replacementText.slice(prefix.length)
    : replacementText;
  if (!suffix) {
    const cleaned = cleanExactBoundaryMiddle(afterPrefix, selected);
    return !cleaned.trim() ? replacementText : `${prefix}${cleaned}`;
  }

  if (afterPrefix.endsWith(suffix)) {
    const middleEnd = afterPrefix.length - suffix.length;
    const middle = afterPrefix.slice(0, middleEnd);
    const cleaned = cleanExactBoundaryMiddle(middle, selected, suffix);
    return !cleaned.trim() ? replacementText : `${prefix}${cleaned}${suffix}`;
  }

  const suffixIndex = afterPrefix.lastIndexOf(suffix);
  if (suffixIndex < 0) {
    const cleaned = cleanExactBoundaryMiddle(afterPrefix, selected);
    return !cleaned.trim() ? replacementText : `${prefix}${cleaned}${suffix}`;
  }

  const middle = afterPrefix.slice(0, suffixIndex);
  const trailing = afterPrefix.slice(suffixIndex + suffix.length);
  const cleanedMiddle = cleanExactBoundaryMiddle(middle, selected, suffix);
  const cleanedTrailing = cleanExactBoundaryMiddle(trailing, selected);
  if (
    cleanedMiddle.trim() &&
    cleanedTrailing.trim() &&
    areDuplicateReplacementTexts(cleanedMiddle, cleanedTrailing)
  ) {
    return `${prefix}${cleanedMiddle}${suffix}`;
  }
  if (isDuplicatedBoundarySuffix(trailing, suffix)) {
    return `${prefix}${cleanedMiddle}${suffix}`;
  }
  if (isSelectedTextDuplicate(trailing, selected)) {
    return `${prefix}${cleanedMiddle}${suffix}`;
  }

  return replacementText;
}

function cleanExactBoundaryMiddle(candidate: string, selected: string, suffix = ''): string {
  const withoutSelected = stripDuplicatedSelectedText(candidate, selected);
  const withoutRepeatedReplacement = stripDuplicatedReplacementText(withoutSelected);
  const withoutDuplicatedSuffix = stripDuplicatedBoundarySuffix(
    withoutRepeatedReplacement,
    suffix,
  );
  const withoutBoundaryOverrun = stripTranslatedBoundaryOverrun(
    withoutDuplicatedSuffix,
    selected,
    suffix,
  );
  return stripDuplicatedSelectedText(withoutBoundaryOverrun, selected);
}

function stripDuplicatedReplacementText(candidate: string): string {
  const normalizedCandidate = replacementComparableText(candidate);
  if (normalizedCandidate.length < 8) {
    return candidate;
  }

  for (let split = candidate.length - 1; split > 0; split -= 1) {
    const rightStart = skipReplacementSeparators(candidate, split);
    if (rightStart >= candidate.length) {
      continue;
    }

    const left = candidate.slice(0, split);
    const right = candidate.slice(rightStart);
    if (areDuplicateReplacementTexts(left, right)) {
      return trimTrailingWhitespace(left);
    }
  }

  return candidate;
}

function areDuplicateReplacementTexts(left: string, right: string): boolean {
  const normalizedLeft = replacementComparableText(left);
  if (normalizedLeft.length < 8) {
    return false;
  }
  return normalizedLeft === replacementComparableText(right);
}

function replacementComparableText(value: string): string {
  return trimReplacementSeparators(value)
    .replace(/\s+([.,;:!?\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

function isSelectedTextDuplicate(candidate: string, selected: string): boolean {
  const comparableCandidate = replacementComparableText(candidate);
  if (comparableCandidate.length < 8) {
    return false;
  }
  return Array.from(new Set([selected, selected.trim()]))
    .filter((value) => value.length >= 8)
    .some((value) => comparableCandidate === replacementComparableText(value));
}

function skipReplacementSeparators(value: string, start: number): number {
  let index = start;
  while (index < value.length && isReplacementSeparator(value[index])) {
    index += 1;
  }
  return index;
}

function trimReplacementSeparators(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isReplacementSeparator(value[start])) {
    start += 1;
  }
  while (end > start && isReplacementSeparator(value[end - 1])) {
    end -= 1;
  }
  return value.slice(start, end);
}

function isReplacementSeparator(char: string): boolean {
  if (/[\s\u00a0]/.test(char)) {
    return true;
  }
  if (".,;:!?".includes(char)) {
    return true;
  }
  return [0xff0c, 0x3002, 0xff1b, 0xff1a, 0xff01, 0xff1f, 0x3001].includes(
    char.charCodeAt(0),
  );
}

function trimTrailingWhitespace(value: string): string {
  return value.replace(/[\s\u00a0]+$/, '');
}

function trimLeadingReplacementSeparator(value: string): string {
  let start = 0;
  while (start < value.length && isReplacementSeparator(value[start])) {
    start += 1;
  }
  return value.slice(start);
}

function trimTrailingReplacementSeparator(value: string): string {
  let end = value.length;
  while (end > 0 && isReplacementSeparator(value[end - 1])) {
    end -= 1;
  }
  return value.slice(0, end);
}

function stripDuplicatedSelectedText(candidate: string, selected: string): string {
  const variants = Array.from(new Set([selected, selected.trim()])).filter((value) => value.length >= 8);
  for (const variant of variants) {
    if (candidate === variant) {
      continue;
    }
    if (candidate.startsWith(variant)) {
      const rest = trimLeadingReplacementSeparator(candidate.slice(variant.length));
      if (rest.trim()) {
        return rest;
      }
    }
    if (candidate.endsWith(variant)) {
      const rest = trimTrailingReplacementSeparator(candidate.slice(0, -variant.length));
      if (rest.trim()) {
        return rest;
      }
    }
  }
  return candidate;
}

function stripDuplicatedBoundarySuffix(candidate: string, suffix: string): string {
  const variants = Array.from(new Set([suffix, suffix.trim()])).filter(
    (value) => replacementComparableText(value).length >= 16,
  );
  for (const variant of variants) {
    const suffixStart = findComparableTrailingBoundaryStart(candidate, variant);
    if (suffixStart <= 0) {
      continue;
    }
    const rest = trimTrailingReplacementSeparator(candidate.slice(0, suffixStart));
    if (rest.trim()) {
      return rest;
    }
  }
  return candidate;
}

function stripTranslatedBoundaryOverrun(
  candidate: string,
  selected: string,
  suffix: string,
): string {
  if (!suffix) {
    return candidate;
  }

  const tailStart = findDuplicatedBoundaryTailStart(candidate, suffix);
  if (tailStart <= 0) {
    return candidate;
  }

  const beforeTail = trimTrailingReplacementSeparator(candidate.slice(0, tailStart));
  if (!beforeTail.trim()) {
    return candidate;
  }

  const selectedBoundaryEnd = findSelectedTranslationBoundaryEnd(beforeTail, selected);
  if (selectedBoundaryEnd > 0) {
    const selectedOnly = trimTrailingWhitespace(beforeTail.slice(0, selectedBoundaryEnd));
    if (selectedOnly.trim()) {
      return selectedOnly;
    }
  }

  return beforeTail;
}

function findDuplicatedBoundaryTailStart(candidate: string, suffix: string): number {
  const trimmedSuffix = suffix.trim();
  const minComparableLength = 24;
  if (replacementComparableText(trimmedSuffix).length < minComparableLength) {
    return -1;
  }

  for (let start = 1; start < trimmedSuffix.length; start += 1) {
    const fragment = trimmedSuffix.slice(start);
    if (replacementComparableText(fragment).length < minComparableLength) {
      break;
    }
    const matchStart = findComparableTrailingBoundaryStart(candidate, fragment);
    if (matchStart > 0) {
      return matchStart;
    }
  }

  return -1;
}

function findSelectedTranslationBoundaryEnd(candidate: string, selected: string): number {
  const terminal = selected.trim().at(-1);
  const equivalents = terminal ? equivalentBoundaryChars(terminal) : [];
  if (equivalents.length === 0) {
    return -1;
  }

  for (let index = candidate.length - 1; index >= 0; index -= 1) {
    if (equivalents.includes(candidate[index])) {
      return index + 1;
    }
  }

  return -1;
}

function equivalentBoundaryChars(char: string): string[] {
  if (char === ',' || char === '，') return [',', '，'];
  if (char === '.' || char === '。') return ['.', '。'];
  if (char === ';' || char === '；') return [';', '；'];
  if (char === ':' || char === '：') return [':', '：'];
  if (char === '?' || char === '？') return ['?', '？'];
  if (char === '!' || char === '！') return ['!', '！'];
  return [];
}

function isDuplicatedBoundarySuffix(candidate: string, suffix: string): boolean {
  const comparableCandidate = replacementComparableText(candidate);
  if (comparableCandidate.length < 16) {
    return false;
  }
  return Array.from(new Set([suffix, suffix.trim()]))
    .filter((value) => replacementComparableText(value).length >= 16)
    .some((value) => comparableCandidate === replacementComparableText(value));
}

function findComparableTrailingBoundaryStart(candidate: string, boundary: string): number {
  if (candidate.endsWith(boundary)) {
    return candidate.length - boundary.length;
  }

  const comparableBoundary = replacementComparableText(boundary);
  const minStart = Math.max(0, candidate.length - boundary.length - 32);
  for (let start = minStart; start < candidate.length; start += 1) {
    if (replacementComparableText(candidate.slice(start)) === comparableBoundary) {
      return start;
    }
  }
  return -1;
}

function resolveSelectedSpan(
  originalTargetText: string,
  selectedText: string,
): { prefix: string; selected: string; suffix: string } | null {
  const exactIndex = originalTargetText.indexOf(selectedText);
  if (exactIndex >= 0) {
    return {
      prefix: originalTargetText.slice(0, exactIndex),
      selected: selectedText,
      suffix: originalTargetText.slice(exactIndex + selectedText.length),
    };
  }

  const trimmedSelected = selectedText.trim();
  if (trimmedSelected !== selectedText) {
    const trimmedIndex = originalTargetText.indexOf(trimmedSelected);
    if (trimmedIndex >= 0) {
      return {
        prefix: originalTargetText.slice(0, trimmedIndex),
        selected: trimmedSelected,
        suffix: originalTargetText.slice(trimmedIndex + trimmedSelected.length),
      };
    }
  }

  const trimmedOriginal = originalTargetText.trim();
  if (!trimmedOriginal || !selectedText.includes(trimmedOriginal)) {
    return resolveOverlappingSelectedSpan(originalTargetText, selectedText);
  }

  const originalIndex = originalTargetText.indexOf(trimmedOriginal);
  return {
    prefix: originalTargetText.slice(0, originalIndex),
    selected: trimmedOriginal,
    suffix: originalTargetText.slice(originalIndex + trimmedOriginal.length),
  };
}

function resolveOverlappingSelectedSpan(
  originalTargetText: string,
  selectedText: string,
): { prefix: string; selected: string; suffix: string } | null {
  const normalizedSelected = selectedText.trim();
  if (normalizedSelected.length < 8) {
    return null;
  }

  const suffixPrefixLength = findLongestSuffixPrefixOverlap(
    originalTargetText,
    normalizedSelected,
  );
  const prefixSuffixLength = findLongestPrefixSuffixOverlap(
    originalTargetText,
    normalizedSelected,
  );
  const overlap =
    suffixPrefixLength >= prefixSuffixLength
      ? {
          originalStart: originalTargetText.length - suffixPrefixLength,
          originalEnd: originalTargetText.length,
          length: suffixPrefixLength,
        }
      : {
          originalStart: 0,
          originalEnd: prefixSuffixLength,
          length: prefixSuffixLength,
        };

  if (overlap.length < Math.min(12, normalizedSelected.length)) {
    return null;
  }

  const selected = originalTargetText.slice(overlap.originalStart, overlap.originalEnd);
  if (!selected.trim()) {
    return null;
  }
  return {
    prefix: originalTargetText.slice(0, overlap.originalStart),
    selected,
    suffix: originalTargetText.slice(overlap.originalEnd),
  };
}

function findLongestSuffixPrefixOverlap(
  left: string,
  right: string,
): number {
  const maxLength = Math.min(left.length, right.length);
  for (let length = maxLength; length >= 1; length -= 1) {
    if (left.slice(left.length - length) === right.slice(0, length)) {
      return length;
    }
  }
  return 0;
}

function findLongestPrefixSuffixOverlap(
  left: string,
  right: string,
): number {
  const maxLength = Math.min(left.length, right.length);
  for (let length = maxLength; length >= 1; length -= 1) {
    if (left.slice(0, length) === right.slice(right.length - length)) {
      return length;
    }
  }
  return 0;
}
