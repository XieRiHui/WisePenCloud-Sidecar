import crypto from 'crypto';
import { NoteBlock, NoteInlineContent } from './types';

const AI_DIFF_INLINE_TYPES = new Set([
  'ai-diff',
  'ai-add',
  'ai-delete',
  'ai-link-add',
  'ai-link-delete',
]);

const AI_DIFF_PROP_TYPES = new Set(['edit', 'create', 'delete']);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function walkBlocks(blocks: NoteBlock[], visitor: (block: NoteBlock) => void): void {
  for (const block of blocks) {
    visitor(block);
    walkBlocks(block.children, visitor);
  }
}

export function flattenBlocks(blocks: NoteBlock[]): NoteBlock[] {
  const out: NoteBlock[] = [];
  walkBlocks(blocks, (block) => out.push(block));
  return out;
}

export function findBlockById(blocks: NoteBlock[], blockId: string): NoteBlock | undefined {
  return flattenBlocks(blocks).find((block) => block.id === blockId);
}

export function hasPendingAiDiff(block: NoteBlock): boolean {
  if (Object.prototype.hasOwnProperty.call(block, 'AI-content')) {
    return true;
  }
  if (hasPendingAiDiffInProps(block.props)) {
    return true;
  }
  if (Array.isArray(block.content) && hasPendingAiDiffInInlineContent(block.content)) {
    return true;
  }
  return block.children.some((child) => hasPendingAiDiff(child));
}

function hasPendingAiDiffInProps(props: unknown): boolean {
  if (!isRecord(props)) {
    return false;
  }
  const aiDiffType = props.aiDiffType;
  return typeof aiDiffType === 'string' && AI_DIFF_PROP_TYPES.has(aiDiffType);
}

function hasPendingAiDiffInInlineContent(content: unknown[]): boolean {
  for (const item of content) {
    if (!isRecord(item)) {
      continue;
    }
    const type = item.type;
    if (typeof type === 'string' && AI_DIFF_INLINE_TYPES.has(type)) {
      return true;
    }
    if (type === 'inlineMath' && hasPendingAiDiffInProps(item.props)) {
      return true;
    }
    if (type === 'link' && Array.isArray(item.content)) {
      if (hasPendingAiDiffInInlineContent(item.content)) {
        return true;
      }
    }
  }
  return false;
}

export function noteContentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content.map((item) => inlineToText(item as NoteInlineContent)).join('');
}

export function inlineToText(item: NoteInlineContent): string {
  if (item.type === 'text') {
    return getString(item.text);
  }
  if (item.type === 'link') {
    return Array.isArray(item.content)
      ? item.content.map((child) => inlineToText(child)).join('')
      : '';
  }
  if (item.type === 'inlineMath') {
    return getString(item.props?.expression);
  }
  return '';
}

export function makeAiDiffKey(exportHandle: string, opId: string, serial: number): string {
  return `${exportHandle}:${opId}:${serial}`;
}
