import { ServerResponse } from 'http';

export type InternalRpcResponse<T> = {
  code: number;
  msg: string;
  data: T | null;
};

export function success<T>(data: T): InternalRpcResponse<T> {
  return { code: 200, msg: 'success', data };
}

export function businessError(msg: string, detail?: unknown): InternalRpcResponse<{
  errorCode: string;
  detail?: unknown;
}> {
  return {
    code: 400,
    msg,
    data: detail === undefined ? { errorCode: msg } : { errorCode: msg, detail },
  };
}

export function sendJson<T>(res: ServerResponse, status: number, body: InternalRpcResponse<T>): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
