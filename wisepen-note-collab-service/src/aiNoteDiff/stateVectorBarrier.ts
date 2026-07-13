import * as Y from 'yjs';

import { Room } from '../types';
import { readCurrentBlocksSync } from './blockNoteYDocAdapter';
import { NoteBlock } from './types';

const DEFAULT_WAIT_TIMEOUT_MS = 6000;
const MAX_STATE_VECTOR_BASE64_LENGTH = 16 * 1024;
const MAX_CONTENT_SIGNATURE_BASE64_LENGTH = 4 * 1024;
const NOTE_CONTENT_SIGNATURE_VERSION = 1;
const CONTENT_SIGNATURE_HASH_RE = /^[0-9a-f]{16}$/;
const CONTENT_SIGNATURE_POLL_MS = 250;

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ClientContentSignature = {
  version: 1;
  /**
   * Accepted for compatibility with older frontend payloads. AI-Diff only reads
   * and writes body content, so title lag must not block the body sync barrier.
   */
  titleHash?: string;
  bodyHash: string;
};

export type ContentSyncContext = {
  actorUserId: string;
  groupRoles: Record<string, string>;
};

type ContentSyncOptions = {
  timeoutMs?: number;
};

export async function awaitClientContentSync(
  room: Room,
  clientContentSignatureBase64?: string,
  context?: ContentSyncContext,
  fallbackClientStateVectorBase64?: string,
  options?: ContentSyncOptions,
): Promise<void> {
  const clientContentSignature = decodeClientContentSignature(clientContentSignatureBase64);
  if (!clientContentSignature) {
    await awaitClientStateVector(room, fallbackClientStateVectorBase64, options);
    return;
  }

  if (await roomContentMatchesClient(room, clientContentSignature, context, options)) {
    return;
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let checking = false;
    let needsRecheck = false;
    const cleanup = () => {
      room.yDoc.off('update', scheduleCheck);
      clearInterval(pollTimer);
      clearTimeout(timeout);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const runCheck = async () => {
      if (settled) return;
      if (checking) {
        needsRecheck = true;
        return;
      }
      checking = true;
      try {
        do {
          needsRecheck = false;
          if (await roomContentMatchesClient(room, clientContentSignature, context, options)) {
            finish();
            return;
          }
        } while (needsRecheck && !settled);
      } catch (error) {
        finish(error instanceof Error ? error : new Error('internal_error'));
      } finally {
        checking = false;
      }
    };
    function scheduleCheck() {
      void runCheck();
    }
    const pollTimer = setInterval(scheduleCheck, CONTENT_SIGNATURE_POLL_MS);
    const timeout = setTimeout(() => {
      finish(new Error('note_client_state_not_synced'));
    }, timeoutMs);

    room.yDoc.on('update', scheduleCheck);
    scheduleCheck();
  });
}

export async function awaitClientStateVector(
  room: Room,
  clientStateVectorBase64?: string,
  options?: { timeoutMs?: number },
): Promise<void> {
  const clientStateVector = decodeClientStateVector(clientStateVectorBase64);
  if (!clientStateVector) return;

  if (roomStateCoversClientState(room, clientStateVector)) {
    return;
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      room.yDoc.off('update', onUpdate);
      clearTimeout(timeout);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onUpdate = () => {
      if (roomStateCoversClientState(room, clientStateVector)) {
        finish();
      }
    };
    const timeout = setTimeout(() => {
      finish(new Error('note_client_state_not_synced'));
    }, timeoutMs);

    room.yDoc.on('update', onUpdate);
    onUpdate();
  });
}

export function stateVectorCovers(serverStateVector: Uint8Array, clientStateVector: Uint8Array): boolean {
  const serverState = Y.decodeStateVector(serverStateVector);
  const clientState = Y.decodeStateVector(clientStateVector);

  for (const [clientId, clientClock] of clientState.entries()) {
    if ((serverState.get(clientId) ?? 0) < clientClock) {
      return false;
    }
  }
  return true;
}

function roomStateCoversClientState(room: Room, clientStateVector: Uint8Array): boolean {
  return stateVectorCovers(Y.encodeStateVector(room.yDoc), clientStateVector);
}

