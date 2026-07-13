import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

import { joinRoom, leaveRoom, getRoom } from './room-manager';
import { parseIntent } from './protocol';
import { checkPermission } from '../clients/note-service-client';
import {
  extractDeveloperFromHeaders,
  extractDeveloperFromSearchParams,
  runWithDownstreamContext,
} from '../clients/downstream-context';
import { config } from '../config';
import { ClientIntent } from '../types';

const connectionIntents = new WeakMap<WebSocket, ClientIntent[]>();
const connectionWritable = new WeakMap<WebSocket, boolean>();

type WsIdentitySource = 'header' | 'developer-query' | 'missing';

type WsIdentity = {
  userId: string;
  groupRoleMapRaw: string;
  source: WsIdentitySource;
};

const QUERY_USER_ID_KEYS = ['actorUserId', 'userId', 'x-user-id'];
const QUERY_GROUP_ROLE_MAP_KEYS = ['groupRoleMap', 'x-group-role-map'];

function headerString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0]?.trim() ?? '';
  }
  return value?.trim() ?? '';
}

function firstSearchParam(searchParams: URLSearchParams, keys: string[]): string {
  for (const key of keys) {
    const value = searchParams.get(key)?.trim();
    if (value) return value;
  }
  return '';
}

function isDeveloperQueryIdentityAllowed(developer?: string): boolean {
  const profile = String(config.profile ?? '').toLowerCase();
  return Boolean(developer) && profile !== 'prod' && profile !== 'production';
}

function resolveWsIdentity(
  req: IncomingMessage,
  searchParams: URLSearchParams,
  developer?: string,
): WsIdentity {
  const headerUserId = headerString(req.headers['x-user-id']);
  const headerGroupRoleMap = headerString(req.headers['x-group-role-map']);
  if (headerUserId) {
    return {
      userId: headerUserId,
      groupRoleMapRaw: headerGroupRoleMap,
      source: 'header',
    };
  }

  if (isDeveloperQueryIdentityAllowed(developer)) {
    return {
      userId: firstSearchParam(searchParams, QUERY_USER_ID_KEYS),
      groupRoleMapRaw: firstSearchParam(searchParams, QUERY_GROUP_ROLE_MAP_KEYS),
      source: 'developer-query',
    };
  }

  return {
    userId: '',
    groupRoleMapRaw: '',
    source: 'missing',
  };
}

