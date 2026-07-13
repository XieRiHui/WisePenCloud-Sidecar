import { IncomingMessage, ServerResponse } from 'http';

import { config } from '../config';
import { applyPlanForAi } from './applyPlanController';
import { requireInternalAuth } from './internalAuth';
import { businessError, sendJson, success } from './internalResponse';
import { readNoteForAi } from './readNoteController';
import { ApplyPlanRequest, ReadNoteRequest } from './types';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = normalizeAiNotePath(url.pathname);

  if (req.method === 'GET' && pathname === '/') {
    sendJson(res, 200, success({ status: 'ok', service: config.serviceName }));
    return;
  }

  if (!pathname.startsWith('/internal/ai-note/')) {
    sendJson(res, 404, businessError('not_found'));
    return;
  }

  try {
    const context = requireInternalAuth(req);
    if (req.method !== 'POST') {
      sendJson(res, 200, businessError('method_not_allowed'));
      return;
    }
    const body = await readJsonBody(req);

    if (pathname === '/internal/ai-note/read') {
      const data = await readNoteForAi(body as ReadNoteRequest, context);
      sendJson(res, 200, success(data));
      return;
    }

    if (pathname === '/internal/ai-note/apply-plan') {
      const data = await applyPlanForAi(body as ApplyPlanRequest, context);
      sendJson(res, 200, success(data));
      return;
    }

    sendJson(res, 404, businessError('not_found'));
  } catch (error) {
    handleError(res, error);
  }
}

function normalizeAiNotePath(pathname: string): string {
  const collabPrefix = '/note-collab';
  if (pathname.startsWith(`${collabPrefix}/internal/ai-note/`)) {
    return pathname.slice(collabPrefix.length);
  }
  return pathname;
}

function handleError(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : 'internal_error';
  if (message === 'not_found') {
    sendJson(res, 404, businessError('not_found'));
    return;
  }
  if (message === 'payload_too_large') {
    sendJson(res, 413, businessError('payload_too_large'));
    return;
  }
  if (message === 'invalid_json') {
    sendJson(res, 400, businessError('invalid_json'));
    return;
  }
  if (
    message === 'invalid_request' ||
    message === 'invalid_plan' ||
    message === 'invalid_scope' ||
    message === 'invalid_scope_range' ||
    message === 'scope_block_not_found' ||
    message === 'active_room_not_found' ||
    message === 'note_client_state_not_synced' ||
    message === 'empty_exportable_scope' ||
    message === 'export_handle_expired' ||
    message === 'export_handle_mismatch' ||
    message === 'missing_actor' ||
    message === 'invalid_group_role_map' ||
    message === 'permission_denied'
  ) {
    sendJson(res, 200, businessError(message));
    return;
  }

  console.error('[AI-Diff] Internal error', error);
  sendJson(res, 500, businessError('internal_error'));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const contentType = String(req.headers['content-type'] || '');
  if (contentType && !contentType.toLowerCase().includes('application/json')) {
    throw new Error('invalid_json');
  }

  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('payload_too_large');
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid_json');
  }
}
