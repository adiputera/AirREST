export const DEFAULT_RAW_BODY_MEMORY_BUDGET_BYTES = 128 * 1024 * 1024; // 128 MiB

const activeBlobUrls = new Set<string>();
const blobRegistry = new Map<string, Blob>();
const rawBodyRegistry = new Map<string, { bytes: Uint8Array; byteLength: number }>();

let nextRawBodySeq = 0;
let totalRawBodyBytes = 0;

export function createTrackedBlobUrl(blob: Blob): string {
  const url = URL.createObjectURL(blob);
  activeBlobUrls.add(url);
  blobRegistry.set(url, blob);
  return url;
}

export function getTrackedBlob(url?: string): Blob | undefined {
  if (!url) return undefined;
  return blobRegistry.get(url);
}

export function trackBlobUrl(url: string, blob?: Blob): string {
  activeBlobUrls.add(url);
  if (blob) blobRegistry.set(url, blob);
  return url;
}

export function revokeBlobUrl(url?: string): void {
  if (!url || !activeBlobUrls.delete(url)) return;
  blobRegistry.delete(url);
  URL.revokeObjectURL(url);
}

export function revokeBlobUrls(urls: Iterable<string | undefined>): void {
  for (const url of urls) revokeBlobUrl(url);
}

/**
 * Stores raw response bytes in an in-memory registry keyed by an opaque ID
 * so downloads never depend on decoded preview text or active-MIME blob URLs.
 */
export function createTrackedRawBody(bytes: Uint8Array): string {
  const id = `raw:${++nextRawBodySeq}`;
  const stored = bytes;
  rawBodyRegistry.set(id, { bytes: stored, byteLength: stored.byteLength });
  totalRawBodyBytes += stored.byteLength;
  return id;
}

export function getTrackedRawBody(id?: string): Uint8Array | undefined {
  if (!id) return undefined;
  const entry = rawBodyRegistry.get(id);
  if (!entry) return undefined;
  // Refresh insertion order for LRU eviction.
  rawBodyRegistry.delete(id);
  rawBodyRegistry.set(id, entry);
  return entry.bytes;
}

export function hasTrackedRawBody(id?: string): boolean {
  if (!id) return false;
  return rawBodyRegistry.has(id);
}

export function releaseRawBody(id?: string): void {
  if (!id) return;
  const entry = rawBodyRegistry.get(id);
  if (!entry) return;
  rawBodyRegistry.delete(id);
  totalRawBodyBytes = Math.max(0, totalRawBodyBytes - entry.byteLength);
}

export function releaseRawBodies(ids: Iterable<string | undefined>): void {
  for (const id of ids) releaseRawBody(id);
}

/**
 * Evicts the least-recently-used unpinned raw bodies until total retained bytes
 * fit within `maxBytes`.
 */
export function evictRawBodiesToBudget(
  pinnedIds: Iterable<string> = [],
  maxBytes: number = DEFAULT_RAW_BODY_MEMORY_BUDGET_BYTES,
): string[] {
  if (totalRawBodyBytes <= maxBytes) return [];
  const pinned = pinnedIds instanceof Set ? pinnedIds : new Set(pinnedIds);
  const evicted: string[] = [];

  for (const [id, entry] of rawBodyRegistry.entries()) {
    if (totalRawBodyBytes <= maxBytes) break;
    if (pinned.has(id)) continue;
    rawBodyRegistry.delete(id);
    totalRawBodyBytes = Math.max(0, totalRawBodyBytes - entry.byteLength);
    evicted.push(id);
  }

  return evicted;
}

export function getRawBodyStats(): { count: number; totalBytes: number } {
  return { count: rawBodyRegistry.size, totalBytes: totalRawBodyBytes };
}
