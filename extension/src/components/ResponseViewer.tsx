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
} from 'lucide-react';
import { useApiStore } from '@/store/useApiStore';

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

function getFileNameFromHeaders(headers: Record<string, string> = {}, defaultExt: string): string {
  const disposition = headers['content-disposition'] || headers['Content-Disposition'];
  if (disposition) {
    const match = /filename\*?=['"]?(?:UTF-\d['"]*)?([^;\r\n"']*)['"]?/i.exec(disposition);
    if (match && match[1]) {
      return decodeURIComponent(match[1].trim());
    }
  }
  return `response-${Date.now()}${defaultExt}`;
}

export const ResponseViewer: React.FC = () => {
  const activeResponse = useApiStore((state) => state.activeResponse);
  const isLoading = useApiStore((state) => state.isLoading);
  const updateActiveRequest = useApiStore((state) => state.updateActiveRequest);
  const sendRequest = useApiStore((state) => state.sendRequest);

  const [activeTab, setActiveTab] = useState<'body' | 'headers'>('body');
  const [viewMode, setViewMode] = useState<'pretty' | 'raw'>('pretty');
  const [copied, setCopied] = useState(false);
  const [imgDimensions, setImgDimensions] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    setImgDimensions(null);
  }, [activeResponse]);

  const handleCopy = () => {
    if (!activeResponse?.data) return;
    navigator.clipboard.writeText(activeResponse.data);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!activeResponse) return;
    const ext = getExtensionFromMime(activeResponse.contentType || '');
    const filename = getFileNameFromHeaders(activeResponse.headers, ext);

    if (activeResponse.blobUrl) {
      const a = document.createElement('a');
      a.href = activeResponse.blobUrl;
      a.download = filename;
      a.click();
      return;
    }

    if (!activeResponse.data) return;
    const blob = new Blob([activeResponse.data], {
      type: activeResponse.contentType || 'text/plain',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const loadSampleAndSend = (url: string, method: 'GET' | 'POST' = 'GET', body = '') => {
    updateActiveRequest({
      url,
      method,
      bodyType: body ? 'json' : 'none',
      bodyContent: body,
      name: `Sample: ${method} ${new URL(url).pathname}`,
    });
    setTimeout(() => {
      sendRequest();
    }, 100);
  };

  // Status badge styling helper
  const getStatusBadge = (status: number, statusText: string) => {
    if (status >= 200 && status < 300) {
      return (
        <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 font-mono text-xs font-bold text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
          {status} {statusText}
        </span>
      );
    }
    if (status >= 300 && status < 400) {
      return (
        <span className="inline-flex items-center gap-1 rounded-md border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 font-mono text-xs font-bold text-sky-400">
          <span className="h-1.5 w-1.5 rounded-full bg-sky-400"></span>
          {status} {statusText}
        </span>
      );
    }
    if (status >= 400 && status < 500) {
      return (
        <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 font-mono text-xs font-bold text-amber-400">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400"></span>
          {status} {statusText}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 font-mono text-xs font-bold text-rose-400">
        <span className="h-1.5 w-1.5 rounded-full bg-rose-400"></span>
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
    <div className="flex flex-1 flex-col overflow-hidden bg-zinc-950">
      {/* Response Header Bar */}
      <div className="flex h-12 items-center justify-between border-b border-zinc-800 px-4">
        <div className="flex items-center gap-4">
          <span className="text-xs font-bold uppercase tracking-wider text-zinc-400">Response</span>

          {activeResponse && !isLoading && (
            <div className="flex items-center gap-3">
              {getStatusBadge(activeResponse.status, activeResponse.statusText)}

              <div className="flex items-center gap-1 font-mono text-xs text-zinc-400">
                <Clock className="h-3.5 w-3.5 text-zinc-500" />
                <span>{activeResponse.timeMs} ms</span>
              </div>

              <div className="flex items-center gap-1 font-mono text-xs text-zinc-400">
                <HardDrive className="h-3.5 w-3.5 text-zinc-500" />
                <span>{formatBytes(activeResponse.sizeBytes)}</span>
              </div>
            </div>
          )}
        </div>

        {activeResponse && !isLoading && (
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white transition"
              title="Copy to clipboard"
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                  <span className="text-emerald-400">Copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  <span>Copy</span>
                </>
              )}
            </button>

            <button
              onClick={handleDownload}
              className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white transition"
              title="Download response"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Download</span>
            </button>
          </div>
        )}
      </div>

      {/* Subtabs (Body vs Headers) when response exists */}
      {activeResponse && !isLoading && (
        <div className="flex items-center justify-between border-b border-zinc-850 px-4 py-2">
          <div className="flex gap-4 text-xs font-medium text-zinc-400">
            <button
              onClick={() => setActiveTab('body')}
              className={`flex items-center gap-1.5 pb-1 border-b-2 transition ${
                activeTab === 'body'
                  ? 'border-sky-500 text-zinc-100 font-semibold'
                  : 'border-transparent hover:text-zinc-200'
              }`}
            >
              <Code2 className="h-3.5 w-3.5" />
              <span>Body</span>
              {activeResponse.isImage && (
                <span className="rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/20 px-1.5 text-[10px]">
                  image
                </span>
              )}
              {activeResponse.isBinary && !activeResponse.isImage && (
                <span className="rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 text-[10px]">
                  binary
                </span>
              )}
            </button>

            <button
              onClick={() => setActiveTab('headers')}
              className={`flex items-center gap-1.5 pb-1 border-b-2 transition ${
                activeTab === 'headers'
                  ? 'border-sky-500 text-zinc-100 font-semibold'
                  : 'border-transparent hover:text-zinc-200'
              }`}
            >
              <FileText className="h-3.5 w-3.5" />
              <span>Headers</span>
              <span className="rounded-full bg-zinc-800 px-1.5 text-[10px] text-zinc-400">
                {Object.keys(activeResponse.headers).length}
              </span>
            </button>
          </div>

          {activeTab === 'body' && isJson && (
            <div className="flex rounded-lg border border-zinc-800 bg-zinc-900 p-0.5 text-xs">
              <button
                onClick={() => setViewMode('pretty')}
                className={`rounded px-2 py-0.5 transition ${
                  viewMode === 'pretty'
                    ? 'bg-zinc-800 text-sky-400 font-semibold'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Pretty
              </button>
              <button
                onClick={() => setViewMode('raw')}
                className={`rounded px-2 py-0.5 transition ${
                  viewMode === 'raw'
                    ? 'bg-zinc-800 text-sky-400 font-semibold'
                    : 'text-zinc-400 hover:text-zinc-200'
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
        {/* Post-response Script / Tests Feedback */}
        {activeResponse && !isLoading && activeResponse.scriptError && (
          <div className="mb-4 flex items-center gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
            <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
            <div>
              <span className="font-semibold">Tests Script Failed: </span>
              <span className="font-mono">{activeResponse.scriptError}</span>
            </div>
          </div>
        )}

        {activeResponse && !isLoading && activeResponse.updatedEnvVars && activeResponse.updatedEnvVars.length > 0 && (
          <div className="mb-4 flex items-center gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
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
            <p className="text-xs text-zinc-400 font-mono animate-pulse">
              Dispatching request via Hybrid Engine...
            </p>
          </div>
        ) : !activeResponse ? (
          /* Empty State with Quick-Start Templates */
          <div className="flex h-full flex-col items-center justify-center text-center max-w-md mx-auto py-12">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-tr from-sky-500/10 to-indigo-500/10 border border-sky-500/20 text-sky-400 shadow-xl">
              <Sparkles className="h-6 w-6" />
            </div>
            <h3 className="mt-4 text-sm font-semibold text-zinc-200">Ready to Test APIs</h3>
            <p className="mt-1.5 text-xs text-zinc-500 leading-relaxed">
              Enter an endpoint above and click <span className="text-sky-400 font-semibold">Send</span>, or try one of these instant test endpoints:
            </p>

            <div className="mt-6 w-full space-y-2">
              <button
                onClick={() =>
                  loadSampleAndSend('https://jsonplaceholder.typicode.com/todos/1', 'GET')
                }
                className="flex w-full items-center justify-between rounded-xl border border-zinc-850 bg-zinc-900/60 p-3 text-left hover:border-sky-500/40 hover:bg-zinc-900 transition group"
              >
                <div className="flex items-center gap-2.5">
                  <span className="font-mono text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded">
                    GET
                  </span>
                  <div>
                    <div className="text-xs font-medium text-zinc-200 group-hover:text-white">
                      JSONPlaceholder Todo
                    </div>
                    <div className="text-[11px] font-mono text-zinc-500">
                      https://jsonplaceholder.typicode.com/todos/1
                    </div>
                  </div>
                </div>
                <ExternalLink className="h-3.5 w-3.5 text-zinc-500 group-hover:text-sky-400 transition" />
              </button>

              <button
                onClick={() =>
                  loadSampleAndSend('https://httpbin.org/get?user=tester&tag=api', 'GET')
                }
                className="flex w-full items-center justify-between rounded-xl border border-zinc-850 bg-zinc-900/60 p-3 text-left hover:border-sky-500/40 hover:bg-zinc-900 transition group"
              >
                <div className="flex items-center gap-2.5">
                  <span className="font-mono text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded">
                    GET
                  </span>
                  <div>
                    <div className="text-xs font-medium text-zinc-200 group-hover:text-white">
                      HTTPBin Echo Query
                    </div>
                    <div className="text-[11px] font-mono text-zinc-500">
                      https://httpbin.org/get?user=tester&tag=api
                    </div>
                  </div>
                </div>
                <ExternalLink className="h-3.5 w-3.5 text-zinc-500 group-hover:text-sky-400 transition" />
              </button>

              <button
                onClick={() =>
                  loadSampleAndSend(
                    'https://jsonplaceholder.typicode.com/posts',
                    'POST',
                    JSON.stringify({ title: 'New Post', body: 'Tested with AirREST', userId: 1 }, null, 2)
                  )
                }
                className="flex w-full items-center justify-between rounded-xl border border-zinc-850 bg-zinc-900/60 p-3 text-left hover:border-sky-500/40 hover:bg-zinc-900 transition group"
              >
                <div className="flex items-center gap-2.5">
                  <span className="font-mono text-[10px] font-bold text-sky-400 bg-sky-500/10 border border-sky-500/20 px-1.5 py-0.5 rounded">
                    POST
                  </span>
                  <div>
                    <div className="text-xs font-medium text-zinc-200 group-hover:text-white">
                      Create Post Payload
                    </div>
                    <div className="text-[11px] font-mono text-zinc-500">
                      https://jsonplaceholder.typicode.com/posts
                    </div>
                  </div>
                </div>
                <ExternalLink className="h-3.5 w-3.5 text-zinc-500 group-hover:text-sky-400 transition" />
              </button>
            </div>
          </div>
        ) : activeTab === 'body' ? (
          <div>
            {activeResponse.isError && activeResponse.status === 0 && (
              <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-300">
                <div className="flex items-center gap-2 font-semibold">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" />
                  <span>Localhost / CORS Connection Failure</span>
                </div>
                <p className="mt-2 text-rose-200/90 leading-relaxed font-sans">
                  The request could not reach the server or was blocked by browser CORS policy.
                </p>
                <ul className="mt-2 list-disc list-inside space-y-1 text-rose-300/80 font-mono text-[11px]">
                  <li>Ensure your local server is actively running on this port.</li>
                  <li>Ensure your server sets header: <code className="text-white">Access-Control-Allow-Origin: *</code></li>
                </ul>
              </div>
            )}

            {activeResponse.isImage && activeResponse.blobUrl ? (
              /* Image Response Preview */
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="flex items-center gap-1.5 rounded-lg bg-sky-500/10 border border-sky-500/20 px-2 py-0.5 font-mono text-[11px] font-semibold text-sky-400">
                      <ImageIcon className="h-3.5 w-3.5" />
                      <span>{activeResponse.contentType || 'image'}</span>
                    </span>
                    <span className="text-[11px] text-zinc-400 font-mono">
                      {formatBytes(activeResponse.sizeBytes)}
                    </span>
                    {imgDimensions && (
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400 font-mono">
                        {imgDimensions.width} × {imgDimensions.height} px
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <a
                      href={activeResponse.blobUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-850 hover:text-white transition"
                      title="Open full-resolution image in new browser tab"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      <span>Open in New Tab</span>
                    </a>

                    <button
                      type="button"
                      onClick={handleDownload}
                      className="flex items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-xs font-semibold text-sky-300 hover:bg-sky-500/20 transition"
                      title="Download image file"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Download Image</span>
                    </button>
                  </div>
                </div>

                <div className="flex min-h-[300px] max-h-[620px] items-center justify-center overflow-auto rounded-xl border border-zinc-800 bg-zinc-950 p-6 [background-image:radial-gradient(#27272a_1px,transparent_1px)] [background-size:16px_16px]">
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
              <div className="flex min-h-[260px] flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 p-8 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400 shadow-lg">
                  <FileDown className="h-7 w-7" />
                </div>
                <h3 className="mt-4 text-sm font-semibold text-zinc-100">
                  binary file
                </h3>
                <p className="mt-1 text-xs text-zinc-400 max-w-sm">
                  The server returned binary content (
                  <code className="text-zinc-200 font-mono">{activeResponse.contentType || 'application/octet-stream'}</code>
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
              <pre className="rounded-xl border border-zinc-850 bg-zinc-900/60 p-4 font-mono text-xs text-zinc-200 overflow-x-auto whitespace-pre-wrap leading-relaxed select-text">
                {viewMode === 'pretty' ? prettyJson : activeResponse.data}
              </pre>
            )}
          </div>
        ) : (
          /* Response Headers Table */
          <div className="overflow-hidden rounded-xl border border-zinc-850 bg-zinc-900/40">
            <table className="w-full text-left text-xs font-mono">
              <thead className="border-b border-zinc-800 bg-zinc-900/80 text-zinc-400">
                <tr>
                  <th className="px-4 py-2 font-semibold">Header Key</th>
                  <th className="px-4 py-2 font-semibold">Header Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-850">
                {Object.entries(activeResponse.headers).map(([key, value]) => (
                  <tr key={key} className="hover:bg-zinc-850/50 transition">
                    <td className="px-4 py-2 text-sky-400 font-medium">{key}</td>
                    <td className="px-4 py-2 text-zinc-300 break-all">{value}</td>
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
