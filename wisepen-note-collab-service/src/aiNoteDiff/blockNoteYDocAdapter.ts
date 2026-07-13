import * as Y from 'yjs';

import { Room } from '../types';
import { NoteBlock, NoteInlineContent } from './types';
import { findBlockById, isRecord } from './utils';

const DOCUMENT_STORE_FRAGMENT = 'document-store';
const ROOT_GROUP_NODE = 'blockGroup';
const BLOCK_CONTAINER_NODE = 'blockContainer';
const AI_CONTENT_STORE_MAP = 'ai-content-store';
const AI_CONTENT_NODE = 'AI-content';
const LINK_TARGET = '_blank';
const LINK_REL = 'noopener noreferrer nofollow';

const INLINE_ELEMENT_TYPES = new Map<string, string>([
  ['inlinemath', 'inlineMath'],
  ['ai-diff', 'ai-diff'],
  ['ai-add', 'ai-add'],
  ['ai-delete', 'ai-delete'],
  ['ai-link-add', 'ai-link-add'],
  ['ai-link-delete', 'ai-link-delete'],
]);

type BlockLocation = {
  parentGroup: Y.XmlElement;
  index: number;
  container: Y.XmlElement;
};

export async function readCurrentBlocks(room: Room): Promise<NoteBlock[]> {
  return readCurrentBlocksSync(room);
}

export function readCurrentBlocksSync(room: Room): NoteBlock[] {
  const root = getRootBlockGroup(room);
  const aiContentStore = getAiContentStore(room);
  return root ? readBlockGroup(root, aiContentStore) : [];
}

export async function replaceBlockContainer(room: Room, block: NoteBlock): Promise<void> {
  replaceBlockContainerSync(room, block);
}

export function replaceBlockContainerSync(room: Room, block: NoteBlock): void {
  const location = findBlockLocation(room, block.id);
  if (!location) {
    throw new Error(`block_not_found:${block.id}`);
  }
  syncAiContentStoreForBlock(room, block);
  const nextContainer = createBlockContainer(block);
  location.parentGroup.delete(location.index, 1);
  location.parentGroup.insert(location.index, [nextContainer]);
}

export async function insertBlockContainer(
  room: Room,
  anchorBlockId: string,
  position: 'before' | 'after',
  block: NoteBlock,
): Promise<void> {
  insertBlockContainerSync(room, anchorBlockId, position, block);
}

export function insertBlockContainerSync(
  room: Room,
  anchorBlockId: string,
  position: 'before' | 'after',
  block: NoteBlock,
): void {
  const location = findBlockLocation(room, anchorBlockId);
  if (!location) {
    throw new Error(`anchor_not_found:${anchorBlockId}`);
  }
  syncAiContentStoreForBlock(room, block);
  const nextContainer = createBlockContainer(block);
  const insertIndex = position === 'before' ? location.index : location.index + 1;
  location.parentGroup.insert(insertIndex, [nextContainer]);
}

export function removeBlockContainer(room: Room, blockId: string): void {
  const location = findBlockLocation(room, blockId);
  if (!location) {
    throw new Error(`block_not_found:${blockId}`);
  }
  removeAiContentStoreForContainer(room, location.container);
  location.parentGroup.delete(location.index, 1);
}

export function hasBlock(room: Room, blockId: string): boolean {
  return Boolean(findBlockLocation(room, blockId));
}

export function getBlock(blocks: NoteBlock[], blockId: string): NoteBlock | undefined {
  return findBlockById(blocks, blockId);
}

function createBlockContainer(block: NoteBlock): Y.XmlElement {
  const container = new Y.XmlElement(BLOCK_CONTAINER_NODE);
  container.setAttribute('id', block.id);

  const blockElement = new Y.XmlElement(block.type);
  setAttributes(blockElement, block.props);

  if (Array.isArray(block.content)) {
    blockElement.insert(0, block.content.map((item) => createInlineNode(item as NoteInlineContent)));
  } else if (typeof block.content === 'string' && block.content) {
    blockElement.insert(0, [createTextNode(block.content, {})]);
  }
  const children: Y.XmlElement[] = [blockElement];
  if (block.children.length > 0) {
    const childGroup = new Y.XmlElement(ROOT_GROUP_NODE);
    childGroup.insert(0, block.children.map((child) => createBlockContainer(child)));
    children.push(childGroup);
  }
  container.insert(0, children);
  return container;
}

