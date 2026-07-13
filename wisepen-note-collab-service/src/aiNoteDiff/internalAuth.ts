import { IncomingMessage } from 'http';

import { checkPermission } from '../clients/note-service-client';
import { extractDeveloperFromHeaders } from '../clients/downstream-context';
import { config } from '../config';
import { ResourceAction } from '../types';

export type TrustedContext = {
  actorUserId: string;
  groupRoles: Record<string, string>;
  developer?: string;
};

export function requireInternalAuth(req: IncomingMessage): TrustedContext {
  const source = req.headers['x-from-source'];
  if (source !== config.security.fromSourceSecret) {
    throw new Error('not_found');
  }
  const actorUserId = headerString(req.headers['x-user-id']);
  if (!actorUserId) {
    throw new Error('missing_actor');
  }
  const groupRoleMapRaw = headerString(req.headers['x-group-role-map']);
  let groupRoles: Record<string, string> = {};
  if (groupRoleMapRaw) {
    try {
      groupRoles = JSON.parse(groupRoleMapRaw);
    } catch {
      throw new Error('invalid_group_role_map');
    }
  }
  return {
    actorUserId,
    groupRoles,
    developer: extractDeveloperFromHeaders(req.headers),
  };
}

export async function assertResourcePermission(
  resourceId: string,
  context: TrustedContext,
  action: ResourceAction,
): Promise<void> {
  const permission = await checkPermission(resourceId, context.actorUserId, context.groupRoles);
  if (!permission.allowedActions?.includes(action)) {
    throw new Error('permission_denied');
  }
}

function headerString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}
