'use client';

import React, { useState, useEffect } from 'react';
import {
  Copy,
  Check,
  Download,
  Clock,
  HardDrive,
  AlertTriangle,
  Code2,
  FileText,
  Sparkles,
  ExternalLink,
  AlertCircle,
  CheckCircle2,
  Image as ImageIcon,
  FileDown,
  ShieldAlert,
  RotateCw,
  ServerOff,
  Globe,
  WifiOff,
  Maximize2,
  Minimize2,
  GripHorizontal,
  BookmarkPlus,
  Loader2,
  X,
  FlaskConical,
  XCircle,
} from 'lucide-react';
import { useApiStore, type SaveRequestToCollectionResult } from '../store/useApiStore';
import { requestHostPermission } from '../lib/hostPermissions';
import { usePlatformAdapter } from '../context';
import { getTrackedBlob, getTrackedRawBody } from '../lib/blobManager';
import { useBackHandler } from '../lib/backNavigation';
import { CodeEditor, CodeEditorHandle } from './editor/CodeEditor';
import { SaveToCollectionModal } from './SaveToCollectionModal';
import { findSavedRequestInCollections } from '../lib/requestDiff';
import { canModifyCollection, hasScopePermission } from '../lib/jwt';
import {
  buildDefaultExampleName,
  evaluateResponseExampleEligibility,
  MAX_SAVED_EXAMPLE_NAME_RUNES,
  validateSavedExampleName,
} from '../lib/examples';
import type { ApiRequest, ApiResponse } from '../types/api';

const EXACT_MIME_EXTENSIONS: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.ms-excel.sheet.macroenabled.12': '.xlsm',
  'application/vnd.ms-excel.sheet.binary.macroenabled.12': '.xlsb',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.oasis.opendocument.text': '.odt',
  'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'application/vnd.oasis.opendocument.presentation': '.odp',
  'application/pdf': '.pdf',
  'text/csv': '.csv',
  'application/csv': '.csv',
  'text/tab-separated-values': '.tsv',
  'application/json': '.json',
  'text/json': '.json',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'text/html': '.html',
  'application/xhtml+xml': '.html',
  'text/css': '.css',
  'application/javascript': '.js',
  'text/javascript': '.js',
  'application/ecmascript': '.js',
  'text/ecmascript': '.js',
  'text/markdown': '.md',
  'text/plain': '.txt',
  'application/yaml': '.yaml',
  'text/yaml': '.yaml',
  'application/x-yaml': '.yaml',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/x-ms-bmp': '.bmp',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/tiff': '.tiff',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'application/gzip': '.gz',
  'application/x-gzip': '.gz',
  'application/x-tar': '.tar',
  'application/tar': '.tar',
  'application/x-gtar': '.tar.gz',
  'application/x-7z-compressed': '.7z',
  'application/vnd.rar': '.rar',
  'application/x-rar-compressed': '.rar',
  'application/wasm': '.wasm',
  'application/octet-stream': '.bin',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/ogg': '.ogg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

export function getExtensionFromMime(mime: string): string {
  const m = (mime || '').split(';')[0].trim().toLowerCase();
  if (!m) return '.bin';
  if (EXACT_MIME_EXTENSIONS[m]) return EXACT_MIME_EXTENSIONS[m];
  if (m.endsWith('+json')) return '.json';
  if (m.endsWith('+xml')) return '.xml';
  if (m.endsWith('+zip')) return '.zip';
  if (m.startsWith('text/')) return '.txt';
  return '.bin';
}

