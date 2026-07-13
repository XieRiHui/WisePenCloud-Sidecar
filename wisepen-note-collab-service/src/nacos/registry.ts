import { config } from '../config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NacosNamingClient } from 'nacos';
import {
  buildGrayMetadata,
  getDeveloperTag,
  selectGrayInstancePool,
} from '../clients/downstream-context';

export let nacosNamingClient: any;

const nacosSilentLogger = {
  ...console,
  info: (...args: any[]) => {},
  debug: (...args: any[]) => {},
  warn: (...args: any[]) => console.warn(...args),
  error: (msg: any, err?: any) => {
    const errorString = String(msg || '') + String(err || '');
    // 拦截极其烦人的 EADDRINUSE 和心跳发送失败报错
    if (errorString.includes('EADDRINUSE') || errorString.includes('CLIENT-BEAT') || errorString.includes('HostReactor')) {
      return; // 假装没看见，丢进黑洞
    }
    console.error('[Nacos Error]', msg, err);
  }
} as Console;

function resolveRegisterIp(): string {
  // 优先用 NACOS_REGISTER_IP
  if (process.env.NACOS_REGISTER_IP) return process.env.NACOS_REGISTER_IP;

  // 否则遍历网卡
  const nets = os.networkInterfaces();
  const { ignoredInterfaces, preferredNetworks } = config.inetutils;

  let fallbackIp = '127.0.0.1';
  let hasValidFallback = false;

  for (const name of Object.keys(nets)) {
    // 跳过 IGNORED_INTERFACES
    if (ignoredInterfaces.some((regex: RegExp) => regex.test(name))) {
      continue;
    }

    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) {
        // 优先选择 PREFERRED_NETWORKS 指定网段前缀
        if (preferredNetworks.some((prefix: string) => n.address.startsWith(`${prefix}.`))) {
          return n.address;
        }
        if (!hasValidFallback) {
          fallbackIp = n.address;
          hasValidFallback = true;
        }
      }
    }
    // 如果都没有，则使用 fallbackIp（第一个可用 IPv4，否则127.0.0.1）
  }
  return fallbackIp;
}

function parseProperties(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;

    const separatorIndex = line.search(/[=:]/);
    if (separatorIndex < 0) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key) result[key] = value;
  }

  return result;
}

function getDevPropertiesCandidates(): string[] {
  const candidates = [
    path.resolve(process.cwd(), 'dev.properties'),
    path.resolve(__dirname, '..', '..', 'dev.properties'),
    path.resolve(process.cwd(), '..', 'dev.properties'),
    path.resolve(__dirname, '..', '..', '..', 'dev.properties'),
  ];
  return Array.from(new Set(candidates));
}

function loadDeveloperNameFromDevProperties(devPropertiesPaths = getDevPropertiesCandidates()): string | undefined {
  const devPropertiesPath = devPropertiesPaths.find((candidate) =>
    fs.existsSync(candidate)
  );
  if (!devPropertiesPath) return undefined;

  const properties = parseProperties(fs.readFileSync(devPropertiesPath, 'utf8'));
  const enabled = properties['wisepen.developer.enable'] === 'true';
  const developerName = properties['wisepen.developer.name']?.trim();
  if (!enabled || !developerName) return undefined;

  return developerName;
}

export function getLocalDeveloperName(): string | undefined {
  return loadDeveloperNameFromDevProperties();
}

export function buildNacosMetadata(devPropertiesPaths = getDevPropertiesCandidates()): Record<string, string> {
  return buildGrayMetadata(
    {
      'preserved.register.source': 'NODEJS',
      version: '1.0.0',
    },
    loadDeveloperNameFromDevProperties(devPropertiesPaths),
  );
}

export type DownstreamEndpoint = {
  serviceName: string;
  url: string;
  source: 'override' | 'nacos';
  target: 'override' | 'developer' | 'baseline';
  developer?: string;
};

