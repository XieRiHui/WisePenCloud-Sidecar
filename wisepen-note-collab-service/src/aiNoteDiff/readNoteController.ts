import { getOrCreateRoom, getRoom } from '../ws/room-manager';
import { runWithDownstreamContext } from '../clients/downstream-context';
import { readCurrentBlocks } from './blockNoteYDocAdapter';
import { assertResourcePermission, TrustedContext } from './internalAuth';
import {
  bundleExpiresAt,
  createExportHandle,
  saveBundle,
} from './noteXmlBundleStore';
import { filterExportableTargets } from './exportableTargetFilter';
import { resolveNoteScope } from './scopeResolver';
import { awaitClientContentSync } from './stateVectorBarrier';
import { NoteXmlBundle, ReadNoteRequest, ReadNoteResponse } from './types';
import { serializeNoteXml } from './xmlSerializer';

export async function readNoteForAi(
  request: ReadNoteRequest,
  context: TrustedContext,
): Promise<ReadNoteResponse> {
  return runWithDownstreamContext({ developer: context.developer }, () =>
    readNoteForAiWithContext(request, context),
  );
}

async function readNoteForAiWithContext(
  request: ReadNoteRequest,
  context: TrustedContext,
): Promise<ReadNoteResponse> {
  if (!request || typeof request.resourceId !== 'string' || !request.resourceId.trim()) {
    throw new Error('invalid_request');
  }

  const resourceId = request.resourceId.trim();
  await assertResourcePermission(resourceId, context, 'VIEW');

  const room = request.requireLiveRoom
    ? requireActiveRoom(resourceId)
    : await getOrCreateRoom(resourceId);
  await awaitClientContentSync(
    room,
    request.clientContentSignature,
    context,
    request.clientStateVector,
  );
  const currentBlocks = await readCurrentBlocks(room);
  const resolvedScope = resolveNoteScope(currentBlocks, request.scope);
  const exportable = filterExportableTargets(resolvedScope.blocks);
  const serialized = serializeNoteXml(exportable.blocks, exportable.skippedTargets);

  if (Object.keys(serialized.targetIndex.targets).length === 0) {
    throw new Error('empty_exportable_scope');
  }

  const now = Date.now();
  const expiresAt = bundleExpiresAt(now);
  const exportHandle = createExportHandle();
  const bundle: NoteXmlBundle = {
    exportHandle,
    resourceId,
    actorUserId: context.actorUserId,
    scope: resolvedScope.scope,
    version: room.currentVersion,
    aiXml: serialized.aiXml,
    targetIndex: serialized.targetIndex,
    idMapping: serialized.idMapping,
    normalizedBlocks: exportable.blocks,
    skippedTargets: serialized.skippedTargets,
    createdAt: now,
    expiresAt,
  };
  saveBundle(bundle);

  return {
    resourceId,
    exportHandle,
    scope: resolvedScope.scope,
    version: room.currentVersion,
    aiXml: serialized.aiXml,
    skippedTargets: serialized.skippedTargets,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

function requireActiveRoom(resourceId: string) {
  const room = getRoom(resourceId);
  if (!room || room.connections.size === 0) {
    throw new Error('active_room_not_found');
  }
  return room;
}
