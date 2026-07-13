import crypto from 'crypto';

import { NoteXmlBundle } from './types';

const DEFAULT_TTL_MS = 20 * 60 * 1000;
const bundles = new Map<string, NoteXmlBundle>();

export function createExportHandle(): string {
  return `nx_${crypto.randomBytes(18).toString('base64url')}`;
}

export function bundleExpiresAt(now = Date.now()): number {
  return now + DEFAULT_TTL_MS;
}

export function saveBundle(bundle: NoteXmlBundle): void {
  sweepExpired();
  bundles.set(bundle.exportHandle, bundle);
}

export function getBundle(exportHandle: string): NoteXmlBundle | null {
  sweepExpired();
  const bundle = bundles.get(exportHandle);
  if (!bundle) {
    return null;
  }
  if (bundle.expiresAt <= Date.now()) {
    bundles.delete(exportHandle);
    return null;
  }
  return bundle;
}

export function clearBundlesForTests(): void {
  bundles.clear();
}

function sweepExpired(now = Date.now()): void {
  for (const [handle, bundle] of bundles) {
    if (bundle.expiresAt <= now) {
      bundles.delete(handle);
    }
  }
}
