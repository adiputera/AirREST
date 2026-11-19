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

export function getRequestEditorSection(
  sectionsByRequestId: Readonly<Record<string, RequestEditorSection>>,
  requestId: string,
): RequestEditorSection {
  return sectionsByRequestId[requestId] ?? DEFAULT_REQUEST_EDITOR_SECTION;
}

export function setRequestEditorSection(
  sectionsByRequestId: Readonly<Record<string, RequestEditorSection>>,
  requestId: string,
  section: RequestEditorSection,
): Record<string, RequestEditorSection> {
  if (sectionsByRequestId[requestId] === section) return sectionsByRequestId;
  return { ...sectionsByRequestId, [requestId]: section };
}

export function migrateRequestEditorSection(
  sectionsByRequestId: Readonly<Record<string, RequestEditorSection>>,
  sourceRequestId: string,
  savedRequestId: string,
): Record<string, RequestEditorSection> {
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
  const retainedSections = Object.entries(sectionsByRequestId).filter(([requestId]) => openRequestIdSet.has(requestId));
  if (retainedSections.length === Object.keys(sectionsByRequestId).length) return sectionsByRequestId;
  return Object.fromEntries(retainedSections) as Record<string, RequestEditorSection>;
}