function getRootBlockGroup(room: Room): Y.XmlElement | null {
  const fragment = room.yDoc.getXmlFragment(DOCUMENT_STORE_FRAGMENT);
  const root = fragment.get(0);
  if (root instanceof Y.XmlElement && root.nodeName === ROOT_GROUP_NODE) {
    return root;
  }
  return null;
}

function findBlockLocation(room: Room, blockId: string): BlockLocation | null {
  const root = getRootBlockGroup(room);
  if (!root) {
    return null;
  }
  return findBlockLocationInGroup(root, blockId);
}

function findBlockLocationInGroup(group: Y.XmlElement, blockId: string): BlockLocation | null {
  const children = group.toArray();
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!(child instanceof Y.XmlElement) || child.nodeName !== BLOCK_CONTAINER_NODE) {
      continue;
    }
    if (child.getAttribute('id') === blockId) {
      return { parentGroup: group, index, container: child };
    }
    for (const grandChild of child.toArray()) {
      if (grandChild instanceof Y.XmlElement && grandChild.nodeName === ROOT_GROUP_NODE) {
        const nested = findBlockLocationInGroup(grandChild, blockId);
        if (nested) {
          return nested;
        }
      }
    }
  }
  return null;
}

function getAiContentStore(room: Room): Y.Map<unknown> {
  return room.yDoc.getMap(AI_CONTENT_STORE_MAP);
}

function syncAiContentStoreForBlock(room: Room, block: NoteBlock): void {
  const store = getAiContentStore(room);
  if (Array.isArray(block['AI-content'])) {
    store.set(block.id, block['AI-content']);
  } else {
    store.delete(block.id);
  }
  for (const child of block.children ?? []) {
    syncAiContentStoreForBlock(room, child);
  }
}

function removeAiContentStoreForContainer(room: Room, container: Y.XmlElement): void {
  const store = getAiContentStore(room);
  for (const blockId of collectBlockIdsFromContainer(container)) {
    store.delete(blockId);
  }
}

function collectBlockIdsFromContainer(container: Y.XmlElement): string[] {
  const ids = [String(container.getAttribute('id') ?? '')].filter(Boolean);
  for (const child of container.toArray()) {
    if (child instanceof Y.XmlElement && child.nodeName === ROOT_GROUP_NODE) {
      for (const nested of child.toArray()) {
        if (nested instanceof Y.XmlElement && nested.nodeName === BLOCK_CONTAINER_NODE) {
          ids.push(...collectBlockIdsFromContainer(nested));
        }
      }
    }
  }
  return ids;
}

function readBlockGroup(group: Y.XmlElement, aiContentStore: Y.Map<unknown>): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  for (const child of group.toArray()) {
    if (child instanceof Y.XmlElement && child.nodeName === BLOCK_CONTAINER_NODE) {
      const block = readBlockContainer(child, aiContentStore);
      if (block) {
        blocks.push(block);
      }
    }
  }
  return blocks;
}

function readBlockContainer(
  container: Y.XmlElement,
  aiContentStore: Y.Map<unknown>,
): NoteBlock | null {
  const blockElement = container
    .toArray()
    .find(
      (child): child is Y.XmlElement =>
        child instanceof Y.XmlElement && child.nodeName !== ROOT_GROUP_NODE,
    );
  if (!blockElement) {
    return null;
  }

  const childGroup = container
    .toArray()
    .find(
      (child): child is Y.XmlElement =>
        child instanceof Y.XmlElement && child.nodeName === ROOT_GROUP_NODE,
    );

  const content = readInlineContent(blockElement);
  const aiContentElement = blockElement
    .toArray()
    .find(
      (child): child is Y.XmlElement =>
        child instanceof Y.XmlElement && child.nodeName === AI_CONTENT_NODE,
    );
  const legacyAiContent = aiContentElement ? readInlineContent(aiContentElement) : [];
  const storedAiContent = aiContentStore.get(String(container.getAttribute('id') ?? ''));
  const block: NoteBlock = {
    id: String(container.getAttribute('id') ?? ''),
    type: blockElement.nodeName,
    props: readAttributes(blockElement),
    children: childGroup ? readBlockGroup(childGroup, aiContentStore) : [],
  };
  if (content.length > 0 || block.type !== 'math') {
    block.content = content;
  }
  if (Array.isArray(storedAiContent)) {
    block['AI-content'] = storedAiContent;
  } else if (aiContentElement) {
    block['AI-content'] = legacyAiContent;
  }
  return block;
}

