const activeBlobUrls = new Set<string>();
const blobRegistry = new Map<string, Blob>();

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
