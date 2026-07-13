import { AsyncLocalStorage } from 'async_hooks';

export interface DownstreamContext {
  developer?: string;
}

export const GRAY_HEADER_DEVELOPER = 'X-Developer';
export const GRAY_METADATA_DEVELOPER = 'developer';

const storage = new AsyncLocalStorage<DownstreamContext>();

export function normalizeDeveloper(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

export function extractDeveloperFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  return normalizeDeveloper(headers['x-developer'] ?? headers[GRAY_HEADER_DEVELOPER]);
}

export function extractDeveloperFromSearchParams(
  searchParams: URLSearchParams,
): string | undefined {
  return (
    normalizeDeveloper(searchParams.get('developer')) ??
    normalizeDeveloper(searchParams.get('x-developer'))
  );
}

export function getDownstreamContext(): DownstreamContext {
  return storage.getStore() ?? {};
}

export function getDeveloperTag(): string | undefined {
  return normalizeDeveloper(getDownstreamContext().developer);
}

export function runWithDownstreamContext<T>(
  context: DownstreamContext,
  fn: () => T,
): T {
  const current = getDownstreamContext();
  const developer = normalizeDeveloper(context.developer) ?? current.developer;
  const next: DownstreamContext = {
    ...current,
    ...(developer ? { developer } : {}),
  };

  return storage.run(next, fn);
}

export function buildGrayHeaders(developer = getDeveloperTag()): Record<string, string> {
  const normalized = normalizeDeveloper(developer);
  return normalized ? { [GRAY_HEADER_DEVELOPER]: normalized } : {};
}

export function buildGrayMetadata(
  metadata: Record<string, string> = {},
  developer?: string,
): Record<string, string> {
  const normalized = normalizeDeveloper(developer);
  return normalized
    ? { ...metadata, [GRAY_METADATA_DEVELOPER]: normalized }
    : { ...metadata };
}

export type GraySelectableInstance = {
  metadata?: Record<string, string>;
};

export function selectGrayInstancePool<T extends GraySelectableInstance>(
  instances: T[],
  developer?: string,
): { instances: T[]; target: 'developer' | 'baseline' } {
  const normalized = normalizeDeveloper(developer);
  if (normalized) {
    const developerInstances = instances.filter(
      (instance) => normalizeDeveloper(instance.metadata?.[GRAY_METADATA_DEVELOPER]) === normalized,
    );
    if (developerInstances.length > 0) {
      return { instances: developerInstances, target: 'developer' };
    }
  }

  const baselineInstances = instances.filter(
    (instance) => !normalizeDeveloper(instance.metadata?.[GRAY_METADATA_DEVELOPER]),
  );
  return { instances: baselineInstances, target: 'baseline' };
}