function readInlineContent(blockElement: Y.XmlElement): NoteInlineContent[] {
  const content: NoteInlineContent[] = [];
  for (const child of blockElement.toArray()) {
    if (child instanceof Y.XmlText) {
      content.push(...readXmlTextContent(child));
      continue;
    }
    if (child instanceof Y.XmlElement) {
      if (child.nodeName === AI_CONTENT_NODE) {
        continue;
      }
      content.push(readInlineElement(child));
    }
  }
  return content;
}

function readXmlTextContent(textNode: Y.XmlText): NoteInlineContent[] {
  const content: NoteInlineContent[] = [];
  for (const delta of textNode.toDelta()) {
    if (typeof delta.insert !== 'string' || delta.insert.length === 0) {
      continue;
    }
    const attributes = isRecord(delta.attributes) ? delta.attributes : {};
    const link = isRecord(attributes.link) ? attributes.link : null;
    const styles = deltaAttributesToStyles(attributes);
    if (link) {
      content.push({
        type: 'link',
        href: String(link.href ?? ''),
        content: [{ type: 'text', text: delta.insert, styles }],
      });
      continue;
    }
    content.push({ type: 'text', text: delta.insert, styles });
  }
  return content;
}

function readInlineElement(element: Y.XmlElement): NoteInlineContent {
  const type = INLINE_ELEMENT_TYPES.get(element.nodeName.toLowerCase()) ?? element.nodeName;
  return {
    type,
    props: readAttributes(element),
  };
}

function createInlineNode(item: NoteInlineContent): Y.XmlElement | Y.XmlText {
  if (item.type === 'text') {
    return createTextNode(item.text ?? '', item.styles ?? {});
  }
  if (item.type === 'link') {
    const text = Array.isArray(item.content)
      ? item.content.map((child) => child.text ?? '').join('')
      : '';
    const styles = Array.isArray(item.content) ? item.content[0]?.styles ?? {} : {};
    const attributes = {
      ...stylesToDeltaAttributes(styles),
      link: {
        href: item.href ?? '',
        target: LINK_TARGET,
        rel: LINK_REL,
        class: null,
        title: null,
      },
    };
    const textNode = new Y.XmlText();
    textNode.insert(0, text, attributes);
    return textNode;
  }

  const element = new Y.XmlElement(inlineTypeToNodeName(item.type));
  setAttributes(element, item.props ?? {});
  return element;
}

function createTextNode(text: string, styles: Record<string, unknown>): Y.XmlText {
  const textNode = new Y.XmlText();
  textNode.insert(0, text, stylesToDeltaAttributes(styles));
  return textNode;
}

function inlineTypeToNodeName(type: string): string {
  if (type === 'inlineMath') {
    return 'inlineMath';
  }
  return type;
}

function readAttributes(element: Y.XmlElement): Record<string, unknown> {
  return { ...element.getAttributes() };
}

function setAttributes(element: Y.XmlElement, attributes: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      element.setAttribute(key, value as string);
    }
  }
}

function deltaAttributesToStyles(attributes: Record<string, unknown>): Record<string, unknown> {
  const styles: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'link') {
      continue;
    }
    if (isRecord(value) && typeof value.stringValue === 'string') {
      styles[key] = value.stringValue;
    } else if (isRecord(value) && Object.keys(value).length === 0) {
      styles[key] = true;
    } else {
      styles[key] = value;
    }
  }
  return styles;
}

function stylesToDeltaAttributes(styles: Record<string, unknown>): Record<string, unknown> | undefined {
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(styles)) {
    if (value === undefined || value === false) {
      continue;
    }
    if (value === true) {
      attributes[key] = {};
    } else if (typeof value === 'string') {
      attributes[key] = { stringValue: value };
    } else {
      attributes[key] = value;
    }
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}
