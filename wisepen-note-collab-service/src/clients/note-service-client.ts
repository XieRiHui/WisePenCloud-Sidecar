import axios, { AxiosInstance } from 'axios';
import { getNoteServiceUrl, getResourceServiceUrl } from '../nacos/registry';
import { config } from '../config';
import { R, ResourceCheckPermissionResDTO, SnapshotResponse } from '../types';

function fromSourceHeader(): Record<string, string> {
  return { 'X-From-Source': config.security.fromSourceSecret };
}

export async function getNoteServiceClient(): Promise<AxiosInstance> {
  const baseURL = await getNoteServiceUrl();
  return axios.create({
    baseURL,
    timeout: 10000,
    headers: fromSourceHeader(),
  });
}

export async function getResourceServiceClient(): Promise<AxiosInstance> {
  const baseURL = await getResourceServiceUrl();
  return axios.create({
    baseURL,
    timeout: 10000,
    headers: fromSourceHeader(),
  });
}

export async function checkPermission(
  resourceId: string,
  userId: string,
  groupRoles: Record<string, string>,
): Promise<ResourceCheckPermissionResDTO> {
  const client = await getResourceServiceClient();
  // 使用 params 发送，对应 Java 的 @RequestParam
  const resp = await client.post<R<ResourceCheckPermissionResDTO>>(
    '/internal/resource/checkResPermission', 
    { resourceId, userId, groupRoles }
  );
  const resData = resp?.data;
  if (!resData || resData.code !== 200 || !resData.data) {
    throw new Error(`[Auth] 权限校验失败: code=${resData?.code}, msg=${resData?.msg}`);
  }
  return resData.data;
}

export async function getLatestSnapshot(
  resourceId: string,
): Promise<{ fullSnapshot: Uint8Array | null; deltas: Uint8Array[] | null; version: number }> {
  const client = await getNoteServiceClient();
  const resp = await client.get<R<SnapshotResponse>>(
    '/internal/note/getNoteLatestVersion',
    { params: { resourceId } }
  );

  const resData = resp?.data;
  if (!resData || resData.code !== 200 || !resData.data) {
    throw new Error(`[Snapshot] 获取快照失败: code=${resData?.code}, msg=${resData?.msg}`);
  }

  const { fullSnapshot, version, deltas } = resData.data;
  return {
    fullSnapshot: fullSnapshot ? Buffer.from(fullSnapshot, 'base64') : null,
    deltas: deltas ? deltas.map(d => new Uint8Array(Buffer.from(d, 'base64'))) : null,
    version,
  };
}
