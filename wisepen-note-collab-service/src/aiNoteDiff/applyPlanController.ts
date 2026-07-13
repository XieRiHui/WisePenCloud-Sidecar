import { ClientIntent } from '../types';
import { runWithDownstreamContext } from '../clients/downstream-context';
import { getOrCreateRoom, getRoom } from '../ws/room-manager';
import { buildApplyResult } from './applyResult';
import { buildApplyOperations } from './applyPlanBuilder';
import { readCurrentBlocksSync } from './blockNoteYDocAdapter';
import { assertResourcePermission, TrustedContext } from './internalAuth';
import { withRoomMutationLock } from './mutationLock';
import { getBundle } from './noteXmlBundleStore';
import { parsePatchPlan } from './patchParser';
import { writeReviewContentSync } from './reviewContentWriter';
import { awaitClientContentSync } from './stateVectorBarrier';
import { ApplyPlanRequest, ApplyPlanResponse, ClassifiedApplyOperation } from './types';
import { classifyYDocTargets } from './ydocTargetClassifier';

export async function applyPlanForAi(
  request: ApplyPlanRequest,
  context: TrustedContext,
): Promise<ApplyPlanResponse> {
  return runWithDownstreamContext({ developer: context.developer }, () =>
    applyPlanForAiWithContext(request, context),
  );
}

async function applyPlanForAiWithContext(
  request: ApplyPlanRequest,
  context: TrustedContext,
): Promise<ApplyPlanResponse> {
  if (
    !request ||
    typeof request.resourceId !== 'string' ||
    typeof request.exportHandle !== 'string'
  ) {
    throw new Error('invalid_request');
  }

  const resourceId = request.resourceId.trim();
  await assertResourcePermission(resourceId, context, 'EDIT');

  const bundle = getBundle(request.exportHandle);
  if (!bundle) {
    throw new Error('export_handle_expired');
  }
  if (bundle.resourceId !== resourceId || bundle.actorUserId !== context.actorUserId) {
    throw new Error('export_handle_mismatch');
  }

  const patchOperations = parsePatchPlan(request.plan, bundle);
  const applyOperations = buildApplyOperations(patchOperations, bundle);

  let classified: ClassifiedApplyOperation[] = [];
  await withRoomMutationLock(resourceId, async () => {
    const room = request.requireLiveRoom
      ? requireActiveRoom(resourceId)
      : await getOrCreateRoom(resourceId);
    await awaitClientContentSync(
      room,
      request.clientContentSignature,
      context,
      request.clientStateVector,
    );
    const origin: ClientIntent = {
      operationType: 'AI_DIFF',
      source: 'ai-note-edit',
      userId: context.actorUserId,
    };

    room.yDoc.transact(() => {
      // The read/classify/write sequence stays inside one Yjs transaction.
      // The adapter replaces only touched blockContainer nodes, not the whole note.
      const currentBlocks = readCurrentBlocksSync(room);
      classified = classifyYDocTargets(currentBlocks, applyOperations);
      writeReviewContentSync(room, currentBlocks, classified, bundle.exportHandle, {
        selectedText: typeof request.selectedText === 'string' ? request.selectedText : undefined,
        selectedTextBoundary: request.selectedTextBoundary === true,
      });
    }, origin);
  });

  return {
    resourceId,
    exportHandle: request.exportHandle,
    ...buildApplyResult(classified),
  };
}

function requireActiveRoom(resourceId: string) {
  const room = getRoom(resourceId);
  if (!room || room.connections.size === 0) {
    throw new Error('active_room_not_found');
  }
  return room;
}
