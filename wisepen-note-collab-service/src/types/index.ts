import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';

export interface ClientIntent {
  operationType: OperationType;
  source?: string;
  userId?: string; 
}

export type OperationType =
  | 'PASTE'
  | 'UNDO'
  | 'REDO'
  | 'AI_DIFF'
  | 'OTHER'
  | 'KEYBOARD';

export interface UserConnection {
  ws: WebSocket;
  userId: string;
  resourceId: string;

  // SharedWorker (多 Tab 共享连接)
  // HTML5 的 SharedWorker 技术可使得若干标签页在本地共用 WebSocket 连接到服务器
  clientIds: Set<number>;
}

export interface Room {
  // 资源ID
  resourceId: string;
  // 资源对应的 YDoc
  yDoc: Y.Doc;

  awareness: awarenessProtocol.Awareness;

  // 用户连接
  connections: Map<WebSocket, UserConnection>;
  // 上一个状态向量
  prevStateVector: Uint8Array | null;
  // 当前版本
  currentVersion: number;
  
  dirty: boolean;
  // 延时销毁定时器
  idleTimer: ReturnType<typeof setTimeout> | null;

  // 攒批缓冲区
  pendingBroadcasts: Uint8Array[];
  // 攒批定时器
  flushBroadcastsTimer: NodeJS.Timeout | null;

  activeUsersInWindow: Set<string>;

  oplogGranularityMs: number;
}

export interface NoteSnapshotMessage {
  resourceId: string;
  version: number;
  type: 'FULL' | 'DELTA';
  data: string; // base64
  plainText?: string;
  updatedBy: string[];
}

export interface NoteOperationLogMessage {
  resourceId: string;
  entries: OplogEntry[];
}

export interface OplogEntry {
  userId: string;
  operationType: string;
  updateData?: string;
  contentSummary?: string;
  timestamp: number;
  mergedCount: number;
  details?: any[];
}

export type ResourceAccessRole = 'OWNER' | 'OWNER_SPECIFIED' | 'GROUP_ADMIN' | 'GROUP_MEMBER' | 'NONE';
export type ResourceAction = 'VIEW' | 'EDIT' | 'DOWNLOAD_WATERMARK' | 'DOWNLOAD_ORIGINAL';

export interface R<T> {
  code: number;
  msg: string;
  data: T;
}

export interface ResourceCheckPermissionResDTO {
  resourceAccessRole: ResourceAccessRole;
  permissionSources: string[];
  allowedActions: ResourceAction[];
}

export interface SnapshotResponse {
  resourceId: string;
  fullSnapshot: string | null;
  deltas?: string[] | null;
  version: number;
}