async function roomContentMatchesClient(
  room: Room,
  clientContentSignature: ClientContentSignature,
  _context?: ContentSyncContext,
  _options?: ContentSyncOptions,
): Promise<boolean> {
  const serverBodyHash = computeNoteBodyContentHash(readCurrentBlocksSync(room));
  return serverBodyHash === clientContentSignature.bodyHash;
}

export function encodeNoteContentSignature(params: {
  bodyHash: string;
}): string {
  const payload = {
    version: NOTE_CONTENT_SIGNATURE_VERSION,
    bodyHash: params.bodyHash,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export function computeNoteBodyContentHash(blocks: NoteBlock[]): string {
  return hashString(stableStringify(canonicalizeBlocks(blocks)));
}

function canonicalizeBlocks(value: unknown): JsonValue[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((block): block is Record<string, unknown> => isRecord(block))
    .map((block) => ({
      id: asString(block.id),
      type: asString(block.type),
      props: canonicalizeBlockProps(block.props),
      content: canonicalizeInlineContent(block.content),
      children: canonicalizeBlocks(block.children),
    }));
}

function canonicalizeBlockProps(value: unknown): JsonValue {
  const props = isRecord(value) ? value : {};
  return pickStableProps(props, [
    'level',
    'expression',
    'aiDiffType',
    'aiDiffKey',
    'aiDiffOrigin',
    'aiDiffReplace',
  ]);
}

function canonicalizeInlineContent(value: unknown): JsonValue {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => {
      const type = asString(item.type);
      const base: Record<string, JsonValue> = { type };
      const text = asString(item.text);
      if (text) base.text = text;
      const href = asString(item.href);
      if (href) base.href = href;
      const props = canonicalizeInlineProps(item.props);
      if (isNonEmptyObject(props)) base.props = props;
      const content = canonicalizeInlineContent(item.content);
      if (Array.isArray(content) && content.length > 0) base.content = content;
      return base;
    });
}

function canonicalizeInlineProps(value: unknown): JsonValue {
  const props = isRecord(value) ? value : {};
  return pickStableProps(props, [
    'expression',
    'text',
    'origin',
    'replace',
    'aiDiffType',
    'aiDiffKey',
    'aiDiffOrigin',
    'aiDiffReplace',
  ]);
}

function pickStableProps(
  props: Record<string, unknown>,
  keys: string[],
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(props, key)) {
      out[key] = toJsonValue(props[key]);
    }
  }
  return out;
}

function toJsonValue(value: unknown): JsonValue {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isRecord(value)) {
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined) out[key] = toJsonValue(item);
    }
    return out;
  }
  return String(value);
}

function stableStringify(value: JsonValue): string {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

function hashString(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < input.length; index += 1) {
    const ch = input.charCodeAt(index);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}

function decodeClientStateVector(value?: string): Uint8Array | null {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_STATE_VECTOR_BASE64_LENGTH || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new Error('invalid_request');
  }
  try {
    const decoded = Uint8Array.from(Buffer.from(trimmed, 'base64'));
    Y.decodeStateVector(decoded);
    return decoded;
  } catch {
    throw new Error('invalid_request');
  }
}

function decodeClientContentSignature(value?: string): ClientContentSignature | null {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_CONTENT_SIGNATURE_BASE64_LENGTH || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new Error('invalid_request');
  }
  try {
    const payload = JSON.parse(Buffer.from(trimmed, 'base64').toString('utf8')) as unknown;
    if (!isRecord(payload)) {
      throw new Error('invalid_request');
    }
    const version = payload.version;
    const titleHash = typeof payload.titleHash === 'string' ? payload.titleHash : undefined;
    const bodyHash = typeof payload.bodyHash === 'string' ? payload.bodyHash : '';
    if (
      version !== NOTE_CONTENT_SIGNATURE_VERSION ||
      !CONTENT_SIGNATURE_HASH_RE.test(bodyHash) ||
      (titleHash !== undefined && !CONTENT_SIGNATURE_HASH_RE.test(titleHash))
    ) {
      throw new Error('invalid_request');
    }
    return {
      version: NOTE_CONTENT_SIGNATURE_VERSION,
      ...(titleHash ? { titleHash } : {}),
      bodyHash,
    };
  } catch {
    throw new Error('invalid_request');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