type NacosInstance = {
  ip: string;
  port: number;
  metadata?: Record<string, string>;
};

function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/, '');
}

function resolveDeveloperForDownstream(): string | undefined {
  return getDeveloperTag() ?? getLocalDeveloperName();
}

export function selectInstanceForDeveloper(
  instances: NacosInstance[],
  developer?: string,
): { instance: NacosInstance; target: 'developer' | 'baseline' } {
  const { instances: pool, target } = selectGrayInstancePool(instances, developer);
  if (pool.length > 0) {
    return {
      instance: pool[Math.floor(Math.random() * pool.length)],
      target,
    };
  }

  throw new Error(`No gray-safe instances for developer=${developer ?? '-'}`);
}

async function resolveDownstreamEndpoint(
  serviceName: string,
  overrideEnvName: string,
): Promise<DownstreamEndpoint> {
  const developer = resolveDeveloperForDownstream();
  const override = normalizeBaseUrl(process.env[overrideEnvName]);

  if (override) {
    return {
      serviceName,
      url: override,
      source: 'override',
      target: 'override',
      developer,
    };
  }

  if (!nacosNamingClient) throw new Error('Nacos Client uninitialized.');
  const instances = await nacosNamingClient.selectInstances(
    serviceName,
    config.nacos.group,
    'DEFAULT',
    true
  ) as NacosInstance[];
  if (!instances || instances.length === 0) {
    throw new Error(`No instances for ${serviceName}`);
  }

  const { instance, target } = selectInstanceForDeveloper(instances, developer);
  return {
    serviceName,
    url: `http://${instance.ip}:${instance.port}`,
    source: 'nacos',
    target,
    developer,
  };
}

export async function registerWithNacos(): Promise<void> {
  try {
    if (!nacosNamingClient) {
      nacosNamingClient = new NacosNamingClient({
        logger: nacosSilentLogger,
        serverList: config.nacos.serverAddr,
        namespace: config.nacos.namespace,
        username: config.nacos.username,
        password: config.nacos.password
      });
      await nacosNamingClient.ready();
    }

    const registerIp = resolveRegisterIp();
    const metadata = buildNacosMetadata();
    await nacosNamingClient.registerInstance(config.serviceName, {
      ip: registerIp,
      port: config.port,
      healthy: true,
      enabled: true,
      weight: 1,
      groupName: config.nacos.group,
      metadata
    });

    console.log(`[Nacos] Registered at ${registerIp}:${config.port}`);
    if (metadata.developer) {
      console.log(`[Nacos] Developer metadata enabled: ${metadata.developer}`);
    }
  } catch (err) {
    console.error('[Nacos] Registration failed, retrying...', err);
    setTimeout(registerWithNacos, 5000);
  }
}

export async function deregisterFromNacos(): Promise<void> {
  if (nacosNamingClient) {
    try {
      const registerIp = resolveRegisterIp();
      await nacosNamingClient.deregisterInstance(config.serviceName, {
        ip: registerIp,
        port: config.port,
        groupName: config.nacos.group
      });
      await nacosNamingClient.close();
      console.log('[Nacos] Deregistered successfully.');
    } catch (err) {
      console.error('[Nacos] Deregistration failed', err);
    }
  }
}

// 通过 Nacos 发现 Java 笔记服务
export async function getNoteServiceEndpoint(): Promise<DownstreamEndpoint> {
  return resolveDownstreamEndpoint(config.noteServiceName, 'NOTE_SERVICE_BASE_URL');
}

export async function getNoteServiceUrl(): Promise<string> {
  return (await getNoteServiceEndpoint()).url;
}

// 通过 Nacos 发现 Java 资源服务
export async function getResourceServiceEndpoint(): Promise<DownstreamEndpoint> {
  return resolveDownstreamEndpoint(config.resourceServiceName, 'RESOURCE_SERVICE_BASE_URL');
}

export async function getResourceServiceUrl(): Promise<string> {
  return (await getResourceServiceEndpoint()).url;
}