function parseGroupRoleMap(raw: string, userId: string, resourceId: string): Record<string, string> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[WS] Invalid group role map`, { userId, resourceId });
    throw err;
  }
}

export function setupWebSocketServer(wss: WebSocketServer): void {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const resourceId = url.searchParams.get('resourceId');

    const developer =
      extractDeveloperFromHeaders(req.headers) ??
      extractDeveloperFromSearchParams(url.searchParams);
    const identity = resolveWsIdentity(req, url.searchParams, developer);
    const userId = identity.userId;
    const groupRoleMapRaw = identity.groupRoleMapRaw;

    if (!resourceId || !userId) {
      console.warn(`[WS] Reject connection: missing resourceId or userId`, {
        hasResourceId: Boolean(resourceId),
        hasUserId: Boolean(userId),
        developer: developer ?? '-',
        identitySource: identity.source,
      });
      ws.close(4001, 'Missing resourceId or userId');
      return;
    }

    console.log(
      `[WS] Accepted connection room=${resourceId} user=${userId} developer=${developer ?? '-'} identity=${identity.source}`,
    );

    // 引入消息缓冲区
    let isReady = false;
    const messageQueue: { rawData: Buffer; isBinary: boolean }[] = [];

    // 处理客户端消息
    const processMessage = (rawData: Buffer, isBinary: boolean) => {
      try {
        const room = getRoom(resourceId);
        if (!room) return;

        // --- 文本帧 ---
        if (!isBinary) { // 收到文本帧，解析意图
          const intent = parseIntent(rawData);
          if (intent) {
            intent.userId = userId; // 注入身份
            
            let queue = connectionIntents.get(ws);
            if (!queue) { // 如果队列不存在，则创建一个
              queue = [];
              connectionIntents.set(ws, queue);
            }
            queue.push(intent); 
          }
          return; // 暂存完毕，直接返回，等待紧随其后的二进制帧
        }

        // --- 二进制帧 ---
        // 创建一个二进制读取流
        const decoder = decoding.createDecoder(new Uint8Array(rawData.buffer, rawData.byteOffset, rawData.byteLength));
        // 创建一个二进制写入流（预回包）
        const encoder = encoding.createEncoder();

        // 读取第 1 个字节 (Message Type)
        const messageType = decoding.readVarUint(decoder);

        if (messageType === 0) { // Sync 文档同步
          // 消费意图并处理数据
          const queue = connectionIntents.get(ws);

          // 严格遵循 FIFO。如果没有意图，降级为普通键盘打字
          const currentIntent: ClientIntent = (queue && queue.length > 0) 
            ? queue.shift()! 
            : { operationType: 'KEYBOARD', userId };

          // 只读连接：仅允许 SyncStep1（状态向量握手）和 SyncStep2（服务端回包），
          // 拒绝 SyncUpdate（messageYjsSyncType === 2）以阻止写入
          const isWritable = connectionWritable.get(ws) !== false;
          const peekSyncType = decoding.peekVarUint(decoder);
          if (!isWritable && peekSyncType === 2) {
            return; // 无编辑权限，丢弃增量更新
          }

          encoding.writeVarUint(encoder, 0); // 写入 Message Type 0 (Sync)

          // 如果是 增量更新，则提取操作增量，并直接触发底层的 Y.applyUpdate(yDoc, update)
          // 如果是 状态向量握手/版本交换，则将服务端的完整 yDoc 历史，与收到的客户端 State Vector 进行集合差集运算
          // 最终得到服务端缺失的完整 yDoc 历史，并写入 encoder
          // 直接传递 decoder，无需事先转成 Uint8Array
          syncProtocol.readSyncMessage(decoder, encoder, room.yDoc, currentIntent);

          // 如果 encoder 的长度大于 1（说明是状态向量握手/版本交换），则回包
          if (encoding.length(encoder) > 1) {
            ws.send(encoding.toUint8Array(encoder));
          }

        } else if (messageType === 1) {// Awareness 光标状态

          const awarenessUpdate = decoding.readVarUint8Array(decoder); // 读取最新的光标二进制数据

          // Diff，更新状态机，然后触发更新事件
          // ws 用于标记光标更新来源
          awarenessProtocol.applyAwarenessUpdate(room.awareness, awarenessUpdate, ws);
          
        }
      } catch (err) {
        console.error(`[WS] Error processing message in room ${resourceId}`, err);
      }
    };

    // 处理客户端消息
    ws.on('message', (rawData: Buffer, isBinary: boolean) => {
      if (!isReady) {
        // 如果鉴权或房间还没准备好，先丢进队列暂存
        messageQueue.push({ rawData, isBinary });
      } else {
        processMessage(rawData, isBinary);
      }
    });

    // 离开房间
    ws.on('close', () => {
      leaveRoom(resourceId, ws).catch((err) =>
        console.error(`[WS] Error leaving room ${resourceId}`, err),
      );
    });

    ws.on('error', (err) => {
      console.error(`[WS] Connection error in room ${resourceId}`, err);
    });

    // 鉴权
    runWithDownstreamContext({ developer }, async () => {
      try {
        const groupRoleMap = parseGroupRoleMap(groupRoleMapRaw, userId, resourceId);
        const { resourceAccessRole, allowedActions } = await checkPermission(resourceId, userId, groupRoleMap);

        if (resourceAccessRole === 'NONE') {
          console.warn(`[Auth] Permission denied`, { userId, resourceId, groupRoleMap });
          ws.close(4003, 'Permission denied');
          return;
        }
        // 判断数组中是否包含协同编辑权限 (不再使用位运算掩码)
        const canEdit = allowedActions && allowedActions.includes('EDIT');
        connectionWritable.set(ws, canEdit);
      } catch (err) {
        console.error(`[Auth] Permission check failed for ${userId} on ${resourceId}`, err);
        ws.close(4500, 'Auth service error');
        return;
      }

      // 加入房间
      try {
        await joinRoom(resourceId, ws, userId);
      } catch (err) {
        console.error(`[Room] Failed to join room ${resourceId}`, err);
        ws.close(4500, 'Room initialization error');
        return;
      }

      isReady = true; // 鉴权和房间准备完成，标记连接为就绪状态

      // 处理之前暂存的消息
      while (messageQueue.length > 0) {
        const msg = messageQueue.shift()!;
        processMessage(msg.rawData, msg.isBinary);
      }

    });
  });
}
