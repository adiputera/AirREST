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
} from 'lucide-react';
import { useApiStore } from '../store/useApiStore';
import { requestHostPermission } from '../lib/hostPermissions';
import { getDefaultPlatformAdapter } from '../lib/fetcher';
import { getTrackedBlob } from '../lib/blobManager';

function getExtensionFromMime(mime: string): string {
  const m = (mime || '').toLowerCase();
  if (m.includes('webp')) return '.webp';
  if (m.includes('png')) return '.png';
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  if (m.includes('gif')) return '.gif';
  if (m.includes('svg')) return '.svg';
  if (m.includes('avif')) return '.avif';
  if (m.includes('bmp')) return '.bmp';
  if (m.includes('pdf')) return '.pdf';
  if (m.includes('json')) return '.json';
  if (m.includes('zip')) return '.zip';
  if (m.includes('gzip') || m.includes('tar')) return '.tar.gz';
  if (m.includes('audio/mpeg') || m.includes('mp3')) return '.mp3';
  if (m.includes('audio/wav')) return '.wav';
  if (m.includes('video/mp4')) return '.mp4';
  if (m.includes('text/html') || m.includes('html')) return '.html';
  if (m.includes('text/plain') || m.includes('plain')) return '.txt';
  return '.bin';
}

export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function getFileNameFromHeaders(headers: Record<string, string> = {}, defaultExt: string): string {
  const disposition = headers['content-disposition'] || headers['Content-Disposition'];
  if (disposition) {
    const match = /filename\*?=['"]?(?:UTF-\d['"]*)?([^;\r\n"']*)['"]?/i.exec(disposition);
    if (match && match[1]) {
      return safeDecodeURIComponent(match[1].trim());
    }
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
  const activeResponse = useApiStore((state) => state.activeResponse);
  const isLoading = useApiStore((state) => state.isLoading);
  const updateActiveRequest = useApiStore((state) => state.updateActiveRequest);
  const sendRequest = useApiStore((state) => state.sendRequest);
  const activeTabRequest = useApiStore((state) => state.tabs.find((t) => t.id === state.activeTabId));

  const targetUrl = activeResponse?.requestUrl || activeTabRequest?.url || '';
  const isHttps = targetUrl.toLowerCase().startsWith('https://');
  const { host: targetHost, port: targetPort } = parseUrlDetails(targetUrl);
  const netCategory = activeResponse?.netErrorCategory;
  const netCode = activeResponse?.netErrorCode;

  const [activeTab, setActiveTab] = useState<'body' | 'headers' | 'scripts'>('body');
  const [viewMode, setViewMode] = useState<'pretty' | 'raw'>('pretty');
  const [copied, setCopied] = useState(false);
  const [imgDimensions, setImgDimensions] = useState<{ width: number; height: number } | null>(null);
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

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
    if (!activeResponse) return;
    setDownloadError(null);

    // If binary response has lost its blob body (e.g. after restart / storage rehydration),
    // do not export placeholder string "[Binary File: ...]"
    if (activeResponse.isBinary && !activeResponse.blobUrl) {
      setDownloadError('Binary response body is no longer available in memory. Please re-run the request to download the original file.');
      return;
    }

    const adapter = getDefaultPlatformAdapter();

    try {
      const ext = getExtensionFromMime(activeResponse.contentType || '');
      const filename = getFileNameFromHeaders(activeResponse.headers, ext);
      if (activeResponse.blobUrl) {
        // Resolve blob bytes directly from tracked registry before fetch fallback
        let bytes: Uint8Array;
        const tracked = getTrackedBlob(activeResponse.blobUrl);
        if (tracked) {
          const buffer = await tracked.arrayBuffer();
          bytes = new Uint8Array(buffer);
        } else {
          const blobRes = await fetch(activeResponse.blobUrl);
          const arrayBuffer = await blobRes.arrayBuffer();
          bytes = new Uint8Array(arrayBuffer);
        }

        if (adapter?.saveFile) {
          await adapter.saveFile(filename, bytes, { mimeType: activeResponse.contentType });
          return;
        }

        const a = document.createElement('a');
        a.href = activeResponse.blobUrl;
        a.download = filename;
        a.click();
        return;
      }

      if (!activeResponse.data) return;

      if (adapter?.saveFile) {
        await adapter.saveFile(filename, activeResponse.data, { mimeType: activeResponse.contentType || 'text/plain' });
        return;
      }

      const blob = new Blob([activeResponse.data], {
        type: activeResponse.contentType || 'text/plain',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      console.error('Failed to download response:', err);
      setDownloadError(err instanceof Error ? err.message : 'Failed to save file.');
    }
  };

  const handleRequestHostPermission = async () => {
    const granted = await requestHostPermission(targetUrl);
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

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-app">
      {/* Response Header Bar */}
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
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

            <button
              onClick={handleDownload}
              className="flex items-center gap-1 rounded-lg border border-line bg-card px-2.5 py-1 text-xs text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
              title="Download response"
            >
              <Download className="h-3.5 w-3.5 text-tx-muted" />
              <span>Download</span>
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
        <div className="flex items-center justify-between border-b border-line px-4 py-2">
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
          </div>

          {activeTab === 'body' && isJson && (
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
        </div>
      )}

      {/* Main Response Content */}
      <div className="flex-1 overflow-auto p-4">
        {activeResponse && !isLoading && activeResponse.updatedEnvVars && activeResponse.updatedEnvVars.length > 0 && (
          <div className="mb-4 flex items-center gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-600 dark:text-emerald-300">
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
          <div className="flex h-full flex-col items-center justify-center space-y-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-sky-500 border-t-transparent" />
            <p className="text-xs text-tx-muted font-mono animate-pulse">
              Dispatching request via Hybrid Engine...
            </p>
          </div>
        ) : !activeResponse ? (
          /* Empty State with Quick-Start Templates */
          <div className="flex h-full flex-col items-center justify-center text-center max-w-md mx-auto py-12">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-tr from-sky-500/10 to-indigo-500/10 border border-sky-500/20 text-sky-500 dark:text-sky-400 shadow-xl">
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
                className="flex w-full items-center justify-between rounded-xl border border-line bg-card p-3 text-left hover:border-sky-500/40 hover:bg-hover transition group"
              >
                <div className="flex items-center gap-2.5">
                  <span className="font-mono text-[10px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded">
                    GET
                  </span>
                  <div>
                    <div className="text-xs font-medium text-tx-primary">
                      JSONPlaceholder Todo
                    </div>
                    <div className="text-[11px] font-mono text-tx-muted">
                      https://jsonplaceholder.typicode.com/todos/1
                    </div>
                  </div>
                </div>
                <ExternalLink className="h-3.5 w-3.5 text-tx-muted group-hover:text-sky-500 transition" />
              </button>

              <button
                onClick={() =>
                  loadSampleAndSend('https://httpbin.org/get?user=tester&tag=api', 'GET')
                }
                className="flex w-full items-center justify-between rounded-xl border border-line bg-card p-3 text-left hover:border-sky-500/40 hover:bg-hover transition group"
              >
                <div className="flex items-center gap-2.5">
                  <span className="font-mono text-[10px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded">
                    GET
                  </span>
                  <div>
                    <div className="text-xs font-medium text-tx-primary">
                      HTTPBin Echo Query
                    </div>
                    <div className="text-[11px] font-mono text-tx-muted">
                      https://httpbin.org/get?user=tester&tag=api
                    </div>
                  </div>
                </div>
                <ExternalLink className="h-3.5 w-3.5 text-tx-muted group-hover:text-sky-500 transition" />
              </button>

              <button
                onClick={() =>
                  loadSampleAndSend(
                    'https://jsonplaceholder.typicode.com/posts',
                    'POST',
                    JSON.stringify({ title: 'New Post', body: 'Tested with AirREST', userId: 1 }, null, 2)
                  )
                }
                className="flex w-full items-center justify-between rounded-xl border border-line bg-card p-3 text-left hover:border-sky-500/40 hover:bg-hover transition group"
              >
                <div className="flex items-center gap-2.5">
                  <span className="font-mono text-[10px] font-bold text-sky-600 dark:text-sky-400 bg-sky-500/10 border border-sky-500/20 px-1.5 py-0.5 rounded">
                    POST
                  </span>
                  <div>
                    <div className="text-xs font-medium text-tx-primary">
                      Create Post Payload
                    </div>
                    <div className="text-[11px] font-mono text-tx-muted">
                      https://jsonplaceholder.typicode.com/posts
                    </div>
                  </div>
                </div>
                <ExternalLink className="h-3.5 w-3.5 text-tx-muted group-hover:text-sky-500 transition" />
              </button>
            </div>
          </div>
        ) : activeTab === 'scripts' ? (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-700 dark:text-rose-200 shadow-sm">
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
          <div>
            {activeResponse.isError && activeResponse.status === 0 && (
              <div className="mb-4">
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
                      {targetUrl && (
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
                        {isHttps && targetUrl && (
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
              <pre className="rounded-xl border border-line bg-card p-4 font-mono text-xs text-tx-primary overflow-x-auto whitespace-pre-wrap leading-relaxed select-text">
                {viewMode === 'pretty' ? prettyJson : activeResponse.data}
              </pre>
            )}
          </div>
        ) : (
          /* Response Headers Table */
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
    </div>
  );
};
