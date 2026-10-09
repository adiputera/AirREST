'use client';

import React, { useState, useEffect } from 'react';
import {
  Send,
  Loader2,
  Lock,
  Code2,
  Sliders,
  AlignLeft,
  Sparkles,
  KeyRound,
  FileText,
  Plus,
  Trash2,
  Paperclip,
  PlayCircle,
  FlaskConical,
  Bookmark,
  Terminal,
  Check,
  Copy,
} from 'lucide-react';
import { useApiStore } from '@/store/useApiStore';
import { HttpMethod, BodyType, FormDataItem } from '@/types/api';
import { KeyValueEditor } from './KeyValueEditor';
import { METHOD_COLORS } from './MethodBadge';
import { SaveToCollectionModal } from './SaveToCollectionModal';
import { generateCurlCommand } from '@/lib/curl';

export const RequestEditor: React.FC = () => {
  const tabs = useApiStore((state) => state.tabs);
  const activeTabId = useApiStore((state) => state.activeTabId);
  const updateActiveRequest = useApiStore((state) => state.updateActiveRequest);
  const updateParam = useApiStore((state) => state.updateParam);
  const addParam = useApiStore((state) => state.addParam);
  const removeParam = useApiStore((state) => state.removeParam);
  const updateHeader = useApiStore((state) => state.updateHeader);
  const addHeader = useApiStore((state) => state.addHeader);
  const removeHeader = useApiStore((state) => state.removeHeader);
  const updateAuth = useApiStore((state) => state.updateAuth);
  const setBodyType = useApiStore((state) => state.setBodyType);
  const setBodyContent = useApiStore((state) => state.setBodyContent);
  const setPreRequestScript = useApiStore((state) => state.setPreRequestScript);
  const setPostResponseScript = useApiStore((state) => state.setPostResponseScript);
  const updateFormDataItem = useApiStore((state) => state.updateFormDataItem);
  const addFormDataItem = useApiStore((state) => state.addFormDataItem);
  const removeFormDataItem = useApiStore((state) => state.removeFormDataItem);
  const sendRequest = useApiStore((state) => state.sendRequest);
  const isLoading = useApiStore((state) => state.isLoading);
  const environments = useApiStore((state) => state.environments);
  const activeEnvironmentId = useApiStore((state) => state.activeEnvironmentId);

  const [activeTab, setActiveTab] = useState<'params' | 'headers' | 'auth' | 'body' | 'prerequest' | 'tests'>('params');
  const [jsonFormatError, setJsonFormatError] = useState<string | null>(null);
  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);

  const currentTab = tabs.find((t) => t.id === activeTabId) || tabs[0];

  // Keyboard shortcut: Ctrl+Enter or Cmd+Enter to send request
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        sendRequest();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [sendRequest]);

  if (!currentTab) return null;

  // Active environment variable map for cURL generation
  const activeEnv = environments.find((e) => e.id === activeEnvironmentId);
  const envVarsMap: Record<string, string> = {};
  if (activeEnv) {
    activeEnv.variables.forEach((v) => {
      if (v.enabled && v.key.trim()) {
        envVarsMap[v.key.trim()] = v.value;
      }
    });
  }

  const handleCopyCurl = () => {
    try {
      const curlCmd = generateCurlCommand(currentTab, envVarsMap);
      navigator.clipboard.writeText(curlCmd);
      setCopiedCurl(true);
      setTimeout(() => setCopiedCurl(false), 2000);
    } catch (e) {
      console.error('Failed to generate cURL command', e);
    }
  };

  const handleBeautifyJson = () => {
    try {
      if (!currentTab.bodyContent.trim()) return;
      const parsed = JSON.parse(currentTab.bodyContent);
      setBodyContent(JSON.stringify(parsed, null, 2));
      setJsonFormatError(null);
    } catch (err: unknown) {
      setJsonFormatError(err instanceof Error ? err.message : 'Invalid JSON format');
    }
  };

  const handleInsertPreScriptSnippet = (snippet: string) => {
    const currentScript = currentTab.preRequestScript || '';
    const updated = currentScript ? `${currentScript.trimEnd()}\n\n${snippet}` : snippet;
    setPreRequestScript(updated);
  };

  const handleInsertPostScriptSnippet = (snippet: string) => {
    const currentScript = currentTab.postResponseScript || '';
    const updated = currentScript ? `${currentScript.trimEnd()}\n\n${snippet}` : snippet;
    setPostResponseScript(updated);
  };

  const methods: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const activeMethodColor = METHOD_COLORS[currentTab.method]?.text || 'text-zinc-200';

  return (
    <>
      <div className="flex flex-col border-b border-zinc-800 bg-zinc-950 p-4">
        {/* Request Name and Actions Bar */}
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2 flex-1 mr-4">
            <input
              type="text"
              value={currentTab.name}
              onChange={(e) => updateActiveRequest({ name: e.target.value })}
              placeholder="Untitled Request Name"
              className="bg-transparent font-medium text-xs text-zinc-300 hover:text-white focus:text-white focus:outline-none focus:border-b focus:border-sky-500 transition px-1 py-0.5 rounded w-full max-w-sm"
            />
            <button
              onClick={() => setIsSaveModalOpen(true)}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-850 hover:text-white transition"
              title="Save request to a collection"
            >
              <Bookmark className="h-3.5 w-3.5 text-amber-400" />
              <span>Save</span>
            </button>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleCopyCurl}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-850 hover:text-white transition"
              title="Copy active request as cURL command"
            >
              {copiedCurl ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                  <span className="text-emerald-400">cURL Copied!</span>
                </>
              ) : (
                <>
                  <Terminal className="h-3.5 w-3.5 text-sky-400" />
                  <span>Copy cURL</span>
                </>
              )}
            </button>

            <div className="text-[11px] text-zinc-500 font-mono hidden md:block">
              Press <kbd className="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-zinc-300">⌘+Enter</kbd> to send
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Method Selector */}
          <div className="relative shrink-0">
            <select
              value={currentTab.method}
              onChange={(e) => updateActiveRequest({ method: e.target.value as HttpMethod })}
              className={`h-11 rounded-xl border border-zinc-800 bg-zinc-900 px-3 pr-8 font-mono text-xs font-bold ${activeMethodColor} focus:border-sky-500 focus:outline-none cursor-pointer`}
            >
              {methods.map((m) => (
                <option key={m} value={m} className="bg-zinc-900 text-zinc-200 font-bold">
                  {m}
                </option>
              ))}
            </select>
          </div>

          {/* URL Input */}
          <div className="relative flex-1">
            <input
              type="text"
              value={currentTab.url}
              onChange={(e) => updateActiveRequest({ url: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendRequest();
                }
              }}
              placeholder="Enter URL (e.g. {{baseUrl}}/api/v1/resource or http://localhost:8080)"
              className="h-11 w-full rounded-xl border border-zinc-800 bg-zinc-900/90 px-4 font-mono text-xs text-zinc-100 placeholder-zinc-500 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 transition"
            />
          </div>

          {/* Send Button */}
          <button
            onClick={() => sendRequest()}
            disabled={isLoading || !currentTab.url.trim()}
            className="flex h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 px-6 font-semibold text-xs text-white shadow-lg shadow-sky-500/20 hover:from-sky-400 hover:to-blue-500 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed transition shrink-0"
          >
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Sending...</span>
              </>
            ) : (
              <>
                <Send className="h-4 w-4" />
                <span>Send</span>
              </>
            )}
          </button>
        </div>

        {/* Configuration Subtabs */}
        <div className="mt-4 flex items-center border-b border-zinc-850 gap-4 text-xs font-medium text-zinc-400">
          <button
            onClick={() => setActiveTab('params')}
            className={`flex items-center gap-1.5 pb-2.5 transition border-b-2 ${
              activeTab === 'params'
                ? 'border-sky-500 text-zinc-100 font-semibold'
                : 'border-transparent hover:text-zinc-200'
            }`}
          >
            <Sliders className="h-3.5 w-3.5" />
            <span>Params</span>
            {currentTab.params.filter((p) => p.enabled && p.key.trim()).length > 0 && (
              <span className="rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/20 px-1.5 text-[10px]">
                {currentTab.params.filter((p) => p.enabled && p.key.trim()).length}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('headers')}
            className={`flex items-center gap-1.5 pb-2.5 transition border-b-2 ${
              activeTab === 'headers'
                ? 'border-sky-500 text-zinc-100 font-semibold'
                : 'border-transparent hover:text-zinc-200'
            }`}
          >
            <Code2 className="h-3.5 w-3.5" />
            <span>Headers</span>
            {currentTab.headers.filter((h) => h.enabled && h.key.trim()).length > 0 && (
              <span className="rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/20 px-1.5 text-[10px]">
                {currentTab.headers.filter((h) => h.enabled && h.key.trim()).length}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('auth')}
            className={`flex items-center gap-1.5 pb-2.5 transition border-b-2 ${
              activeTab === 'auth'
                ? 'border-sky-500 text-zinc-100 font-semibold'
                : 'border-transparent hover:text-zinc-200'
            }`}
          >
            <Lock className="h-3.5 w-3.5" />
            <span>Auth</span>
            {currentTab.auth.type !== 'none' && (
              <span className="rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 text-[10px]">
                {currentTab.auth.type}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('body')}
            className={`flex items-center gap-1.5 pb-2.5 transition border-b-2 ${
              activeTab === 'body'
                ? 'border-sky-500 text-zinc-100 font-semibold'
                : 'border-transparent hover:text-zinc-200'
            }`}
          >
            <AlignLeft className="h-3.5 w-3.5" />
            <span>Body</span>
            {currentTab.bodyType !== 'none' && (
              <span className="rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 text-[10px]">
                {currentTab.bodyType}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('prerequest')}
            className={`flex items-center gap-1.5 pb-2.5 transition border-b-2 ${
              activeTab === 'prerequest'
                ? 'border-sky-500 text-zinc-100 font-semibold'
                : 'border-transparent hover:text-zinc-200'
            }`}
          >
            <PlayCircle className="h-3.5 w-3.5 text-violet-400" />
            <span>Pre-request</span>
            {currentTab.preRequestScript && currentTab.preRequestScript.trim() && (
              <span className="h-1.5 w-1.5 rounded-full bg-violet-400"></span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('tests')}
            className={`flex items-center gap-1.5 pb-2.5 transition border-b-2 ${
              activeTab === 'tests'
                ? 'border-sky-500 text-zinc-100 font-semibold'
                : 'border-transparent hover:text-zinc-200'
            }`}
          >
            <FlaskConical className="h-3.5 w-3.5 text-emerald-400" />
            <span>Tests / Post-response</span>
            {currentTab.postResponseScript && currentTab.postResponseScript.trim() && (
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
            )}
          </button>
        </div>

        {/* Subtab Panels */}
        <div className="mt-3">
          {activeTab === 'params' && (
            <KeyValueEditor
              items={currentTab.params}
              onUpdate={updateParam}
              onAdd={addParam}
              onRemove={removeParam}
              keyPlaceholder="Parameter name"
              valuePlaceholder="Value or {{variable}}"
            />
          )}

          {activeTab === 'headers' && (
            <KeyValueEditor
              items={currentTab.headers}
              onUpdate={updateHeader}
              onAdd={addHeader}
              onRemove={removeHeader}
              keyPlaceholder="Header name (e.g. Authorization)"
              valuePlaceholder="Header value or {{token}}"
            />
          )}

          {activeTab === 'auth' && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-4">
              <div className="flex items-center gap-3">
                <label className="text-xs font-semibold text-zinc-300">Type:</label>
                <div className="flex flex-wrap gap-2">
                  {(['none', 'bearer', 'basic', 'apikey'] as const).map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => updateAuth({ type })}
                      className={`rounded-lg px-3 py-1 text-xs font-medium capitalize transition ${
                        currentTab.auth.type === type
                          ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                          : 'border border-zinc-800 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                      }`}
                    >
                      {type === 'apikey' ? 'API Key' : type}
                    </button>
                  ))}
                </div>
              </div>

              {currentTab.auth.type === 'none' && (
                <div className="pt-2 text-xs text-zinc-500">
                  This request does not use authorization. Select Bearer, Basic, or API Key above to configure auth credentials.
                </div>
              )}

              {currentTab.auth.type === 'bearer' && (
                <div className="space-y-1.5 pt-2 border-t border-zinc-800">
                  <label className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
                    <KeyRound className="h-3.5 w-3.5 text-sky-400" />
                    <span>Bearer Token</span>
                  </label>
                  <input
                    type="text"
                    value={currentTab.auth.bearerToken || ''}
                    onChange={(e) => updateAuth({ bearerToken: e.target.value })}
                    placeholder="Bearer token or {{token}}..."
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-900 p-2.5 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-sky-500 focus:outline-none"
                  />
                </div>
              )}

              {currentTab.auth.type === 'basic' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-zinc-800">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-300">Username</label>
                    <input
                      type="text"
                      value={currentTab.auth.basicUsername || ''}
                      onChange={(e) => updateAuth({ basicUsername: e.target.value })}
                      placeholder="Username or {{username}}"
                      className="w-full rounded-xl border border-zinc-800 bg-zinc-900 p-2.5 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-sky-500 focus:outline-none"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-300">Password</label>
                    <input
                      type="password"
                      value={currentTab.auth.basicPassword || ''}
                      onChange={(e) => updateAuth({ basicPassword: e.target.value })}
                      placeholder="Password or {{password}}"
                      className="w-full rounded-xl border border-zinc-800 bg-zinc-900 p-2.5 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-sky-500 focus:outline-none"
                    />
                  </div>
                </div>
              )}

              {currentTab.auth.type === 'apikey' && (
                <div className="space-y-3 pt-2 border-t border-zinc-800">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-zinc-300">Key Name</label>
                      <input
                        type="text"
                        value={currentTab.auth.apiKeyKey || ''}
                        onChange={(e) => updateAuth({ apiKeyKey: e.target.value })}
                        placeholder="e.g. X-API-Key or api_key"
                        className="w-full rounded-xl border border-zinc-800 bg-zinc-900 p-2.5 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-sky-500 focus:outline-none"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-zinc-300">Key Value</label>
                      <input
                        type="text"
                        value={currentTab.auth.apiKeyValue || ''}
                        onChange={(e) => updateAuth({ apiKeyValue: e.target.value })}
                        placeholder="e.g. secret_value or {{apiKey}}"
                        className="w-full rounded-xl border border-zinc-800 bg-zinc-900 p-2.5 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-sky-500 focus:outline-none"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <label className="text-xs font-medium text-zinc-300">Add to:</label>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => updateAuth({ apiKeyIn: 'header' })}
                        className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                          currentTab.auth.apiKeyIn !== 'query'
                            ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                            : 'border border-zinc-800 text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        Header
                      </button>
                      <button
                        type="button"
                        onClick={() => updateAuth({ apiKeyIn: 'query' })}
                        className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                          currentTab.auth.apiKeyIn === 'query'
                            ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                            : 'border border-zinc-800 text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        Query Params
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'body' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                {/* Body Type Selectors */}
                <div className="flex flex-wrap gap-1.5">
                  {(['none', 'json', 'form-data', 'x-www-form-urlencoded', 'raw'] as BodyType[]).map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setBodyType(type)}
                      className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                        currentTab.bodyType === type
                          ? 'bg-zinc-800 text-sky-400 border border-zinc-700'
                          : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900'
                      }`}
                    >
                      {type}
                    </button>
                  ))}
                </div>

                {currentTab.bodyType === 'json' && (
                  <button
                    type="button"
                    onClick={handleBeautifyJson}
                    className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white transition"
                    title="Format JSON payload"
                  >
                    <Sparkles className="h-3.5 w-3.5 text-amber-400" />
                    <span>Beautify JSON</span>
                  </button>
                )}
              </div>

              {currentTab.bodyType === 'form-data' ? (
                /* Multipart Form-Data with File Attachment Table */
                <div className="space-y-2">
                  <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-zinc-800 bg-zinc-900/60 text-zinc-400">
                        <tr>
                          <th className="w-10 px-3 py-2 text-center">Use</th>
                          <th className="w-1/3 px-3 py-2 font-medium">Field Key</th>
                          <th className="w-24 px-3 py-2 font-medium">Type</th>
                          <th className="px-3 py-2 font-medium">Value / Attachment</th>
                          <th className="w-10 px-3 py-2 text-center"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-850">
                        {(currentTab.bodyFormData || []).map((item) => (
                          <tr key={item.id} className="group hover:bg-zinc-900/40 transition">
                            <td className="px-3 py-1.5 text-center">
                              <input
                                type="checkbox"
                                checked={item.enabled}
                                onChange={(e) => updateFormDataItem(item.id, { enabled: e.target.checked })}
                                className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-900 text-sky-500 accent-sky-500 cursor-pointer"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                type="text"
                                value={item.key}
                                onChange={(e) => updateFormDataItem(item.id, { key: e.target.value })}
                                placeholder="Key"
                                className="w-full rounded bg-transparent px-2 py-1 font-mono text-xs text-zinc-200 placeholder-zinc-600 focus:bg-zinc-900 focus:outline-none"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <select
                                value={item.type}
                                onChange={(e) =>
                                  updateFormDataItem(item.id, {
                                    type: e.target.value as 'text' | 'file',
                                    file: undefined,
                                    value: '',
                                  })
                                }
                                className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-300 focus:outline-none cursor-pointer"
                              >
                                <option value="text">Text</option>
                                <option value="file">File</option>
                              </select>
                            </td>
                            <td className="px-2 py-1.5">
                              {item.type === 'file' ? (
                                <div className="flex items-center gap-2">
                                  <label className="flex items-center gap-1.5 rounded-lg border border-dashed border-zinc-700 bg-zinc-900/80 px-2.5 py-1 text-xs text-zinc-300 hover:border-sky-500 hover:text-white cursor-pointer transition">
                                    <Paperclip className="h-3.5 w-3.5 text-sky-400" />
                                    <span>{item.file ? item.file.name : 'Select File...'}</span>
                                    <input
                                      type="file"
                                      className="hidden"
                                      onChange={(e) => {
                                        const file = e.target.files?.[0];
                                        if (file) {
                                          updateFormDataItem(item.id, { file, value: file.name });
                                        }
                                      }}
                                    />
                                  </label>
                                  {item.file && (
                                    <span className="text-[10px] text-zinc-500 font-mono">
                                      ({Math.round(item.file.size / 1024)} KB)
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <input
                                  type="text"
                                  value={item.value}
                                  onChange={(e) => updateFormDataItem(item.id, { value: e.target.value })}
                                  placeholder="Text value or {{variable}}"
                                  className="w-full rounded bg-transparent px-2 py-1 font-mono text-xs text-zinc-200 placeholder-zinc-600 focus:bg-zinc-900 focus:outline-none"
                                />
                              )}
                            </td>
                            <td className="px-2 py-1.5 text-center">
                              <button
                                onClick={() => removeFormDataItem(item.id)}
                                className="rounded p-1 text-zinc-600 opacity-60 hover:bg-zinc-800 hover:text-rose-400 group-hover:opacity-100 transition"
                                title="Delete row"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <button
                    type="button"
                    onClick={addFormDataItem}
                    className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition"
                  >
                    <Plus className="h-3.5 w-3.5 text-sky-400" />
                    <span>Add Form Field</span>
                  </button>
                </div>
              ) : currentTab.bodyType !== 'none' ? (
                <div className="space-y-1">
                  <textarea
                    value={currentTab.bodyContent}
                    onChange={(e) => setBodyContent(e.target.value)}
                    placeholder={
                      currentTab.bodyType === 'json'
                        ? '{\n  "title": "foo",\n  "userId": "{{userId}}"\n}'
                        : 'Raw body payload with {{variable}}...'
                    }
                    rows={6}
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-900/90 p-3 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 transition resize-y"
                  />
                  {jsonFormatError && (
                    <p className="text-[11px] text-rose-400 font-mono">{jsonFormatError}</p>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-center rounded-xl border border-dashed border-zinc-800/80 p-8 text-center text-xs text-zinc-500">
                  This request does not have a body. Select JSON, form-data, or Raw to attach payload.
                </div>
              )}
            </div>
          )}

          {activeTab === 'prerequest' && (
            /* Pre-request Script Tab */
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-300">
                  Pre-request Script (Runs before request is sent)
                </span>

                {/* Code Snippet Helpers */}
                <div className="flex flex-wrap gap-2 text-[11px]">
                  <button
                    type="button"
                    onClick={() =>
                      handleInsertPreScriptSnippet('pm.environment.set("timestamp", Date.now());')
                    }
                    className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-zinc-400 hover:text-white hover:bg-zinc-850 transition"
                  >
                    + Set Timestamp
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      handleInsertPreScriptSnippet('pm.environment.set("token", "your_token_value");')
                    }
                    className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-zinc-400 hover:text-white hover:bg-zinc-850 transition"
                  >
                    + Set Env Var
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      handleInsertPreScriptSnippet('const token = pm.environment.get("token");\nconsole.log("Current token:", token);')
                    }
                    className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-zinc-400 hover:text-white hover:bg-zinc-850 transition"
                  >
                    + Get Env Var
                  </button>
                </div>
              </div>

              <textarea
                value={currentTab.preRequestScript || ''}
                onChange={(e) => setPreRequestScript(e.target.value)}
                placeholder="// JavaScript code executed before sending request:\n// pm.environment.set('token', 'sample_bearer_token');\n// pm.variables.set('reqId', 'req_' + Date.now());"
                rows={8}
                className="w-full rounded-xl border border-zinc-800 bg-zinc-900/90 p-3 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 transition resize-y"
              />

              <p className="text-[11px] text-zinc-500 leading-relaxed">
                Use <code className="text-violet-400">pm.environment.set(key, value)</code> to dynamically update variables before sending. Code runs in an isolated sandbox.
              </p>
            </div>
          )}

          {activeTab === 'tests' && (
            /* Tests / Post-response Script Tab */
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-300">
                  Tests & Post-response Script (Runs after response is received)
                </span>

                {/* Code Snippet Helpers */}
                <div className="flex flex-wrap gap-2 text-[11px]">
                  <button
                    type="button"
                    onClick={() =>
                      handleInsertPostScriptSnippet(
                        `// Extract auth token from response and save to active environment\nconst res = pm.response.json();\nconst token = res.token || res.access_token || res.data?.token || res.id_token;\nif (token) {\n  pm.environment.set("token", token);\n  console.log("Token saved as {{token}}");\n}`
                      )
                    }
                    className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-emerald-300 hover:bg-emerald-500/20 transition font-medium"
                  >
                    + Save Auth Token to Env
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      handleInsertPostScriptSnippet(
                        `const res = pm.response.json();\nif (res.id) {\n  pm.environment.set("savedId", res.id);\n}`
                      )
                    }
                    className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-zinc-400 hover:text-white hover:bg-zinc-850 transition"
                  >
                    + Set Env from JSON
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      handleInsertPostScriptSnippet(
                        `if (pm.response.code !== 200) {\n  throw new Error("Expected status 200, got " + pm.response.code);\n}`
                      )
                    }
                    className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-zinc-400 hover:text-white hover:bg-zinc-850 transition"
                  >
                    + Status 200 Check
                  </button>
                </div>
              </div>

              <textarea
                value={currentTab.postResponseScript || ''}
                onChange={(e) => setPostResponseScript(e.target.value)}
                placeholder="// JavaScript executed after response is received:\n// const data = pm.response.json();\n// pm.environment.set('token', data.token);\n// if (pm.response.code !== 200) throw new Error('Status failed');"
                rows={8}
                className="w-full rounded-xl border border-zinc-800 bg-zinc-900/90 p-3 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 transition resize-y"
              />

              <p className="text-[11px] text-zinc-500 leading-relaxed">
                Use <code className="text-emerald-400">pm.response.json()</code> to inspect payload and <code className="text-emerald-400">pm.environment.set("token", token)</code> to automatically persist tokens or IDs. Subsequent requests will immediately use <code className="text-sky-400">&#123;&#123;token&#125;&#125;</code> in Headers or Auth!
              </p>
            </div>
          )}
        </div>
      </div>

      <SaveToCollectionModal
        isOpen={isSaveModalOpen}
        onClose={() => setIsSaveModalOpen(false)}
        request={currentTab}
      />
    </>
  );
};
