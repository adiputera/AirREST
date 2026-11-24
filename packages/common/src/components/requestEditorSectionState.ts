import type { ApiRequest } from '../types/api';

export const REQUEST_EDITOR_SECTIONS = [
  'params',
  'headers',
  'auth',
  'body',
  'prerequest',
  'tests',
] as const;

export type RequestEditorSection = typeof REQUEST_EDITOR_SECTIONS[number];

export const DEFAULT_REQUEST_EDITOR_SECTION: RequestEditorSection = 'params';

const pendingInitialSections: Record<string, RequestEditorSection> = {};

/**
 * Determines the most relevant initial editor section for an imported cURL request.
 */
export function resolveInitialCurlSection(
  request?: Partial<ApiRequest> | null,
): RequestEditorSection {
  if (!request) return DEFAULT_REQUEST_EDITOR_SECTION;
  if (request.bodyType && request.bodyType !== 'none') {
    return 'body';
  }
  const hasActiveParams =
    (Array.isArray(request.params) &&
      request.params.some((p) => p && p.enabled && String(p.key ?? '').trim() !== '')) ||
    (Array.isArray(request.pathVariables) &&
      request.pathVariables.some((p) => p && p.enabled && String(p.key ?? '').trim() !== ''));
  if (hasActiveParams) {
    return 'params';
  }
  const hasActiveHeaders =
    Array.isArray(request.headers) &&
    request.headers.some((h) => h && h.enabled && String(h.key ?? '').trim() !== '');
  if (hasActiveHeaders) {
    return 'headers';
  }
  if (request.auth && request.auth.type && request.auth.type !== 'none') {
    return 'auth';
  }
  return DEFAULT_REQUEST_EDITOR_SECTION;
}

/**
 * Registers an initial editor section for a newly created request tab (e.g. from cURL paste)
 * before or while RequestEditor mounts.
 */
export function queueInitialRequestEditorSection(
  requestId: string,
  section: RequestEditorSection,
): void {
  if (!requestId) return;
  pendingInitialSections[requestId] = section;
}

export function getRequestEditorSection(
  sectionsByRequestId: Readonly<Record<string, RequestEditorSection>>,
  requestId: string,
): RequestEditorSection {
  return (
    sectionsByRequestId[requestId] ??
    pendingInitialSections[requestId] ??
    DEFAULT_REQUEST_EDITOR_SECTION
  );
}

export function setRequestEditorSection(
  sectionsByRequestId: Readonly<Record<string, RequestEditorSection>>,
  requestId: string,
  section: RequestEditorSection,
): Record<string, RequestEditorSection> {
  delete pendingInitialSections[requestId];
  if (sectionsByRequestId[requestId] === section) return sectionsByRequestId;
  return { ...sectionsByRequestId, [requestId]: section };
}

export function migrateRequestEditorSection(
  sectionsByRequestId: Readonly<Record<string, RequestEditorSection>>,
  sourceRequestId: string,
  savedRequestId: string,
): Record<string, RequestEditorSection> {
  if (sourceRequestId !== savedRequestId && pendingInitialSections[sourceRequestId]) {
    pendingInitialSections[savedRequestId] = pendingInitialSections[sourceRequestId];
    delete pendingInitialSections[sourceRequestId];
  }
  if (sourceRequestId === savedRequestId || !sectionsByRequestId[sourceRequestId]) {
    return sectionsByRequestId;
  }

  const { [sourceRequestId]: sourceSection, ...remainingSections } = sectionsByRequestId;
  return { ...remainingSections, [savedRequestId]: sourceSection };
}

export function pruneRequestEditorSections(
  sectionsByRequestId: Readonly<Record<string, RequestEditorSection>>,
  openRequestIds: readonly string[],
): Record<string, RequestEditorSection> {
  const openRequestIdSet = new Set(openRequestIds);
  for (const id of Object.keys(pendingInitialSections)) {
    if (!openRequestIdSet.has(id)) {
      delete pendingInitialSections[id];
    }
  }
  const retainedSections = Object.entries(sectionsByRequestId).filter(([requestId]) => openRequestIdSet.has(requestId));
  if (retainedSections.length === Object.keys(sectionsByRequestId).length) return sectionsByRequestId;
  return Object.fromEntries(retainedSections) as Record<string, RequestEditorSection>;
}
