import {
  NoteBlock,
  NoteInlineContent,
  SkippedTargetSummary,
  TargetIndex,
  TargetInfo,
} from './types';
import { getString, isRecord, sha256 } from './utils';

const INLINE_BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'bulletListItem',
  'numberedListItem',
  'checkListItem',
  'quote',
  'toggleListItem',
]);

export type XmlSerializerResult = {
  aiXml: string;
  targetIndex: TargetIndex;
  idMapping: Record<string, string>;
  skippedTargets: SkippedTargetSummary[];
};

export function serializeNoteXml(
  blocks: NoteBlock[],
  initialSkippedTargets: SkippedTargetSummary[] = [],
): XmlSerializerResult {
  const state = {
    blockSerial: 0,
    targetIndex: { targets: {} } as TargetIndex,
    idMapping: {} as Record<string, string>,
    skippedTargets: [...initialSkippedTargets],
  };

  const body = blocks.map((block) => serializeBlock(block, state, 1)).join('\n');
  return {
    aiXml: `<note version="1">\n${body}\n</note>`,
    targetIndex: state.targetIndex,
    idMapping: state.idMapping,
    skippedTargets: state.skippedTargets,
  };
}

function serializeBlock(
  block: NoteBlock,
  state: {
    blockSerial: number;
    targetIndex: TargetIndex;
    idMapping: Record<string, string>;
    skippedTargets: SkippedTargetSummary[];
  },
  depth: number,
): string {
  const xmlBlockId = `b${++state.blockSerial}`;
  state.idMapping[xmlBlockId] = block.id;
  const blockHash = sha256(block);
  state.targetIndex.targets[xmlBlockId] = {
    xmlId: xmlBlockId,
    kind: 'block',
    blockId: block.id,
    blockType: block.type,
    blockHash,
  };

  const indent = '  '.repeat(depth);
  const childIndent = '  '.repeat(depth + 1);

  if (INLINE_BLOCK_TYPES.has(block.type)) {
    const counters = { text: 0, link: 0, math: 0 };
    const content = Array.isArray(block.content)
      ? block.content.map((item, index) =>
          serializeInlineContent(item as NoteInlineContent, index, xmlBlockId, block, blockHash, counters, state),
        )
      : block.content
        ? [
            serializeTextTarget(
              String(block.content),
              0,
              xmlBlockId,
              block,
              blockHash,
              ++counters.text,
              state,
            ),
          ]
        : [];
    const children = block.children.map((child) => serializeBlock(child, state, depth + 1));
    const inner = [...content, ...children].filter(Boolean).join('\n');
    return inner
      ? `${indent}<block id="${xmlBlockId}" type="${escapeXmlAttr(block.type)}">\n${inner}\n${indent}</block>`
      : `${indent}<block id="${xmlBlockId}" type="${escapeXmlAttr(block.type)}"></block>`;
  }

  if (block.type === 'math') {
    const expression = getString(block.props.expression);
    const targetId = `${xmlBlockId}:expr`;
    state.targetIndex.targets[targetId] = {
      xmlId: targetId,
      kind: 'mathExpression',
      blockId: block.id,
      blockType: block.type,
      blockHash,
      expression,
      expressionHash: sha256(expression),
    };
    const children = block.children.map((child) => serializeBlock(child, state, depth + 1));
    const expressionXml = `${childIndent}<math-expression id="${targetId}">${escapeXmlText(expression)}</math-expression>`;
    return `${indent}<block id="${xmlBlockId}" type="math">\n${[expressionXml, ...children].join('\n')}\n${indent}</block>`;
  }

  state.skippedTargets.push({
    xmlId: xmlBlockId,
    kind: 'block',
    reason: `unsupported_block_type:${block.type}`,
  });
  const children = block.children.map((child) => serializeBlock(child, state, depth + 1));
  return `${indent}<block id="${xmlBlockId}" type="${escapeXmlAttr(block.type)}">\n${children.join('\n')}\n${indent}</block>`;
}

function serializeInlineContent(
  item: NoteInlineContent,
  contentIndex: number,
  xmlBlockId: string,
  block: NoteBlock,
  blockHash: string,
  counters: { text: number; link: number; math: number },
  state: {
    targetIndex: TargetIndex;
    skippedTargets: SkippedTargetSummary[];
  },
): string {
  if (item.type === 'text') {
    return serializeTextTarget(
      getString(item.text),
      contentIndex,
      xmlBlockId,
      block,
      blockHash,
      ++counters.text,
      state,
    );
  }

  if (item.type === 'link') {
    const text = Array.isArray(item.content)
      ? item.content.map((child) => getString(child.text)).join('')
      : '';
    const href = getString(item.href);
    const targetId = `${xmlBlockId}:l${++counters.link}`;
    state.targetIndex.targets[targetId] = {
      xmlId: targetId,
      kind: 'link',
      blockId: block.id,
      blockType: block.type,
      blockHash,
      contentIndex,
      text,
      href,
      textHash: sha256(text),
      hrefHash: sha256(href),
    };
    return `    <link id="${targetId}" href="${escapeXmlAttr(href)}">${escapeXmlText(text)}</link>`;
  }

  if (item.type === 'inlineMath') {
    const props = isRecord(item.props) ? item.props : {};
    const expression = getString(props.expression);
    const targetId = `${xmlBlockId}:m${++counters.math}`;
    state.targetIndex.targets[targetId] = {
      xmlId: targetId,
      kind: 'inlineMath',
      blockId: block.id,
      blockType: block.type,
      blockHash,
      contentIndex,
      expression,
      expressionHash: sha256(expression),
    };
    return `    <inline-math id="${targetId}">${escapeXmlText(expression)}</inline-math>`;
  }

  state.skippedTargets.push({
    kind: 'inline',
    reason: `unsupported_inline_type:${item.type}`,
  });
  return '';
}

function serializeTextTarget(
  text: string,
  contentIndex: number,
  xmlBlockId: string,
  block: NoteBlock,
  blockHash: string,
  serial: number,
  state: {
    targetIndex: TargetIndex;
  },
): string {
  const targetId = `${xmlBlockId}:t${serial}`;
  state.targetIndex.targets[targetId] = {
    xmlId: targetId,
    kind: 'text',
    blockId: block.id,
    blockType: block.type,
    blockHash,
    contentIndex,
    text,
    textHash: sha256(text),
  };
  return `    <text id="${targetId}">${escapeXmlText(text)}</text>`;
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