export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeRfc5987Value(charset: string, encoded: string): string {
  const normalized = charset.trim().toLowerCase();
  if (normalized === 'iso-8859-1' || normalized === 'latin1') {
    const bytes: number[] = [];
    for (let i = 0; i < encoded.length; i++) {
      if (encoded[i] === '%' && i + 2 < encoded.length && /^[0-9a-fA-F]{2}$/.test(encoded.slice(i + 1, i + 3))) {
        bytes.push(Number.parseInt(encoded.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(encoded.charCodeAt(i) & 0xff);
      }
    }
    return new TextDecoder('latin1').decode(new Uint8Array(bytes));
  }
  return safeDecodeURIComponent(encoded);
}

function splitHeaderParams(headerValue: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let escaped = false;
  for (let i = 0; i < headerValue.length; i++) {
    const ch = headerValue[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && inQuotes) {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (ch === ';' && !inQuotes) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

function unquoteHeaderParam(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    let result = '';
    for (let i = 1; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === '\\' && i + 1 < trimmed.length && (trimmed[i + 1] === '"' || trimmed[i + 1] === '\\')) {
        result += trimmed[i + 1];
        i++;
        continue;
      }
      if (ch === '"') break;
      result += ch;
    }
    return result;
  }
  return trimmed;
}

export function sanitizeDownloadFilename(rawName: string): string {
  // eslint-disable-next-line no-control-regex -- Download filenames must have ASCII control characters removed.
  const withoutControl = rawName.replace(/[\x00-\x1f\x7f]/g, '');
  const segments = withoutControl.split(/[/\\]+/).filter(Boolean);
  let base = segments.length > 0 ? segments[segments.length - 1] : '';
  if (!base || base === '.' || base === '..') return '';

  base = base.replace(/[<>:"/\\|?*]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  if (!base || base === '.' || base === '..') return '';

  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(base)) {
    base = `_${base}`;
  }

  if (base.length > 200) {
    const extMatch = /(\.[a-z0-9]{1,16})$/i.exec(base);
    if (extMatch) {
      const ext = extMatch[1];
      base = base.slice(0, 200 - ext.length) + ext;
    } else {
      base = base.slice(0, 200);
    }
  }

  return base;
}

export function getFileNameFromHeaders(headers: Record<string, string> = {}, defaultExt: string): string {
  const entry = Object.entries(headers || {}).find(
    ([key]) => key.trim().toLowerCase() === 'content-disposition'
  );
  const disposition = entry?.[1];
  if (disposition) {
    let extFilename: string | null = null;
    let plainFilename: string | null = null;

    const params = splitHeaderParams(disposition).slice(1);
    for (const part of params) {
      const eqIdx = part.indexOf('=');
      if (eqIdx === -1) continue;
      const paramName = part.slice(0, eqIdx).trim().toLowerCase();
      const rawVal = part.slice(eqIdx + 1).trim();

      if (paramName === 'filename*' && extFilename === null) {
        const unwrapped = rawVal.startsWith('"') ? unquoteHeaderParam(rawVal) : rawVal;
        const rfc5987 = /^([^']*)'([^']*)'(.*)$/.exec(unwrapped);
        const decoded = rfc5987
          ? decodeRfc5987Value(rfc5987[1], rfc5987[3])
          : safeDecodeURIComponent(unwrapped);
        const sanitized = sanitizeDownloadFilename(decoded);
        if (sanitized) extFilename = sanitized;
      } else if (paramName === 'filename' && plainFilename === null) {
        const unquoted = unquoteHeaderParam(rawVal);
        const decoded = safeDecodeURIComponent(unquoted);
        const sanitized = sanitizeDownloadFilename(decoded);
        if (sanitized) plainFilename = sanitized;
      }
    }

    if (extFilename) return extFilename;
    if (plainFilename) return plainFilename;
  }
  return `response-${Date.now()}${defaultExt}`;
}

function parseUrlDetails(urlStr: string): { host: string; port: string; protocol: string } {
  try {
    const u = new URL(urlStr);
    return {
      host: u.hostname,
      port: u.port || (u.protocol === 'https:' ? '443' : '80'),
      protocol: u.protocol.replace(':', ''),
    };
  } catch {
    return { host: urlStr, port: '', protocol: '' };
  }
}

export const ResponseViewer: React.FC = () => {
  const runtimeAdapter = usePlatformAdapter();
  const activeResponse = useApiStore((state) => state.activeResponse);
  const isLoading = useApiStore((state) => state.isLoading);
  const updateActiveRequest = useApiStore((state) => state.updateActiveRequest);
  const sendRequest = useApiStore((state) => state.sendRequest);
  const collections = useApiStore((state) => state.collections);
  const workspaceMode = useApiStore((state) => state.workspaceMode);
  const cloudConfig = useApiStore((state) => state.cloudConfig);
  const saveResponseAsExample = useApiStore((state) => state.saveResponseAsExample);
  const selectSavedExample = useApiStore((state) => state.selectSavedExample);
  const activeTabRequest = useApiStore((state) => state.tabs.find((t) => t.id === state.activeTabId));

  const targetUrl = activeResponse?.requestUrl || activeTabRequest?.url || '';
  const isSafeTargetUrl = Boolean(targetUrl && /^https?:\/\//i.test(targetUrl));
  const isHttps = targetUrl.toLowerCase().startsWith('https://');
  const { host: targetHost, port: targetPort } = parseUrlDetails(targetUrl);
  const netCategory = activeResponse?.netErrorCategory;
  const netCode = activeResponse?.netErrorCode;

  const [activeTab, setActiveTab] = useState<'body' | 'headers' | 'scripts' | 'tests'>('body');
  const [viewMode, setViewMode] = useState<'pretty' | 'raw'>('pretty');
  const [copied, setCopied] = useState(false);
  const [imgDimensions, setImgDimensions] = useState<{ width: number; height: number } | null>(null);
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [isExpandedModalOpen, setIsExpandedModalOpen] = useState(false);
  const [isExampleNameModalOpen, setIsExampleNameModalOpen] = useState(false);
  const [exampleNameInput, setExampleNameInput] = useState('');
  const [exampleSaveError, setExampleSaveError] = useState<string | null>(null);
  const [isSavingExample, setIsSavingExample] = useState(false);
  const [saveToCollectionModalRequest, setSaveToCollectionModalRequest] = useState<ApiRequest | null>(null);
  const pendingExampleDraftRef = React.useRef<{
    name: string;
    response: ApiResponse;
    fallbackRequest?: ApiRequest;
  } | null>(null);

  // Drag-to-resize response height (persisted in localStorage)
  const [responseHeight, setResponseHeight] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('airrest:response_editor_height');
      if (saved) {
        const val = parseInt(saved, 10);
        if (!isNaN(val) && val >= 160 && val <= 1000) return val;
      }
    } catch {
      // ignore
    }
    return 400;
  });

  const isResizingResponseRef = React.useRef(false);
  const startResponseYRef = React.useRef(0);
  const startResponseHeightRef = React.useRef(400);
  const responseEditorRef = React.useRef<CodeEditorHandle>(null);
  const modalResponseEditorRef = React.useRef<CodeEditorHandle>(null);
  const latestResponseRef = React.useRef(activeResponse);
  latestResponseRef.current = activeResponse;
  const isDownloadingRef = React.useRef(false);

  const isSyntheticError = Boolean(
    activeResponse &&
      activeResponse.status === 0 &&
      (activeResponse.isError || activeResponse.failureKind || activeResponse.scriptErrorStage === 'pre-request')
  );

  const savedInfo = activeTabRequest ? findSavedRequestInCollections(collections, activeTabRequest.id) : null;
  const exampleEligibility = activeResponse ? evaluateResponseExampleEligibility(activeResponse) : null;
  const canWriteScope = hasScopePermission(
    cloudConfig.activeScope,
    'collection:write',
    workspaceMode,
    cloudConfig.user?.role,
  );
  const saveExampleDisabledReason: string | null = (() => {
    if (!activeResponse || !exampleEligibility) return 'Send a request first';
    if (!exampleEligibility.eligible) return exampleEligibility.reason;
    if (savedInfo && !activeTabRequest?.deletedFromCollection) {
      if (savedInfo.collection.isPartial) return 'Wait for collection details to finish loading before saving examples.';
      if (savedInfo.collection._needsMoveReconciliation) return 'Sync workspace to confirm previous move before saving examples.';
      if (!canModifyCollection(savedInfo.collection.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
        return `Collection "${savedInfo.collection.name}" is read-only for your role.`;
      }
      return null;
    }
    if (!canWriteScope) {
      return 'Write permission (collection:write) is required to save examples.';
    }
    return null;
  })();

  const handleOpenSaveExample = () => {
    if (!activeResponse || saveExampleDisabledReason) return;
    setExampleNameInput(buildDefaultExampleName(activeResponse.status, activeResponse.statusText));
    setExampleSaveError(null);
    setIsExampleNameModalOpen(true);
  };

  const handleConfirmSaveExample = async () => {
    if (!activeResponse) return;
    const validation = validateSavedExampleName(exampleNameInput);
    if (!validation.valid) {
      setExampleSaveError(validation.error);
      return;
    }
    const snapshotResponse = activeResponse;
    const snapshotRequest = activeResponse.capturedRequest || activeTabRequest;

    if (savedInfo && !activeTabRequest?.deletedFromCollection) {
      setIsSavingExample(true);
      setExampleSaveError(null);
      try {
        const res = await saveResponseAsExample({
          collectionId: savedInfo.collection.id,
          itemId: savedInfo.savedRequest.id,
          name: validation.name,
          response: snapshotResponse,
          fallbackRequest: snapshotRequest,
        });
        if (!res.success && !res.reconcilePending) {
          setExampleSaveError(res.error || 'Failed to save response as example.');
          return;
        }
        setIsExampleNameModalOpen(false);
        setIsExpandedModalOpen(false);
        if (res.example) {
          selectSavedExample({
            collectionId: savedInfo.collection.id,
            itemId: savedInfo.savedRequest.id,
            exampleId: res.example.id,
          });
        }
      } finally {
        setIsSavingExample(false);
      }
      return;
    }

    if (!snapshotRequest) {
      setExampleSaveError('Missing request snapshot to save.');
      return;
    }
    pendingExampleDraftRef.current = {
      name: validation.name,
      response: snapshotResponse,
      fallbackRequest: snapshotRequest,
    };
    setIsExampleNameModalOpen(false);
    setSaveToCollectionModalRequest(snapshotRequest);
  };

  const handleSaveToCollectionCommitted = async (result: SaveRequestToCollectionResult) => {
    const draft = pendingExampleDraftRef.current;
    pendingExampleDraftRef.current = null;
    if (!draft || !result.success || !result.savedRequestId) return;
    const latestSaved = findSavedRequestInCollections(useApiStore.getState().collections, result.savedRequestId);
    if (!latestSaved) return;
    const res = await saveResponseAsExample({
      collectionId: latestSaved.collection.id,
      itemId: latestSaved.savedRequest.id,
      name: draft.name,
      response: draft.response,
      fallbackRequest: draft.fallbackRequest,
    });
    if (res.example) {
      setIsExpandedModalOpen(false);
      selectSavedExample({
        collectionId: latestSaved.collection.id,
        itemId: latestSaved.savedRequest.id,
        exampleId: res.example.id,
      });
    } else if (!res.success && res.error) {
      setDownloadError(res.error);
    }
  };

  useBackHandler(isExampleNameModalOpen, () => setIsExampleNameModalOpen(false), 30);

  // Register back navigation handler for expanded response modal
  useBackHandler(isExpandedModalOpen, () => setIsExpandedModalOpen(false), 25);

  // Close modal on Escape
  useEffect(() => {
    if (!isExpandedModalOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsExpandedModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isExpandedModalOpen]);

  // Response height mouse drag handler
  const handleStartResponseResize = (clientY: number) => {
    isResizingResponseRef.current = true;
    startResponseYRef.current = clientY;
    startResponseHeightRef.current = responseHeight;

    const onMouseMove = (e: MouseEvent) => {
      if (!isResizingResponseRef.current) return;
      const deltaY = e.clientY - startResponseYRef.current;
      const newHeight = Math.max(160, Math.min(1000, startResponseHeightRef.current + deltaY));
      setResponseHeight(newHeight);
    };

    const onMouseUp = () => {
      if (!isResizingResponseRef.current) return;
      isResizingResponseRef.current = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.style.removeProperty('user-select');
      document.body.style.removeProperty('cursor');
      try {
        setResponseHeight((curr) => {
          localStorage.setItem('airrest:response_editor_height', String(curr));
          return curr;
        });
      } catch {
        // ignore
      }
    };

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // Response height touch drag handler
  const handleTouchStartResponseResize = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    const startY = touch.clientY;
    const startH = responseHeight;

    const onTouchMove = (ev: TouchEvent) => {
      const t = ev.touches[0];
      if (!t) return;
      const deltaY = t.clientY - startY;
      const newHeight = Math.max(160, Math.min(1000, startH + deltaY));
      setResponseHeight(newHeight);
    };

    const onTouchEnd = () => {
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      try {
        setResponseHeight((curr) => {
          localStorage.setItem('airrest:response_editor_height', String(curr));
          return curr;
        });
      } catch {
        // ignore
      }
    };

    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd);
  };

  useEffect(() => {
    setImgDimensions(null);
    setDownloadError(null);
    setActiveTab(activeResponse?.scriptErrorStage === 'pre-request' ? 'scripts' : 'body');
  }, [activeResponse]);

  const handleCopy = () => {
    if (!activeResponse?.data) return;
    navigator.clipboard.writeText(activeResponse.data);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = async () => {
    const targetResponse = activeResponse;
    if (!targetResponse || isDownloadingRef.current) return;
    if (
      targetResponse.status === 0 &&
      (targetResponse.isError || targetResponse.failureKind || targetResponse.scriptErrorStage === 'pre-request')
    ) {
      return;
    }

    setDownloadError(null);
    isDownloadingRef.current = true;

    const adapter = runtimeAdapter;

    try {
      let bytes = targetResponse.rawBodyId ? getTrackedRawBody?.(targetResponse.rawBodyId) : undefined;
      if (!bytes && targetResponse.blobUrl) {
        const tracked = getTrackedBlob?.(targetResponse.blobUrl);
        if (tracked) {
          bytes = new Uint8Array(await tracked.arrayBuffer());
        }
      }

      if (!bytes) {
        if (latestResponseRef.current === targetResponse) {
          setDownloadError(
            'Original response body is no longer available in memory. Please re-run the request to download the original file.'
          );
        }
        return;
      }

      const ext = getExtensionFromMime(targetResponse.contentType || '');
      const filename = getFileNameFromHeaders(targetResponse.headers, ext);

      if (adapter?.saveFile) {
        await adapter.saveFile(filename, bytes, { mimeType: targetResponse.contentType });
        return;
      }

      const blob = new Blob([bytes as unknown as BlobPart], {
        type: 'application/octet-stream',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      if (a.style) a.style.display = 'none';
      document.body?.appendChild?.(a);
      a.click();
      a.remove?.();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err: unknown) {
      console.error('Failed to download response:', err);
      if (latestResponseRef.current === targetResponse) {
        setDownloadError(err instanceof Error ? err.message : 'Failed to save file.');
      }
    } finally {
      isDownloadingRef.current = false;
    }
  };

  const handleRequestHostPermission = async () => {
    const granted = await (runtimeAdapter?.requestHostPermission(targetUrl) ?? requestHostPermission(targetUrl));
    if (granted) {
      setPermissionMessage(null);
      sendRequest();
    } else {
      setPermissionMessage('Chrome did not grant access to this host. Check the extension site-access setting and try again.');
    }
  };

  const loadSampleAndSend = (url: string, method: 'GET' | 'POST' = 'GET', body = '') => {
    let path = url;
    try {
      path = new URL(url).pathname;
    } catch {
      path = url.replace(/^https?:\/\/[^/]+/i, '') || url;
    }
    updateActiveRequest({
      url,
      method,
      bodyType: body ? 'json' : 'none',
      bodyContent: body,
      name: `Sample: ${method} ${path}`,
    });
    setTimeout(() => {
      sendRequest();
    }, 100);
  };

  // Status badge styling helper
  const getStatusBadge = (status: number, statusText: string) => {
    if (status >= 200 && status < 300) {
      return (
        <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 font-mono text-xs font-bold text-emerald-600 dark:text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
          {status} {statusText}
        </span>
      );
    }
    if (status >= 300 && status < 400) {
      return (
        <span className="inline-flex items-center gap-1 rounded-md border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 font-mono text-xs font-bold text-sky-600 dark:text-sky-400">
          <span className="h-1.5 w-1.5 rounded-full bg-sky-500"></span>
          {status} {statusText}
        </span>
      );
    }
    if (status >= 400 && status < 500) {
      return (
        <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 font-mono text-xs font-bold text-amber-600 dark:text-amber-400">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500"></span>
          {status} {statusText}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 font-mono text-xs font-bold text-rose-600 dark:text-rose-400">
        <span className="h-1.5 w-1.5 rounded-full bg-rose-500"></span>
        {status || 'ERR'} {statusText}
      </span>
    );
  };

  // Format bytes to KB or MB
  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  let prettyJson = '';
  let isJson = false;
  if (activeResponse?.data) {
    try {
      const parsed = JSON.parse(activeResponse.data);
      prettyJson = JSON.stringify(parsed, null, 2);
      isJson = true;
    } catch {
      prettyJson = activeResponse.data;
      isJson = false;
    }
  }

  const isXml =
    !isJson &&
    typeof activeResponse?.data === 'string' &&
    (activeResponse?.contentType?.includes('xml') || activeResponse.data.trim().startsWith('<'));
  const responseLanguage: 'json' | 'xml' | 'text' = isJson ? 'json' : isXml ? 'xml' : 'text';

  return (
    <div className="flex min-w-0 flex-1 flex-col md:overflow-hidden bg-app">
      {/* Response Header Bar */}
      <div className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
        <div className="flex flex-wrap items-center gap-3 md:gap-4">
          <span className="text-xs font-bold uppercase tracking-wider text-tx-muted">Response</span>

          {activeResponse && !isLoading && (
            <div className="flex items-center gap-3">
              {getStatusBadge(activeResponse.status, activeResponse.statusText)}

              <div className="flex items-center gap-1 whitespace-nowrap font-mono text-xs text-tx-muted">
                <Clock className="h-3.5 w-3.5 text-tx-faint" />
                <span>{activeResponse.timeMs} ms</span>
              </div>

              <div className="flex items-center gap-1 whitespace-nowrap font-mono text-xs text-tx-muted">
                <HardDrive className="h-3.5 w-3.5 text-tx-faint" />
                <span>{formatBytes(activeResponse.sizeBytes)}</span>
              </div>
            </div>
          )}
        </div>

        {activeResponse && !isLoading && (
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 rounded-lg border border-line bg-card px-2.5 py-1 text-xs text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
              title="Copy to clipboard"
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-500 dark:text-emerald-400" />
                  <span className="text-emerald-600 dark:text-emerald-400">Copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5 text-tx-muted" />
                  <span>Copy</span>
                </>
              )}
            </button>

            {activeResponse.scriptError && (
              <button
                onClick={() => setActiveTab('scripts')}
                className={`flex items-center gap-1.5 pb-1 border-b-2 transition ${
                  activeTab === 'scripts'
                    ? 'border-rose-500 text-rose-600 dark:text-rose-300 font-semibold'
                    : 'border-transparent hover:text-tx-secondary'
                }`}
              >
                <AlertCircle className="h-3.5 w-3.5" />
                <span>Scripts</span>
                <span className="rounded-full border border-rose-500/20 bg-rose-500/10 px-1.5 text-[10px] text-rose-600 dark:text-rose-300">
                  failed
                </span>
              </button>
            )}

            {exampleEligibility?.eligible && (
              <button
                type="button"
                onClick={handleOpenSaveExample}
                disabled={Boolean(saveExampleDisabledReason) || isSavingExample}
                className="flex items-center gap-1 rounded-lg border border-line bg-card px-2.5 py-1 text-xs text-tx-secondary hover:bg-hover hover:text-tx-primary transition disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-card disabled:hover:text-tx-secondary"
                title={saveExampleDisabledReason || 'Save this response as a reusable Postman example'}
              >
                <BookmarkPlus className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400" />
                <span>Save as Example</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleDownload}
              disabled={isSyntheticError}
              className="flex items-center gap-1 rounded-lg border border-line bg-card px-2.5 py-1 text-xs text-tx-secondary hover:bg-hover hover:text-tx-primary transition disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-card disabled:hover:text-tx-secondary"
              title={isSyntheticError ? 'No server response body to download' : 'Download response'}
            >
              <Download className="h-3.5 w-3.5 text-tx-muted" />
              <span>Download</span>
            </button>

            <button
              type="button"
              onClick={() => setIsExpandedModalOpen(true)}
              className="flex items-center gap-1 rounded-lg border border-line bg-card px-2.5 py-1 text-xs text-tx-secondary hover:bg-hover hover:text-tx-primary transition cursor-pointer"
              title="Expand response to modal pop-up (Maximize)"
            >
              <Maximize2 className="h-3.5 w-3.5 text-tx-muted hover:text-sky-500" />
              <span>Expand</span>
            </button>
          </div>
        )}
      </div>

      {downloadError && (
        <div className="mx-4 mt-2 flex items-center justify-between rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0 text-rose-500 dark:text-rose-400" />
            <span>{downloadError}</span>
          </div>
          <button
            type="button"
            onClick={() => setDownloadError(null)}
            className="text-rose-500 dark:text-rose-400 hover:text-tx-primary transition"
          >
            ✕
          </button>
        </div>
      )}

      {/* Subtabs (Body vs Headers) when response exists */}
      {activeResponse && !isLoading && (
        <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-2">
          <div className="flex gap-4 text-xs font-medium text-tx-muted">
            <button
              onClick={() => setActiveTab('body')}
              className={`flex items-center gap-1.5 pb-1 border-b-2 transition ${
                activeTab === 'body'
                  ? 'border-sky-500 text-tx-primary font-semibold'
                  : 'border-transparent hover:text-tx-secondary'
              }`}
            >
              <Code2 className="h-3.5 w-3.5" />
              <span>Body</span>
              {activeResponse.isImage && (
                <span className="rounded-full bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/20 px-1.5 text-[10px]">
                  image
                </span>
              )}
              {activeResponse.isBinary && !activeResponse.isImage && (
                <span className="rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 px-1.5 text-[10px]">
                  binary
                </span>
              )}
            </button>

            <button
              onClick={() => setActiveTab('headers')}
              className={`flex items-center gap-1.5 pb-1 border-b-2 transition ${
                activeTab === 'headers'
                  ? 'border-sky-500 text-tx-primary font-semibold'
                  : 'border-transparent hover:text-tx-secondary'
              }`}
            >
              <FileText className="h-3.5 w-3.5" />
              <span>Headers</span>
              <span className="rounded-full bg-element px-1.5 text-[10px] text-tx-muted">
                {Object.keys(activeResponse.headers || {}).length}
              </span>
            </button>

            {activeResponse.testResults && activeResponse.testResults.length > 0 && (() => {
              const passed = activeResponse.testResults.filter((t) => t.passed).length;
              const total = activeResponse.testResults.length;
              const allPassed = passed === total;
              return (
                <button
                  onClick={() => setActiveTab('tests')}
                  className={`flex items-center gap-1.5 pb-1 border-b-2 transition ${
                    activeTab === 'tests'
                      ? 'border-sky-500 text-tx-primary font-semibold'
                      : 'border-transparent hover:text-tx-secondary'
                  }`}
                >
                  <FlaskConical className="h-3.5 w-3.5" />
                  <span>Test Results</span>
                  <span
                    className={`rounded-full px-1.5 text-[10px] font-semibold ${
                      allPassed
                        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                        : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
                    }`}
                  >
                    {passed}/{total}
                  </span>
                </button>
              );
            })()}
          </div>

          {activeTab === 'body' && (
            <div className="flex items-center gap-1.5">
              {isJson && (
                <div className="flex rounded-lg border border-line bg-element p-0.5 text-xs">
                  <button
                    onClick={() => setViewMode('pretty')}
                    className={`rounded px-2 py-0.5 transition ${
                      viewMode === 'pretty'
                        ? 'bg-card text-sky-600 dark:text-sky-400 font-semibold shadow-sm'
                        : 'text-tx-muted hover:text-tx-primary'
                    }`}
                  >
                    Pretty
                  </button>
                  <button
                    onClick={() => setViewMode('raw')}
                    className={`rounded px-2 py-0.5 transition ${
                      viewMode === 'raw'
                        ? 'bg-card text-sky-600 dark:text-sky-400 font-semibold shadow-sm'
                        : 'text-tx-muted hover:text-tx-primary'
                    }`}
                  >
                    Raw
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  responseEditorRef.current?.foldAll();
                  modalResponseEditorRef.current?.foldAll();
                }}
                className="flex items-center gap-1 rounded-md border border-line bg-card px-2 py-0.5 text-xs text-tx-muted hover:text-tx-primary hover:bg-hover transition cursor-pointer"
                title="Collapse all objects and lists"
              >
                <Minimize2 className="h-3 w-3" />
                <span>Collapse All</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  responseEditorRef.current?.unfoldAll();
                  modalResponseEditorRef.current?.unfoldAll();
                }}
                className="flex items-center gap-1 rounded-md border border-line bg-card px-2 py-0.5 text-xs text-tx-muted hover:text-tx-primary hover:bg-hover transition cursor-pointer"
                title="Expand all objects and lists"
              >
                <Maximize2 className="h-3 w-3" />
                <span>Expand All</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Main Response Content */}
      <div className="flex min-w-0 flex-1 flex-col md:overflow-auto p-4">
        {activeResponse && !isLoading && activeResponse.updatedEnvVars && activeResponse.updatedEnvVars.length > 0 && (
          <div className="mb-4 flex shrink-0 items-center gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-600 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500 dark:text-emerald-400" />
            <div>
              <span className="font-semibold">Environment Variables Updated: </span>
              <span className="font-mono">
                {activeResponse.updatedEnvVars.map((k) => `{{${k}}}`).join(', ')}
              </span>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="my-auto flex shrink-0 flex-col items-center justify-center space-y-3 py-6 text-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-sky-500 border-t-transparent" />
            <p className="text-xs text-tx-muted font-mono animate-pulse">
              Dispatching request via Hybrid Engine...
            </p>
          </div>
        ) : !activeResponse ? (
          /* Empty State with Quick-Start Templates */
          <div className="my-auto mx-auto flex w-full max-w-md shrink-0 flex-col items-center py-6 md:py-12 text-center">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-tr from-sky-500/10 to-indigo-500/10 border border-sky-500/20 text-sky-500 dark:text-sky-400 shadow-xl">
              <Sparkles className="h-6 w-6" />
            </div>
            <h3 className="mt-4 text-sm font-semibold text-tx-primary">Ready to Test APIs</h3>
            <p className="mt-1.5 text-xs text-tx-muted leading-relaxed">
              Enter an endpoint above and click <span className="text-sky-500 dark:text-sky-400 font-semibold">Send</span>, or try one of these instant test endpoints:
            </p>

            <div className="mt-6 w-full space-y-2">
              <button
                onClick={() =>
                  loadSampleAndSend('https://jsonplaceholder.typicode.com/todos/1', 'GET')
                }
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-line bg-card p-3 text-left hover:border-sky-500/40 hover:bg-hover transition group"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="shrink-0 font-mono text-[10px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded">
                    GET
                  </span>
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-tx-primary">
                      JSONPlaceholder Todo
                    </div>
                    <div className="text-[11px] font-mono text-tx-muted break-all">
                      https://jsonplaceholder.typicode.com/todos/1
                    </div>
                  </div>
                </div>
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-tx-muted group-hover:text-sky-500 transition" />
              </button>

              <button
                onClick={() =>
                  loadSampleAndSend('https://httpbin.org/get?user=tester&tag=api', 'GET')
                }
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-line bg-card p-3 text-left hover:border-sky-500/40 hover:bg-hover transition group"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="shrink-0 font-mono text-[10px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded">
                    GET
                  </span>
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-tx-primary">
                      HTTPBin Echo Query
                    </div>
                    <div className="text-[11px] font-mono text-tx-muted break-all">
                      https://httpbin.org/get?user=tester&tag=api
                    </div>
                  </div>
                </div>
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-tx-muted group-hover:text-sky-500 transition" />
              </button>

              <button
                onClick={() =>
                  loadSampleAndSend(
                    'https://jsonplaceholder.typicode.com/posts',
                    'POST',
                    JSON.stringify({ title: 'New Post', body: 'Tested with AirREST', userId: 1 }, null, 2)
                  )
                }
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-line bg-card p-3 text-left hover:border-sky-500/40 hover:bg-hover transition group"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="shrink-0 font-mono text-[10px] font-bold text-sky-600 dark:text-sky-400 bg-sky-500/10 border border-sky-500/20 px-1.5 py-0.5 rounded">
                    POST
                  </span>
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-tx-primary">
                      Create Post Payload
                    </div>
                    <div className="text-[11px] font-mono text-tx-muted break-all">
                      https://jsonplaceholder.typicode.com/posts
                    </div>
                  </div>
                </div>
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-tx-muted group-hover:text-sky-500 transition" />
              </button>
            </div>
          </div>
        ) : activeTab === 'scripts' ? (
          <div className="shrink-0 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-700 dark:text-rose-200 shadow-sm">
            <div className="flex items-start gap-2.5">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500 dark:text-rose-400" />
              <div className="min-w-0 space-y-2">
                <p className="font-semibold text-rose-700 dark:text-rose-200">
                  {activeResponse.scriptErrorStage === 'pre-request'
                    ? 'Pre-request Script Failed — Request not sent'
                    : 'Post-response Script Failed'}
                </p>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-rose-500/20 bg-card p-3 font-mono text-[11px] leading-relaxed text-rose-800 dark:text-rose-100">
                  {activeResponse.scriptError || 'No script error details were provided.'}
                </pre>
              </div>
            </div>
          </div>
        ) : activeTab === 'body' ? (
          <div
            className={
              activeResponse.isImage || activeResponse.isBinary
                ? 'shrink-0'
                : 'flex flex-col max-md:shrink-0 md:min-h-0 md:flex-1'
            }
          >
            {activeResponse.isError && activeResponse.status === 0 && (
              <div className="mb-4 shrink-0">
                {activeResponse.failureKind ? (
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-800 dark:text-amber-100 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 font-semibold text-amber-600 dark:text-amber-300">
                        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500 dark:text-amber-400" />
                        <span>{activeResponse.statusText}</span>
                      </div>
                      {activeResponse.failureKind !== 'cancelled' && (
                        <button
                          type="button"
                          onClick={() => sendRequest()}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 py-1 text-[11px] font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
                        >
                          <RotateCw className="h-3 w-3 text-sky-500 dark:text-sky-400" />
                          <span>Retry Request</span>
                        </button>
                      )}
                      {activeResponse.failureKind === 'host_permission' && (
                        <button
                          type="button"
                          onClick={handleRequestHostPermission}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/15 px-2.5 py-1 text-[11px] font-semibold text-sky-700 dark:text-sky-100 hover:bg-sky-500/25 transition"
                        >
                          <ShieldAlert className="h-3 w-3" />
                          <span>Request Host Permission</span>
                        </button>
                      )}
                    </div>
                    <p className="mt-2 leading-relaxed text-amber-900 dark:text-amber-100">{activeResponse.errorDetail || activeResponse.data}</p>
                    {permissionMessage && <p className="mt-2 text-amber-800 dark:text-amber-200">{permissionMessage}</p>}
                  </div>
                ) : netCategory === 'ssl' || (netCode && (netCode.includes('CERT') || netCode.includes('AUTHORITY'))) ? (
                  /* 1. Verified SSL Certificate Error */
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-800 dark:text-amber-200 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/20 pb-3">
                      <div className="flex items-center gap-2 font-semibold text-amber-700 dark:text-amber-300">
                        <ShieldAlert className="h-4 w-4 shrink-0 text-amber-500 dark:text-amber-400" />
                        <span>Untrusted SSL / Self-Signed Certificate Detected</span>
                        {netCode && (
                          <span className="rounded bg-amber-500/20 border border-amber-500/30 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-300">
                            {netCode}
                          </span>
                        )}
                      </div>
                      {isSafeTargetUrl && (
                        <div className="flex items-center gap-2">
                          <a
                            href={targetUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/20 px-2.5 py-1 text-[11px] font-semibold text-amber-800 dark:text-amber-100 hover:bg-amber-500/30 hover:text-amber-900 dark:hover:text-white transition shadow-sm"
                            title="Open URL in new browser tab"
                          >
                            <span>Open URL in New Tab</span>
                            <ExternalLink className="h-3 w-3" />
                          </a>
                          <button
                            type="button"
                            onClick={() => sendRequest()}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 py-1 text-[11px] font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
                            title="Retry sending this request"
                          >
                            <RotateCw className="h-3 w-3 text-sky-500 dark:text-sky-400" />
                            <span>Retry Request</span>
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="mt-3 space-y-2.5">
                      <p className="text-amber-800/90 dark:text-amber-200/90 leading-relaxed font-sans">
                        Chrome blocked this HTTPS request because the server certificate is self-signed, invalid, or expired.
                      </p>
                      <div className="rounded-lg bg-black/10 dark:bg-black/25 p-3 border border-amber-500/20">
                        <div className="font-semibold text-amber-800 dark:text-amber-300 mb-1.5">To allow this endpoint:</div>
                        <ol className="list-decimal list-inside space-y-1.5 text-amber-800/90 dark:text-amber-100/90 font-sans text-[11px] leading-relaxed">
                          <li>
                            Click <strong className="text-amber-700 dark:text-amber-300">Open URL in New Tab</strong> above to open the endpoint in a new Chrome tab.
                          </li>
                          <li>
                            On Chrome's security warning page, click <strong className="text-tx-primary underline underline-offset-2">Advanced</strong> (or <em>Lanjutan</em>) and select <strong className="text-tx-primary underline underline-offset-2">Proceed to ... (unsafe)</strong>.
                          </li>
                          <li>
                            Once authorized in that tab, return here and click <strong className="text-sky-600 dark:text-sky-300">Retry Request</strong> (or <strong>Send</strong>).
                          </li>
                        </ol>
                      </div>
                      <div className="text-[11px] text-amber-800/70 dark:text-amber-200/70 font-sans flex flex-wrap items-center gap-1.5 pt-1">
                        <span>Target endpoint:</span>
                        <code className="text-tx-primary bg-element px-1.5 py-0.5 rounded font-mono break-all">{targetUrl}</code>
                      </div>
                    </div>
                  </div>
                ) : netCategory === 'connection_refused' ? (
                  /* 2. Connection Refused / Server Offline (HTTP or HTTPS) */
                  <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-700 dark:text-rose-300 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rose-500/20 pb-3">
                      <div className="flex items-center gap-2 font-semibold text-rose-700 dark:text-rose-300">
                        <ServerOff className="h-4 w-4 shrink-0 text-rose-500 dark:text-rose-400" />
                        <span>Server Offline / Connection Refused</span>
                        <span className="rounded bg-rose-500/20 border border-rose-500/30 px-1.5 py-0.5 font-mono text-[10px] text-rose-700 dark:text-rose-300">
                          {netCode || 'net::ERR_CONNECTION_REFUSED'}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => sendRequest()}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 py-1 text-[11px] font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
                        title="Retry sending this request"
                      >
                        <RotateCw className="h-3 w-3 text-sky-500 dark:text-sky-400" />
                        <span>Retry Request</span>
                      </button>
                    </div>
                    <div className="mt-3 space-y-2">
                      <p className="text-rose-800/90 dark:text-rose-200/90 leading-relaxed font-sans">
                        No active server is listening on port <span className="font-mono text-tx-primary font-semibold">{targetPort || 'specified'}</span> at <span className="font-mono text-tx-primary font-semibold">{targetHost}</span>.
                      </p>
                      <ul className="mt-2 list-disc list-inside space-y-1 text-rose-700/80 dark:text-rose-300/80 font-mono text-[11px]">
                        <li>Make sure your backend server process has been started (e.g. <span className="text-tx-primary">npm run dev</span>, <span className="text-tx-primary">go run</span>, Docker).</li>
                        <li>Verify that port <span className="text-tx-primary font-semibold">{targetPort}</span> matches your server's listening port.</li>
                      </ul>
                      <div className="text-[11px] text-rose-700/70 dark:text-rose-300/70 font-sans flex flex-wrap items-center gap-1.5 pt-1">
                        <span>Target:</span>
                        <code className="text-tx-primary bg-element px-1.5 py-0.5 rounded font-mono break-all">{targetUrl}</code>
                      </div>
                    </div>
                  </div>
                ) : netCategory === 'dns' ? (
                  /* 3. DNS / Hostname Not Found */
                  <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-700 dark:text-rose-300 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rose-500/20 pb-3">
                      <div className="flex items-center gap-2 font-semibold text-rose-700 dark:text-rose-300">
                        <Globe className="h-4 w-4 shrink-0 text-rose-500 dark:text-rose-400" />
                        <span>Hostname Not Found / DNS Error</span>
                        <span className="rounded bg-rose-500/20 border border-rose-500/30 px-1.5 py-0.5 font-mono text-[10px] text-rose-700 dark:text-rose-300">
                          {netCode || 'net::ERR_NAME_NOT_RESOLVED'}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => sendRequest()}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 py-1 text-[11px] font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
                        title="Retry sending this request"
                      >
                        <RotateCw className="h-3 w-3 text-sky-500 dark:text-sky-400" />
                        <span>Retry Request</span>
                      </button>
                    </div>
                    <div className="mt-3 space-y-2">
                      <p className="text-rose-800/90 dark:text-rose-200/90 leading-relaxed font-sans">
                        The host <span className="font-mono text-tx-primary font-semibold">{targetHost}</span> could not be resolved by your DNS server.
                      </p>
                      <ul className="mt-2 list-disc list-inside space-y-1 text-rose-700/80 dark:text-rose-300/80 font-mono text-[11px]">
                        <li>Check for typos in the hostname or domain name.</li>
                        <li>Verify if you need to connect to an internal VPN or configure your local <code className="text-tx-primary">/etc/hosts</code> file.</li>
                      </ul>
                      <div className="text-[11px] text-rose-700/70 dark:text-rose-300/70 font-sans flex flex-wrap items-center gap-1.5 pt-1">
                        <span>Target:</span>
                        <code className="text-tx-primary bg-element px-1.5 py-0.5 rounded font-mono break-all">{targetUrl}</code>
                      </div>
                    </div>
                  </div>
                ) : netCategory === 'timeout' ? (
                  /* 4. Connection Timed Out */
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-800 dark:text-amber-200 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/20 pb-3">
                      <div className="flex items-center gap-2 font-semibold text-amber-700 dark:text-amber-300">
                        <Clock className="h-4 w-4 shrink-0 text-amber-500 dark:text-amber-400" />
                        <span>Connection Timed Out</span>
                        <span className="rounded bg-amber-500/20 border border-amber-500/30 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-300">
                          {netCode || 'net::ERR_TIMED_OUT'}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => sendRequest()}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 py-1 text-[11px] font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
                        title="Retry sending this request"
                      >
                        <RotateCw className="h-3 w-3 text-sky-500 dark:text-sky-400" />
                        <span>Retry Request</span>
                      </button>
                    </div>
                    <div className="mt-3 space-y-2">
                      <p className="text-amber-800/90 dark:text-amber-200/90 leading-relaxed font-sans">
                        The server at <span className="font-mono text-tx-primary font-semibold">{targetHost}</span> took too long to respond.
                      </p>
                      <ul className="mt-2 list-disc list-inside space-y-1 text-amber-800/80 dark:text-amber-200/80 font-mono text-[11px]">
                        <li>Verify if the server process is hanging, overloaded, or blocked by a network firewall.</li>
                      </ul>
                    </div>
                  </div>
                ) : (
                  /* 5. General Fallback Card */
                  <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-700 dark:text-rose-300 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rose-500/20 pb-3">
                      <div className="flex items-center gap-2 font-semibold text-rose-700 dark:text-rose-300">
                        <AlertTriangle className="h-4 w-4 shrink-0 text-rose-500 dark:text-rose-400" />
                        <span>Connection / Network Failure</span>
                        {netCode && (
                          <span className="rounded bg-rose-500/20 border border-rose-500/30 px-1.5 py-0.5 font-mono text-[10px] text-rose-700 dark:text-rose-300">
                            {netCode}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {isHttps && isSafeTargetUrl && (
                          <a
                            href={targetUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/20 px-2.5 py-1 text-[11px] font-semibold text-rose-800 dark:text-rose-100 hover:bg-rose-500/30 hover:text-white transition shadow-sm"
                            title="Open URL in new browser tab to check SSL or certificate"
                          >
                            <span>Open in Tab</span>
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() => sendRequest()}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 py-1 text-[11px] font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
                          title="Retry sending this request"
                        >
                          <RotateCw className="h-3 w-3 text-sky-500 dark:text-sky-400" />
                          <span>Retry Request</span>
                        </button>
                      </div>
                    </div>
                    <p className="mt-2 text-rose-800/90 dark:text-rose-200/90 leading-relaxed font-sans">
                      The request could not reach the server or was terminated by browser network security policy.
                    </p>
                    <ul className="mt-2 list-disc list-inside space-y-1 text-rose-700/80 dark:text-rose-300/80 font-mono text-[11px]">
                      <li>Ensure your server is actively running on port <span className="text-tx-primary font-mono">{targetPort}</span>.</li>
                      {isHttps && (
                        <li>If testing local HTTPS: the certificate might be self-signed (click <span className="text-tx-primary">Open in Tab</span> to verify).</li>
                      )}
                      {targetUrl && (
                        <li className="break-all font-sans">
                          Target endpoint: <span className="font-mono text-tx-primary">{targetUrl}</span>
                        </li>
                      )}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {activeResponse.isImage && activeResponse.blobUrl ? (
              /* Image Response Preview */
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-card p-3 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="flex items-center gap-1.5 rounded-lg bg-sky-500/10 border border-sky-500/20 px-2 py-0.5 font-mono text-[11px] font-semibold text-sky-600 dark:text-sky-400">
                      <ImageIcon className="h-3.5 w-3.5" />
                      <span>{activeResponse.contentType || 'image'}</span>
                    </span>
                    <span className="text-[11px] text-tx-muted font-mono">
                      {formatBytes(activeResponse.sizeBytes)}
                    </span>
                    {imgDimensions && (
                      <span className="rounded bg-element px-1.5 py-0.5 text-[10px] text-tx-muted font-mono">
                        {imgDimensions.width} × {imgDimensions.height} px
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {!activeResponse.contentType?.toLowerCase().includes('svg') && (
                      <a
                        href={activeResponse.blobUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
                        title="Open full-resolution image in new browser tab"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        <span>Open in New Tab</span>
                      </a>
                    )}

                    <button
                      type="button"
                      onClick={handleDownload}
                      className="flex items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-xs font-semibold text-sky-600 dark:text-sky-300 hover:bg-sky-500/20 transition"
                      title="Download image file"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Download Image</span>
                    </button>
                  </div>
                </div>

                <div className="flex min-h-[300px] max-h-[620px] items-center justify-center overflow-auto rounded-xl border border-line bg-card/60 p-6 [background-image:radial-gradient(var(--border-subtle)_1px,transparent_1px)] [background-size:16px_16px]">
                  <img
                    src={activeResponse.blobUrl}
                    alt="Response Preview"
                    onLoad={(e) => {
                      const img = e.currentTarget;
                      setImgDimensions({ width: img.naturalWidth, height: img.naturalHeight });
                    }}
                    className="max-h-[560px] max-w-full rounded-lg object-contain shadow-2xl transition duration-200"
                  />
                </div>
              </div>
            ) : activeResponse.isBinary ? (
              /* Binary Non-Image File */
              <div className="flex min-h-[260px] flex-col items-center justify-center rounded-xl border border-dashed border-line bg-card/40 p-8 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-500 dark:text-amber-400 shadow-lg">
                  <FileDown className="h-7 w-7" />
                </div>
                <h3 className="mt-4 text-sm font-semibold text-tx-primary">
                  binary file
                </h3>
                <p className="mt-1 text-xs text-tx-muted max-w-sm">
                  The server returned binary content (
                  <code className="text-tx-secondary font-mono">{activeResponse.contentType || 'application/octet-stream'}</code>
                  , {formatBytes(activeResponse.sizeBytes)}).
                </p>

                <button
                  type="button"
                  onClick={handleDownload}
                  className="mt-5 flex items-center gap-2 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 px-5 py-2.5 font-semibold text-xs text-white shadow-lg shadow-sky-500/20 hover:from-sky-400 hover:to-blue-500 active:scale-95 transition"
                >
                  <Download className="h-4 w-4" />
                  <span>Download</span>
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-1 md:min-h-0 md:flex-1">
                <div
                  style={{ '--response-editor-height': `${responseHeight}px` } as React.CSSProperties}
                  className="flex flex-col max-md:h-[var(--response-editor-height)] md:min-h-0 md:flex-1"
                >
                  <CodeEditor
                    ref={responseEditorRef}
                    value={viewMode === 'pretty' ? prettyJson : activeResponse.data}
                    readOnly={true}
                    language={responseLanguage}
                    height="100%"
                    minHeight={140}
                    className="min-h-0 flex-1 w-full"
                  />
                </div>
                <div
                  onMouseDown={(e) => handleStartResponseResize(e.clientY)}
                  onTouchStart={handleTouchStartResponseResize}
                  onDoubleClick={() => {
                    setResponseHeight(400);
                    try {
                      localStorage.setItem('airrest:response_editor_height', '400');
                    } catch {
                      // ignore
                    }
                  }}
                  className="flex md:hidden items-center justify-center py-1 cursor-row-resize hover:bg-hover/60 rounded-md transition select-none group"
                  title="Drag up/down to resize response height (Double-click to reset)"
                >
                  <div className="flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-element/50 group-hover:bg-element border border-transparent group-hover:border-line transition">
                    <GripHorizontal className="h-3.5 w-3.5 text-tx-muted group-hover:text-sky-500 transition" />
                    <span className="text-[10px] font-mono text-tx-muted group-hover:text-tx-secondary hidden group-hover:inline">
                      {responseHeight}px (Drag to resize)
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : activeTab === 'tests' ? (
          <div className="shrink-0 space-y-2">
            {activeResponse.testResults && activeResponse.testResults.length > 0 ? (
              activeResponse.testResults.map((t, idx) => (
                <div
                  key={`${t.name}-${idx}`}
                  className={`rounded-xl border px-3.5 py-2.5 text-xs ${
                    t.passed
                      ? 'border-emerald-500/25 bg-emerald-500/5'
                      : 'border-rose-500/30 bg-rose-500/5'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {t.passed ? (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                      ) : (
                        <XCircle className="h-4 w-4 shrink-0 text-rose-500" />
                      )}
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          t.passed
                            ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                            : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
                        }`}
                      >
                        {t.passed ? 'PASS' : 'FAIL'}
                      </span>
                      <span className="font-medium text-tx-primary break-words">{t.name}</span>
                    </div>
                    {typeof t.durationMs === 'number' && (
                      <span className="shrink-0 font-mono text-[10px] text-tx-muted">
                        {t.durationMs} ms
                      </span>
                    )}
                  </div>
                  {!t.passed && t.error && (
                    <div className="mt-1.5 rounded-lg bg-rose-500/10 px-2.5 py-1.5 font-mono text-[11px] text-rose-600 dark:text-rose-300 break-words">
                      {t.error}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div className="rounded-xl border border-dashed border-line p-6 text-center text-xs text-tx-muted">
                No test assertions recorded for this response.
              </div>
            )}
          </div>
        ) : (
          /* Response Headers Table */
          <div className="shrink-0 overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full text-left text-xs font-mono">
              <thead className="border-b border-line bg-element text-tx-muted">
                <tr>
                  <th className="px-4 py-2 font-semibold">Header Key</th>
                  <th className="px-4 py-2 font-semibold">Header Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {Object.entries(activeResponse.headers || {}).map(([key, value]) => (
                  <tr key={key} className="hover:bg-hover transition">
                    <td className="px-4 py-2 text-sky-600 dark:text-sky-400 font-medium">{key}</td>
                    <td className="px-4 py-2 text-tx-secondary break-all">{String(value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* EXPANDED FULL-SCREEN / LARGE RESPONSE MODAL */}
      {isExpandedModalOpen && activeResponse && (
        <div data-modal="true" role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-3 md:p-6 animate-in fade-in duration-150">
          <div className="flex flex-col w-full max-w-6xl h-[92vh] max-h-[960px] rounded-2xl border border-line bg-surface shadow-2xl overflow-hidden">
            {/* Modal Header */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3 bg-element/40 shrink-0">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm font-bold uppercase tracking-wider text-tx-primary">Response</span>
                {getStatusBadge(activeResponse.status, activeResponse.statusText)}

                <div className="flex items-center gap-1 whitespace-nowrap font-mono text-xs text-tx-muted">
                  <Clock className="h-3.5 w-3.5 text-tx-faint" />
                  <span>{activeResponse.timeMs} ms</span>
                </div>

                <div className="flex items-center gap-1 whitespace-nowrap font-mono text-xs text-tx-muted">
                  <HardDrive className="h-3.5 w-3.5 text-tx-faint" />
                  <span>{formatBytes(activeResponse.sizeBytes)}</span>
                </div>

                {/* Subtabs inside Modal Header */}
                <div className="flex items-center gap-3 ml-2 border-l border-line pl-3 text-xs">
                  <button
                    type="button"
                    onClick={() => setActiveTab('body')}
                    className={`flex items-center gap-1 pb-0.5 border-b-2 font-medium transition ${
                      activeTab === 'body'
                        ? 'border-sky-500 text-tx-primary font-semibold'
                        : 'border-transparent text-tx-muted hover:text-tx-secondary'
                    }`}
                  >
                    <Code2 className="h-3.5 w-3.5" />
                    <span>Body</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('headers')}
                    className={`flex items-center gap-1 pb-0.5 border-b-2 font-medium transition ${
                      activeTab === 'headers'
                        ? 'border-sky-500 text-tx-primary font-semibold'
                        : 'border-transparent text-tx-muted hover:text-tx-secondary'
                    }`}
                  >
                    <FileText className="h-3.5 w-3.5" />
                    <span>Headers</span>
                    <span className="rounded-full bg-element px-1 text-[10px] text-tx-muted">
                      {Object.keys(activeResponse.headers || {}).length}
                    </span>
                  </button>
                  {activeResponse.testResults && activeResponse.testResults.length > 0 && (() => {
                    const passed = activeResponse.testResults.filter((t) => t.passed).length;
                    const total = activeResponse.testResults.length;
                    const allPassed = passed === total;
                    return (
                      <button
                        type="button"
                        onClick={() => setActiveTab('tests')}
                        className={`flex items-center gap-1 pb-0.5 border-b-2 font-medium transition ${
                          activeTab === 'tests'
                            ? 'border-sky-500 text-tx-primary font-semibold'
                            : 'border-transparent text-tx-muted hover:text-tx-secondary'
                        }`}
                      >
                        <FlaskConical className="h-3.5 w-3.5" />
                        <span>Test Results</span>
                        <span
                          className={`rounded-full px-1 text-[10px] font-semibold ${
                            allPassed
                              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                              : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
                          }`}
                        >
                          {passed}/{total}
                        </span>
                      </button>
                    );
                  })()}
                </div>

                {activeTab === 'body' && isJson && (
                  <div className="flex rounded-lg border border-line bg-element p-0.5 text-xs ml-1">
                    <button
                      type="button"
                      onClick={() => setViewMode('pretty')}
                      className={`rounded px-2 py-0.5 transition ${
                        viewMode === 'pretty'
                          ? 'bg-card text-sky-600 dark:text-sky-400 font-semibold shadow-sm'
                          : 'text-tx-muted hover:text-tx-primary'
                      }`}
                    >
                      Pretty
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode('raw')}
                      className={`rounded px-2 py-0.5 transition ${
                        viewMode === 'raw'
                          ? 'bg-card text-sky-600 dark:text-sky-400 font-semibold shadow-sm'
                          : 'text-tx-muted hover:text-tx-primary'
                      }`}
                    >
                      Raw
                    </button>
                  </div>
                )}
              </div>

              {/* Modal Actions */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCopy}
                  className="flex items-center gap-1 rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs text-tx-secondary hover:bg-hover hover:text-tx-primary transition cursor-pointer"
                  title="Copy to clipboard"
                >
                  {copied ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-500 dark:text-emerald-400" />
                      <span className="text-emerald-600 dark:text-emerald-400 font-semibold">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5 text-tx-muted" />
                      <span>Copy</span>
                    </>
                  )}
                </button>

                {exampleEligibility?.eligible && (
                  <button
                    type="button"
                    onClick={handleOpenSaveExample}
                    disabled={Boolean(saveExampleDisabledReason) || isSavingExample}
                    className="flex items-center gap-1 rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs text-tx-secondary hover:bg-hover hover:text-tx-primary transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-card disabled:hover:text-tx-secondary"
                    title={saveExampleDisabledReason || 'Save this response as a reusable Postman example'}
                  >
                    <BookmarkPlus className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400" />
                    <span>Save as Example</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleDownload}
                  disabled={isSyntheticError}
                  className="flex items-center gap-1 rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs text-tx-secondary hover:bg-hover hover:text-tx-primary transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-card disabled:hover:text-tx-secondary"
                  title={isSyntheticError ? 'No server response body to download' : 'Download response'}
                >
                  <Download className="h-3.5 w-3.5 text-tx-muted" />
                  <span>Download</span>
                </button>

                <button
                  type="button"
                  onClick={() => setIsExpandedModalOpen(false)}
                  className="flex items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-1.5 text-xs font-semibold text-tx-primary hover:bg-hover transition cursor-pointer ml-1"
                  title="Collapse modal (Esc)"
                >
                  <Minimize2 className="h-3.5 w-3.5 text-tx-muted" />
                  <span>Collapse</span>
                </button>
              </div>
            </div>

            {/* Modal Body */}
            <div className="flex-1 min-h-0 p-5 overflow-auto bg-app">
              {downloadError && (
                <div className="mb-4 flex items-center justify-between rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 shrink-0 text-rose-500 dark:text-rose-400" />
                    <span>{downloadError}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDownloadError(null)}
                    className="text-rose-500 dark:text-rose-400 hover:text-tx-primary transition"
                  >
                    ✕
                  </button>
                </div>
              )}
              {activeTab === 'body' ? (
                activeResponse.isImage && activeResponse.blobUrl ? (
                  <div className="flex min-h-[400px] h-full items-center justify-center overflow-auto rounded-xl border border-line bg-card/60 p-6">
                    <img
                      src={activeResponse.blobUrl}
                      alt="Response Preview"
                      className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
                    />
                  </div>
                ) : activeResponse.isBinary ? (
                  <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-line bg-card/40 p-8 text-center">
                    <FileDown className="h-10 w-10 text-amber-500" />
                    <p className="mt-3 text-sm font-semibold">Binary response data ({formatBytes(activeResponse.sizeBytes)})</p>
                    <button
                      type="button"
                      onClick={handleDownload}
                      className="mt-4 flex items-center gap-2 rounded-xl bg-sky-500 px-4 py-2 font-semibold text-xs text-white"
                    >
                      <Download className="h-4 w-4" />
                      <span>Download File</span>
                    </button>
                  </div>
                ) : (
                  <CodeEditor
                    ref={modalResponseEditorRef}
                    value={viewMode === 'pretty' ? prettyJson : activeResponse.data}
                    readOnly={true}
                    language={responseLanguage}
                    height="100%"
                    className="h-full w-full"
                  />
                )
              ) : activeTab === 'tests' ? (
                <div className="space-y-2 overflow-y-auto h-full pr-1">
                  {activeResponse.testResults && activeResponse.testResults.length > 0 ? (
                    activeResponse.testResults.map((t, idx) => (
                      <div
                        key={`${t.name}-${idx}`}
                        className={`rounded-xl border px-3.5 py-2.5 text-xs ${
                          t.passed
                            ? 'border-emerald-500/25 bg-emerald-500/5'
                            : 'border-rose-500/30 bg-rose-500/5'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            {t.passed ? (
                              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                            ) : (
                              <XCircle className="h-4 w-4 shrink-0 text-rose-500" />
                            )}
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                                t.passed
                                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                  : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
                              }`}
                            >
                              {t.passed ? 'PASS' : 'FAIL'}
                            </span>
                            <span className="font-medium text-tx-primary break-words">{t.name}</span>
                          </div>
                          {typeof t.durationMs === 'number' && (
                            <span className="shrink-0 font-mono text-[10px] text-tx-muted">
                              {t.durationMs} ms
                            </span>
                          )}
                        </div>
                        {!t.passed && t.error && (
                          <div className="mt-1.5 rounded-lg bg-rose-500/10 px-2.5 py-1.5 font-mono text-[11px] text-rose-600 dark:text-rose-300 break-words">
                            {t.error}
                          </div>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="rounded-xl border border-dashed border-line p-6 text-center text-xs text-tx-muted">
                      No test assertions recorded for this response.
                    </div>
                  )}
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border border-line bg-surface">
                  <table className="w-full text-left text-xs font-mono">
                    <thead className="border-b border-line bg-element text-tx-muted">
                      <tr>
                        <th className="px-4 py-2 font-semibold">Header Key</th>
                        <th className="px-4 py-2 font-semibold">Header Value</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {Object.entries(activeResponse.headers || {}).map(([key, value]) => (
                        <tr key={key} className="hover:bg-hover transition">
                          <td className="px-4 py-2 text-sky-600 dark:text-sky-400 font-medium">{key}</td>
                          <td className="px-4 py-2 text-tx-secondary break-all">{String(value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between border-t border-line px-5 py-2.5 bg-element/30 text-xs text-tx-muted shrink-0">
              <span className="text-[11px]">Press <kbd className="rounded border border-line bg-card px-1.5 py-0.5 font-mono text-[10px] text-tx-primary">Esc</kbd> or click <b>Collapse</b> to return to workspace.</span>
              <button
                type="button"
                onClick={() => setIsExpandedModalOpen(false)}
                className="rounded-lg bg-sky-500 hover:bg-sky-600 text-white font-medium px-4 py-1 text-xs transition shadow-sm cursor-pointer"
              >
                Collapse
              </button>
            </div>
          </div>
        </div>
      )}

      {isExampleNameModalOpen && (
        <div
          data-modal="true"
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div className="flex items-center gap-2">
                <BookmarkPlus className="h-4 w-4 text-sky-500" />
                <h3 className="text-sm font-semibold text-tx-primary">Save as Example</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsExampleNameModalOpen(false)}
                className="rounded p-1 text-tx-muted hover:bg-hover hover:text-tx-primary"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 space-y-3">
              <label className="block text-xs font-medium text-tx-secondary">
                Example Name
              </label>
              <input
                type="text"
                autoFocus
                maxLength={MAX_SAVED_EXAMPLE_NAME_RUNES}
                value={exampleNameInput}
                onChange={(e) => setExampleNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isSavingExample) {
                    void handleConfirmSaveExample();
                  } else if (e.key === 'Escape') {
                    setIsExampleNameModalOpen(false);
                  }
                }}
                placeholder="e.g. 200 OK"
                className="w-full rounded-lg border border-line bg-card px-3 py-2 text-xs text-tx-primary focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
              />
              {exampleSaveError && (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">
                  {exampleSaveError}
                </div>
              )}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsExampleNameModalOpen(false)}
                className="rounded-lg border border-line bg-card px-3 py-1.5 text-xs font-medium text-tx-secondary hover:bg-hover transition"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isSavingExample}
                onClick={() => void handleConfirmSaveExample()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-sky-600 transition disabled:opacity-50"
              >
                {isSavingExample && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <span>Save Example</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {saveToCollectionModalRequest && (
        <SaveToCollectionModal
          isOpen
          onClose={() => {
            setSaveToCollectionModalRequest(null);
            pendingExampleDraftRef.current = null;
          }}
          request={saveToCollectionModalRequest}
          onSaveCommitted={(res) => void handleSaveToCollectionCommitted(res)}
        />
      )}
    </div>
  );
};
