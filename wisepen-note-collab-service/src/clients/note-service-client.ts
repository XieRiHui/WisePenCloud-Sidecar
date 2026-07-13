import axios, { AxiosInstance } from 'axios';
import {
  DownstreamEndpoint,
  getNoteServiceEndpoint,
  getResourceServiceEndpoint,
} from '../nacos/registry';
import { config } from '../config';
import { R, ResourceCheckPermissionResDTO, SnapshotResponse } from '../types';
import { buildGrayHeaders, getDeveloperTag } from './downstream-context';

type DownstreamClient = {
  client: AxiosInstance;
  endpoint: DownstreamEndpoint;
};

function fromSourceHeader(developer?: string): Record<string, string> {
  return {
    'X-From-Source': config.security.fromSourceSecret,
    ...buildGrayHeaders(developer),
  };
}

function createClient(endpoint: DownstreamEndpoint): AxiosInstance {
  return axios.create({
    baseURL: endpoint.url,
    timeout: 10000,
    headers: fromSourceHeader(endpoint.developer ?? getDeveloperTag()),
  });
}

export async function getNoteServiceClient(): Promise<AxiosInstance> {
  return (await getNoteServiceClientWithEndpoint()).client;
}

export async function getResourceServiceClient(): Promise<AxiosInstance> {
  return (await getResourceServiceClientWithEndpoint()).client;
}

async function getNoteServiceClientWithEndpoint(): Promise<DownstreamClient> {
  const endpoint = await getNoteServiceEndpoint();
  return { client: createClient(endpoint), endpoint };
}

async function getResourceServiceClientWithEndpoint(): Promise<DownstreamClient> {
  const endpoint = await getResourceServiceEndpoint();
  return { client: createClient(endpoint), endpoint };
}

function logDownstreamStart(operation: string, endpoint: DownstreamEndpoint): number {
  console.log(
    `[Downstream] ${operation} -> ${endpoint.serviceName} ${endpoint.url} source=${endpoint.source} target=${endpoint.target} developer=${endpoint.developer ?? '-'}`,
  );
  return Date.now();
}

function logDownstreamResult(operation: string, startedAt: number, error?: unknown): void {
  const elapsedMs = Date.now() - startedAt;
  if (error) {
    const code = axios.isAxiosError(error) ? error.code ?? '-' : '-';
    console.warn(`[Downstream] ${operation} failed in ${elapsedMs}ms code=${code}`);
    return;
  }
  console.log(`[Downstream] ${operation} succeeded in ${elapsedMs}ms`);
}

export async function checkPermission(
  resourceId: string,
  userId: string,
  groupRoles: Record<string, string>,
): Promise<ResourceCheckPermissionResDTO> {
  const { client, endpoint } = await getResourceServiceClientWithEndpoint();
  const startedAt = logDownstreamStart('checkPermission', endpoint);
  let resp;
  try {
    resp = await client.post<R<ResourceCheckPermissionResDTO>>(
      '/internal/resource/checkResPermission',
      { resourceId, userId, groupRoles },
    );
    logDownstreamResult('checkPermission', startedAt);
  } catch (error) {
    logDownstreamResult('checkPermission', startedAt, error);
    throw error;
  }

  const resData = resp?.data;
  if (!resData || resData.code !== 200 || !resData.data) {
    throw new Error(`[Auth] Permission check failed: code=${resData?.code}, msg=${resData?.msg}`);
  }
  return resData.data;
}

export async function getLatestSnapshot(
  resourceId: string,
): Promise<{ fullSnapshot: Uint8Array | null; deltas: Uint8Array[] | null; version: number }> {
  const { client, endpoint } = await getNoteServiceClientWithEndpoint();
  const startedAt = logDownstreamStart('getLatestSnapshot', endpoint);
  let resp;
  try {
    resp = await client.get<R<SnapshotResponse>>(
      '/internal/note/getNoteLatestVersion',
      { params: { resourceId } },
    );
    logDownstreamResult('getLatestSnapshot', startedAt);
  } catch (error) {
    logDownstreamResult('getLatestSnapshot', startedAt, error);
    throw error;
  }

  const resData = resp?.data;
  if (!resData || resData.code !== 200 || !resData.data) {
    throw new Error(`[Snapshot] Failed to load latest version: code=${resData?.code}, msg=${resData?.msg}`);
  }

  const { fullSnapshot, version, deltas } = resData.data;
  return {
    fullSnapshot: fullSnapshot ? Buffer.from(fullSnapshot, 'base64') : null,
    deltas: deltas ? deltas.map(d => new Uint8Array(Buffer.from(d, 'base64'))) : null,
    version,
  };
}
