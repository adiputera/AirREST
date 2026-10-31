const activeBlobUrls = new Set<string>();

export function trackBlobUrl(url: string): string {
  activeBlobUrls.add(url);
  return url;
}

export function revokeBlobUrl(url?: string): void {
  if (!url || !activeBlobUrls.delete(url)) return;
  URL.revokeObjectURL(url);
}

export function revokeBlobUrls(urls: Iterable<string | undefined>): void {
  for (const url of urls) revokeBlobUrl(url);
}
