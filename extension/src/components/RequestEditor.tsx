import React, { useState, useEffect, useCallback } from 'react';
import {
  Send,
  Lock,
  Code2,
  Sliders,
  AlignLeft,
  Sparkles,
  KeyRound,
  Plus,
  Trash2,
  Paperclip,
  PlayCircle,
  FlaskConical,
  Bookmark,
  Terminal,
  Check,
  UploadCloud,
  FileUp,
  RefreshCw,
  XCircle,
  Folder,
} from 'lucide-react';
import { useApiStore } from '@/store/useApiStore';
import { HttpMethod, BodyType, RawType, KeyValuePair } from '@/types/api';
import { KeyValueEditor } from './KeyValueEditor';
import { METHOD_COLORS } from './MethodBadge';
import { SaveToCollectionModal } from './SaveToCollectionModal';
import { generateCurlCommand } from '@/lib/curl';
import { VariableInput } from './VariableInput';
import { interpolateVariables } from '@/lib/fetcher';
import { beautifyXml, beautifyGraphQL, beautifyJson } from '@/lib/formatters';
import {
  isRequestModified,
  findSavedRequestInCollections,
  flattenCollectionRequests,
} from '@/lib/requestDiff';
import { handleCodeEditorKeyDown } from '@/lib/editorHelper';
import { canModifyCollection, hasScopePermission } from '@/lib/jwt';

function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

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
  const setRawType = useApiStore((state) => state.setRawType);
  const setBodyContent = useApiStore((state) => state.setBodyContent);
  const setGraphqlQuery = useApiStore((state) => state.setGraphqlQuery);
  const setGraphqlVariables = useApiStore((state) => state.setGraphqlVariables);
  const setPreRequestScript = useApiStore((state) => state.setPreRequestScript);
  const setPostResponseScript = useApiStore((state) => state.setPostResponseScript);
  const updateFormDataItem = useApiStore((state) => state.updateFormDataItem);
  const addFormDataItem = useApiStore((state) => state.addFormDataItem);
  const removeFormDataItem = useApiStore((state) => state.removeFormDataItem);
  const setBodyBinaryFile = useApiStore((state) => state.setBodyBinaryFile);
  const updateUrlEncodedItem = useApiStore((state) => state.updateUrlEncodedItem);
  const addUrlEncodedItem = useApiStore((state) => state.addUrlEncodedItem);
  const removeUrlEncodedItem = useApiStore((state) => state.removeUrlEncodedItem);
  const setUrlEncodedItems = useApiStore((state) => state.setUrlEncodedItems);
  const sendRequest = useApiStore((state) => state.sendRequest);
  const cancelActiveRequest = useApiStore((state) => state.cancelActiveRequest);
  const isLoading = useApiStore((state) => state.isLoading);
  const environments = useApiStore((state) => state.environments);
  const activeEnvironmentId = useApiStore((state) => state.activeEnvironmentId);
  const collections = useApiStore((state) => state.collections);
  const saveActiveRequest = useApiStore((state) => state.saveActiveRequest);

  const [activeTab, setActiveTab] = useState<'params' | 'headers' | 'auth' | 'body' | 'prerequest' | 'tests'>('params');
  const [jsonFormatError, setJsonFormatError] = useState<string | null>(null);
  const [xmlFormatError, setXmlFormatError] = useState<string | null>(null);
  const [graphqlQueryError, setGraphqlQueryError] = useState<string | null>(null);
  const [graphqlVariablesError, setGraphqlVariablesError] = useState<string | null>(null);
  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [isSaveAsMode, setIsSaveAsMode] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);
  const [isUrlEncodedBulkEdit, setIsUrlEncodedBulkEdit] = useState(false);
  const [urlEncodedBulkText, setUrlEncodedBulkText] = useState('');
  const [justSaved, setJustSaved] = useState(false);

  const currentTab = tabs.find((t) => t.id === activeTabId) || tabs[0];
  const isDirty = currentTab ? isRequestModified(currentTab, collections) : false;

  const workspaceMode = useApiStore((state) => state.workspaceMode);
  const cloudConfig = useApiStore((state) => state.cloudConfig);
  const savedRequestInfo = currentTab ? findSavedRequestInCollections(collections, currentTab.id) : null;
  const canWriteScope = hasScopePermission(cloudConfig.activeScope, 'collection:write', workspaceMode, cloudConfig.user?.role);
  const isScopeReadOnly = !canWriteScope;
  const isCollectionReadOnly = savedRequestInfo ? !canModifyCollection(savedRequestInfo.collection.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role) : false;
  const isReadOnly = isScopeReadOnly || isCollectionReadOnly;

  const handleSave = useCallback(() => {
    if (!canWriteScope) {
      return;
    }
    if (isReadOnly) {
      setIsSaveAsMode(true);
      setIsSaveModalOpen(true);
      return;
    }
    if (savedRequestInfo && currentTab) {
      const currentMethod = (currentTab.method || 'GET').toUpperCase();
      const currentName = (currentTab.name || 'Untitled Request').trim().toLowerCase();
      const existingReqs = flattenCollectionRequests(savedRequestInfo.collection.items || []);
      const hasCollisionWithAnother = existingReqs.some(
        (r) =>
          r.id !== currentTab.id &&
          r.request?.id !== currentTab.id &&
          (r.method || 'GET').toUpperCase() === currentMethod &&
          r.name.trim().toLowerCase() === currentName
      );
      if (hasCollisionWithAnother) {
        setIsSaveAsMode(false);
        setIsSaveModalOpen(true);
        return;
      }
    }
    const res = saveActiveRequest();
    if (res.isDirectSaved) {
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 1200);
    } else {
      setIsSaveAsMode(false);
      setIsSaveModalOpen(true);
    }
  }, [canWriteScope, isReadOnly, savedRequestInfo, currentTab, saveActiveRequest]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSave]);

  useEffect(() => {
    setIsUrlEncodedBulkEdit(false);
  }, [activeTabId, currentTab?.bodyType]);

  const handleToggleBulkEdit = () => {
    if (!isUrlEncodedBulkEdit) {
      const list = currentTab?.bodyUrlEncoded || [];
      const text = list
        .filter((item) => item.key || item.value)
        .map((item) => `${item.key}: ${item.value}`)
        .join('\n');
      setUrlEncodedBulkText(text);
      setIsUrlEncodedBulkEdit(true);
    } else {
      const lines = urlEncodedBulkText.split('\n');
      const items: KeyValuePair[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        let key = '';
        let value = '';
        const colonIdx = line.indexOf(':');
        const eqIdx = line.indexOf('=');
        if (colonIdx >= 0 && (eqIdx < 0 || colonIdx < eqIdx)) {
          key = line.substring(0, colonIdx).trim();
          value = line.substring(colonIdx + 1).trim();
        } else if (eqIdx >= 0) {
          key = line.substring(0, eqIdx).trim();
          value = line.substring(eqIdx + 1).trim();
        } else {
          key = line.trim();
        }
        items.push({ id: `u_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`, key, value, enabled: true });
      }
      if (items.length === 0) {
        items.push({ id: `u_${Date.now()}`, key: '', value: '', enabled: true });
      }
      setUrlEncodedItems(items);
      setIsUrlEncodedBulkEdit(false);
    }
  };

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
        const effVal = v.currentValue !== undefined && v.currentValue !== ''
          ? v.currentValue
          : (v.initialValue ?? v.value ?? '');
        envVarsMap[v.key.trim()] = effVal;
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
      if (!currentTab?.bodyContent?.trim()) return;
      const parsed = JSON.parse(currentTab.bodyContent);
      setBodyContent(JSON.stringify(parsed, null, 2));
      setJsonFormatError(null);
    } catch (err: unknown) {
      setJsonFormatError(err instanceof Error ? err.message : 'Invalid JSON format');
    }
  };

  const handleBeautifyXml = () => {
    if (!currentTab?.bodyContent?.trim()) return;
    const res = beautifyXml(currentTab.bodyContent);
    if (res.error) {
      setXmlFormatError(res.error);
    } else {
      setBodyContent(res.formatted);
      setXmlFormatError(null);
    }
  };

  const handleBeautifyGraphQLQuery = () => {
    const query = currentTab.graphqlQuery ?? currentTab.bodyContent ?? '';
    if (!query.trim()) return;
    const res = beautifyGraphQL(query);
    if (res.error) {
      setGraphqlQueryError(res.error);
    } else {
      setGraphqlQuery(res.formatted);
      setBodyContent(res.formatted);
      setGraphqlQueryError(null);
    }
  };

  const handleBeautifyGraphQLVariables = () => {
    const vars = currentTab.graphqlVariables || '';
    if (!vars.trim()) return;
    const res = beautifyJson(vars);
    if (res.error) {
      setGraphqlVariablesError(res.error);
    } else {
      setGraphqlVariables(res.formatted);
      setGraphqlVariablesError(null);
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

  if (!currentTab) {
    return null;
  }

  const methods: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const activeMethodColor = METHOD_COLORS[currentTab.method]?.text || 'text-zinc-200';

  return (
    <>
      <div className="flex flex-col border-b border-zinc-800 bg-zinc-950 p-4">
        {/* Request Name and Actions Bar */}
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2 flex-1 mr-4">
            <div className="relative flex items-center flex-1 max-w-sm">
              <input
                type="text"
                value={currentTab.name}
                onChange={(e) => updateActiveRequest({ name: e.target.value })}
                placeholder="Untitled Request Name"
                className="bg-transparent font-medium text-xs text-zinc-300 hover:text-white focus:text-white focus:outline-none focus:border-b focus:border-sky-500 transition px-1 py-0.5 rounded w-full pr-5"
              />
              {isDirty && (
                <span
                  className="absolute right-1 h-2 w-2 rounded-full bg-amber-400 shrink-0 shadow-sm shadow-amber-400/50"
                  title="Unsaved changes"
                />
              )}
            </div>

            {savedRequestInfo && (
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-zinc-900 border border-zinc-800 text-zinc-400 shrink-0 truncate max-w-[160px]"
                title={`Saved in collection: ${savedRequestInfo.collection.name}`}
              >
                <Folder className="h-3 w-3 text-amber-400 shrink-0" />
                <span className="truncate">{savedRequestInfo.collection.name}</span>
              </span>
            )}

            <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden shadow-sm">
              {isReadOnly ? (
                <div
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-zinc-500 bg-zinc-800/40 cursor-not-allowed select-none"
                  title={
                    isScopeReadOnly
                      ? "This project is read-only for your role (reader). Modifications cannot be saved."
                      : "This request belongs to a read-only collection. Use 'Save As' to save a copy."
                  }
                >
                  <Lock className="h-3.5 w-3.5 text-zinc-500" />
                  <span>Read-only</span>
                </div>
              ) : (
                <button
                  onClick={handleSave}
                  className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium transition ${
                    isDirty
                      ? 'text-amber-300 hover:bg-amber-500/10'
                      : 'text-zinc-300 hover:bg-zinc-800 hover:text-white'
                  }`}
                  title="Save request (Ctrl+S / ⌘+S)"
                >
                  {justSaved ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                      <span className="text-emerald-400 font-semibold">Saved!</span>
                    </>
                  ) : (
                    <>
                      <Bookmark className={`h-3.5 w-3.5 ${isDirty ? 'text-amber-400' : 'text-zinc-400'}`} />
                      <span>Save</span>
                      {isDirty && (
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                      )}
                    </>
                  )}
                </button>
              )}
              {canWriteScope && (
                <button
                  onClick={() => {
                    setIsSaveAsMode(true);
                    setIsSaveModalOpen(true);
                  }}
                  className="border-l border-zinc-800 px-1.5 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition text-[10px] font-medium"
                  title="Save As (save a copy to another collection)"
                >
                  Save As
                </button>
              )}
            </div>
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
            <VariableInput
              value={currentTab.url}
              onChange={(url) => updateActiveRequest({ url })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendRequest();
                }
              }}
              placeholder="Enter URL (e.g. {{baseUrl}}/api/v1/resource or http://localhost:8080)"
              size="lg"
            />
          </div>

          {/* Send Button */}
          <button
            onClick={() => isLoading ? cancelActiveRequest() : sendRequest()}
            disabled={!isLoading && !currentTab.url.trim()}
            className="flex h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 px-6 font-semibold text-xs text-white shadow-lg shadow-sky-500/20 hover:from-sky-400 hover:to-blue-500 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed transition shrink-0"
          >
            {isLoading ? (
              <>
                <XCircle className="h-4 w-4" />
                <span>Cancel</span>
              </>
            ) : (
              <>
                <Send className="h-4 w-4" />
                <span>Send</span>
              </>
            )}
          </button>
        </div>

        {/* Resolved URL Preview Banner */}
        {currentTab.url.includes('{{') && (
          <div className="mt-2.5 flex items-center gap-2 rounded-xl bg-zinc-900/60 border border-zinc-800/80 px-3 py-1.5 text-[11px] font-mono text-zinc-400">
            <span className="text-zinc-500 font-semibold shrink-0">Resolved:</span>
            <span className="text-amber-400 font-medium truncate select-all">
              {interpolateVariables(currentTab.url, envVarsMap)}
            </span>
          </div>
        )}

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
            {(Array.isArray(currentTab?.params) ? currentTab.params : []).filter((p) => p && p.enabled && p.key?.trim()).length > 0 && (
              <span className="rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/20 px-1.5 text-[10px]">
                {(Array.isArray(currentTab?.params) ? currentTab.params : []).filter((p) => p && p.enabled && p.key?.trim()).length}
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
            {(Array.isArray(currentTab?.headers) ? currentTab.headers : []).filter((h) => h && h.enabled && h.key?.trim()).length > 0 && (
              <span className="rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/20 px-1.5 text-[10px]">
                {(Array.isArray(currentTab?.headers) ? currentTab.headers : []).filter((h) => h && h.enabled && h.key?.trim()).length}
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
            {(currentTab?.auth?.type || 'none') !== 'none' && (
              <span className="rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 text-[10px]">
                {currentTab?.auth?.type}
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
                {currentTab.bodyType === 'raw' && currentTab.rawType
                  ? `raw (${currentTab.rawType})`
                  : currentTab.bodyType}
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
              items={Array.isArray(currentTab?.params) ? currentTab.params : []}
              onUpdate={updateParam}
              onAdd={addParam}
              onRemove={removeParam}
              keyPlaceholder="Parameter name"
              valuePlaceholder="Value or {{variable}}"
            />
          )}

          {activeTab === 'headers' && (
            <KeyValueEditor
              items={Array.isArray(currentTab?.headers) ? currentTab.headers : []}
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
                        (currentTab?.auth?.type || 'none') === type
                          ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                          : 'border border-zinc-800 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                      }`}
                    >
                      {type === 'apikey' ? 'API Key' : type}
                    </button>
                  ))}
                </div>
              </div>

              {(currentTab?.auth?.type || 'none') === 'none' && (
                <div className="pt-2 text-xs text-zinc-500">
                  This request does not use authorization. Select Bearer, Basic, or API Key above to configure auth credentials.
                </div>
              )}

              {currentTab?.auth?.type === 'bearer' && (
                <div className="space-y-1.5 pt-2 border-t border-zinc-800">
                  <label className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
                    <KeyRound className="h-3.5 w-3.5 text-sky-400" />
                    <span>Bearer Token</span>
                  </label>
                  <VariableInput
                    value={currentTab?.auth?.bearerToken || ''}
                    onChange={(bearerToken) => updateAuth({ bearerToken })}
                    placeholder="Bearer token or {{token}}..."
                    showPreview={true}
                  />
                </div>
              )}

              {currentTab?.auth?.type === 'basic' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-zinc-800">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-300">Username</label>
                    <VariableInput
                      value={currentTab?.auth?.basicUsername || ''}
                      onChange={(basicUsername) => updateAuth({ basicUsername })}
                      placeholder="Username or {{username}}"
                      showPreview={true}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-300">Password</label>
                    <VariableInput
                      type="password"
                      value={currentTab?.auth?.basicPassword || ''}
                      onChange={(basicPassword) => updateAuth({ basicPassword })}
                      placeholder="Password or {{password}}"
                      showPreview={true}
                    />
                  </div>
                </div>
              )}

              {currentTab?.auth?.type === 'apikey' && (
                <div className="space-y-3 pt-2 border-t border-zinc-800">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-zinc-300">Key Name</label>
                      <VariableInput
                        value={currentTab?.auth?.apiKeyKey || ''}
                        onChange={(apiKeyKey) => updateAuth({ apiKeyKey })}
                        placeholder="e.g. X-API-Key or api_key"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-zinc-300">Key Value</label>
                      <VariableInput
                        value={currentTab?.auth?.apiKeyValue || ''}
                        onChange={(apiKeyValue) => updateAuth({ apiKeyValue })}
                        placeholder="e.g. secret_value or {{apiKey}}"
                        showPreview={true}
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
                          currentTab?.auth?.apiKeyIn !== 'query'
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
                          currentTab?.auth?.apiKeyIn === 'query'
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
              <div className="flex flex-wrap items-center justify-between gap-2">
                {/* Body Type Selectors & Raw Type Subselector */}
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex flex-wrap gap-1.5">
                    {(['none', 'json', 'xml', 'graphql', 'form-data', 'x-www-form-urlencoded', 'raw', 'binary'] as BodyType[]).map((type) => (
                      <button
                        key={type}
                        type="button"
                        onClick={() => {
                          setBodyType(type);
                          setJsonFormatError(null);
                          setXmlFormatError(null);
                          setGraphqlQueryError(null);
                          setGraphqlVariablesError(null);
                        }}
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

                  {currentTab.bodyType === 'raw' && (
                    <div className="flex items-center gap-1.5 pl-2 border-l border-zinc-800">
                      <span className="text-[11px] text-zinc-500 font-medium">Type:</span>
                      <div className="flex rounded-lg border border-zinc-800 bg-zinc-950 p-0.5">
                        {(['text', 'json', 'xml', 'html'] as RawType[]).map((rType) => (
                          <button
                            key={rType}
                            type="button"
                            onClick={() => {
                              setRawType(rType);
                              setJsonFormatError(null);
                              setXmlFormatError(null);
                            }}
                            className={`rounded-md px-2 py-0.5 text-xs font-medium transition ${
                              (currentTab.rawType || 'text') === rType
                                ? 'bg-zinc-800 text-sky-400 font-semibold shadow-sm'
                                : 'text-zinc-400 hover:text-zinc-200'
                            }`}
                          >
                            {rType}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {(currentTab.bodyType === 'json' || (currentTab.bodyType === 'raw' && currentTab.rawType === 'json')) && (
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

                  {(currentTab.bodyType === 'xml' || (currentTab.bodyType === 'raw' && currentTab.rawType === 'xml')) && (
                    <button
                      type="button"
                      onClick={handleBeautifyXml}
                      className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white transition"
                      title="Format and validate XML payload"
                    >
                      <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
                      <span>Beautify XML</span>
                    </button>
                  )}

                  {currentTab.bodyType === 'x-www-form-urlencoded' && (
                    <button
                      type="button"
                      onClick={handleToggleBulkEdit}
                      className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white transition"
                      title="Toggle between Key-Value rows and Bulk Edit text"
                    >
                      <Sliders className="h-3.5 w-3.5 text-sky-400" />
                      <span>{isUrlEncodedBulkEdit ? 'Key-Value Edit' : 'Bulk Edit'}</span>
                    </button>
                  )}
                </div>
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
                                    <span>{item.file ? item.file.name : item.fileName || 'Select File...'}</span>
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
                                  {(item.file || item.needsReselection) && (
                                    <span className="text-[10px] text-zinc-500 font-mono">
                                      {item.file ? `(${Math.round(item.file.size / 1024)} KB)` : '(select again before sending)'}
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
              ) : currentTab.bodyType === 'x-www-form-urlencoded' ? (
                /* URL-Encoded Key-Value Form Table */
                <div className="space-y-2">
                  {isUrlEncodedBulkEdit ? (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-[11px] text-zinc-400">
                        <span>Enter fields as <code className="text-sky-300">key: value</code> or <code className="text-sky-300">key=value</code> (one per line):</span>
                      </div>
                      <textarea
                        value={urlEncodedBulkText}
                        onChange={(e) => setUrlEncodedBulkText(e.target.value)}
                        onKeyDown={(e) =>
                          handleCodeEditorKeyDown(e, {
                            onChange: (val) => setUrlEncodedBulkText(val),
                          })
                        }
                        placeholder="username: user123&#10;password: secret&#10;grant_type: password"
                        rows={6}
                        className="w-full rounded-xl border border-zinc-800 bg-zinc-900/90 p-3 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 transition resize-y"
                      />
                    </div>
                  ) : (
                    <KeyValueEditor
                      items={
                        currentTab.bodyUrlEncoded && currentTab.bodyUrlEncoded.length > 0
                          ? currentTab.bodyUrlEncoded
                          : [{ id: 'u1', key: '', value: '', enabled: true }]
                      }
                      onUpdate={updateUrlEncodedItem}
                      onAdd={addUrlEncodedItem}
                      onRemove={removeUrlEncodedItem}
                      keyPlaceholder="Field Key"
                      valuePlaceholder="Field Value or {{variable}}"
                    />
                  )}
                </div>
              ) : currentTab.bodyType === 'binary' ? (
                /* Direct Raw Binary File Upload */
                <div className="space-y-3">
                  {currentTab.bodyBinaryFile?.file || currentTab.bodyBinaryFile?.name ? (
                    <div className="rounded-xl border border-sky-500/30 bg-sky-950/20 p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex items-center gap-3">
                          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-sky-500/10 border border-sky-500/30 text-sky-400">
                            <FileUp className="h-6 w-6" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs font-semibold text-zinc-100">
                                {currentTab.bodyBinaryFile.name}
                              </span>
                              {currentTab.bodyBinaryFile.size > 0 && (
                                <span className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400">
                                  {formatFileSize(currentTab.bodyBinaryFile.size)}
                                </span>
                              )}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
                              <span>MIME Type:</span>
                              <code className="rounded bg-zinc-900 border border-zinc-800 px-1.5 py-0.5 font-mono text-sky-300">
                                {currentTab.bodyBinaryFile.type || 'application/octet-stream'}
                              </code>
                              {currentTab.bodyBinaryFile.needsReselection && (
                                <span className="text-amber-300">Select the file again before sending.</span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <label className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-850 hover:text-white cursor-pointer transition">
                            <RefreshCw className="h-3.5 w-3.5 text-sky-400" />
                            <span>Replace</span>
                            <input
                              type="file"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) {
                                  setBodyBinaryFile({
                                    name: file.name,
                                    size: file.size,
                                    type: file.type || 'application/octet-stream',
                                    file,
                                  });
                                }
                              }}
                            />
                          </label>

                          <button
                            type="button"
                            onClick={() => setBodyBinaryFile(undefined)}
                            className="flex items-center gap-1 rounded-lg border border-rose-500/20 bg-rose-500/10 px-2 py-1 text-xs font-medium text-rose-400 hover:bg-rose-500/20 transition"
                            title="Remove attached file"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>Remove</span>
                          </button>
                        </div>
                      </div>

                      <div className="mt-3.5 flex items-center gap-2 rounded-lg bg-zinc-900/60 border border-zinc-850 px-3 py-2 text-[11px] text-zinc-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
                        <span>
                          Direct binary payload: file will be streamed directly in the request body with{' '}
                          <code className="text-zinc-300">Content-Type: {currentTab.bodyBinaryFile.type || 'application/octet-stream'}</code>{' '}
                          (override anytime in the Headers tab).
                        </span>
                      </div>
                    </div>
                  ) : (
                    <label
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const file = e.dataTransfer.files?.[0];
                        if (file) {
                          setBodyBinaryFile({
                            name: file.name,
                            size: file.size,
                            type: file.type || 'application/octet-stream',
                            file,
                          });
                        }
                      }}
                      className="group flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-zinc-800 bg-zinc-900/30 hover:border-sky-500/60 hover:bg-zinc-900/60 p-8 text-center cursor-pointer transition"
                    >
                      <input
                        type="file"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            setBodyBinaryFile({
                              name: file.name,
                              size: file.size,
                              type: file.type || 'application/octet-stream',
                              file,
                            });
                          }
                        }}
                      />
                      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-900 border border-zinc-800 text-zinc-400 group-hover:scale-110 group-hover:text-sky-400 group-hover:border-sky-500/40 transition">
                        <UploadCloud className="h-6 w-6" />
                      </div>
                      <div className="mt-3 text-xs font-semibold text-zinc-200 group-hover:text-white transition">
                        Drop binary file here or click to browse
                      </div>
                      <div className="mt-1 text-[11px] text-zinc-500 max-w-sm">
                        Raw binary stream (images, PDFs, documents, audio, zip). Sent directly in the HTTP request body without multipart boundaries.
                      </div>
                    </label>
                  )}
                </div>
              ) : currentTab.bodyType === 'graphql' ? (
                /* GraphQL Query & Variables Dual Editor */
                <div className="space-y-4">
                  {/* Query Editor */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-300">
                        <Code2 className="h-3.5 w-3.5 text-pink-400" />
                        <span>Query / Mutation</span>
                      </div>
                      <button
                        type="button"
                        onClick={handleBeautifyGraphQLQuery}
                        className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white transition"
                        title="Prettify GraphQL Query"
                      >
                        <Sparkles className="h-3.5 w-3.5 text-pink-400" />
                        <span>Prettify Query</span>
                      </button>
                    </div>
                    <textarea
                      value={currentTab.graphqlQuery ?? currentTab.bodyContent}
                      onChange={(e) => {
                        setGraphqlQuery(e.target.value);
                        setBodyContent(e.target.value);
                        if (graphqlQueryError) setGraphqlQueryError(null);
                      }}
                      onKeyDown={(e) =>
                        handleCodeEditorKeyDown(e, {
                          onChange: (val) => {
                            setGraphqlQuery(val);
                            setBodyContent(val);
                            if (graphqlQueryError) setGraphqlQueryError(null);
                          },
                        })
                      }
                      placeholder={`query GetUsers($limit: Int) {\n  users(limit: $limit) {\n    id\n    name\n    email\n  }\n}`}
                      rows={8}
                      className="w-full rounded-xl border border-zinc-800 bg-zinc-900/90 p-3 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-pink-500 focus:outline-none focus:ring-1 focus:ring-pink-500 transition resize-y"
                    />
                    {graphqlQueryError && (
                      <p className="text-[11px] text-rose-400 font-mono">{graphqlQueryError}</p>
                    )}
                  </div>

                  {/* Variables Editor */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-300">
                        <Sliders className="h-3.5 w-3.5 text-sky-400" />
                        <span>GraphQL Variables (JSON)</span>
                      </div>
                      <button
                        type="button"
                        onClick={handleBeautifyGraphQLVariables}
                        className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white transition"
                        title="Beautify Variables JSON"
                      >
                        <Sparkles className="h-3.5 w-3.5 text-sky-400" />
                        <span>Beautify Variables</span>
                      </button>
                    </div>
                    <textarea
                      value={currentTab.graphqlVariables || ''}
                      onChange={(e) => {
                        setGraphqlVariables(e.target.value);
                        if (graphqlVariablesError) setGraphqlVariablesError(null);
                      }}
                      onKeyDown={(e) =>
                        handleCodeEditorKeyDown(e, {
                          onChange: (val) => {
                            setGraphqlVariables(val);
                            if (graphqlVariablesError) setGraphqlVariablesError(null);
                          },
                        })
                      }
                      placeholder={`{\n  "limit": 10\n}`}
                      rows={4}
                      className="w-full rounded-xl border border-zinc-800 bg-zinc-900/90 p-3 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 transition resize-y"
                    />
                    {graphqlVariablesError && (
                      <p className="text-[11px] text-rose-400 font-mono">{graphqlVariablesError}</p>
                    )}
                  </div>
                </div>
              ) : currentTab.bodyType !== 'none' ? (
                <div className="space-y-1">
                  <textarea
                    value={currentTab.bodyContent}
                    onChange={(e) => {
                      setBodyContent(e.target.value);
                      if (jsonFormatError) setJsonFormatError(null);
                      if (xmlFormatError) setXmlFormatError(null);
                    }}
                    onKeyDown={(e) =>
                      handleCodeEditorKeyDown(e, {
                        onChange: (val) => {
                          setBodyContent(val);
                          if (jsonFormatError) setJsonFormatError(null);
                          if (xmlFormatError) setXmlFormatError(null);
                        },
                      })
                    }
                    placeholder={
                      currentTab.bodyType === 'json' || (currentTab.bodyType === 'raw' && currentTab.rawType === 'json')
                        ? '{\n  "title": "foo",\n  "userId": "{{userId}}"\n}'
                        : currentTab.bodyType === 'xml' || (currentTab.bodyType === 'raw' && currentTab.rawType === 'xml')
                        ? '<?xml version="1.0" encoding="UTF-8"?>\n<request>\n  <item id="1">example</item>\n</request>'
                        : currentTab.bodyType === 'raw' && currentTab.rawType === 'html'
                        ? '<!DOCTYPE html>\n<html>\n  <body>\n    <h1>Hello</h1>\n  </body>\n</html>'
                        : 'Raw body payload with {{variable}}...'
                    }
                    rows={6}
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-900/90 p-3 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 transition resize-y"
                  />
                  {jsonFormatError && (
                    <p className="text-[11px] text-rose-400 font-mono">{jsonFormatError}</p>
                  )}
                  {xmlFormatError && (
                    <p className="text-[11px] text-rose-400 font-mono">{xmlFormatError}</p>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-center rounded-xl border border-dashed border-zinc-800/80 p-8 text-center text-xs text-zinc-500">
                  This request does not have a body. Select JSON, XML, GraphQL, form-data, Raw, or Binary to attach payload.
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
                onKeyDown={(e) =>
                  handleCodeEditorKeyDown(e, {
                    onChange: (val) => setPreRequestScript(val),
                  })
                }
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
                onKeyDown={(e) =>
                  handleCodeEditorKeyDown(e, {
                    onChange: (val) => setPostResponseScript(val),
                  })
                }
                placeholder="// JavaScript executed after response is received:\n// const data = pm.response.json();\n// pm.environment.set('token', data.token);\n// if (pm.response.code !== 200) throw new Error('Status failed');"
                rows={8}
                className="w-full rounded-xl border border-zinc-800 bg-zinc-900/90 p-3 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 transition resize-y"
              />

              <p className="text-[11px] text-zinc-500 leading-relaxed">
                Use <code className="text-emerald-400">pm.response.json()</code> to inspect payload and <code className="text-emerald-400">pm.environment.set(&apos;token&apos;, token)</code> to automatically persist tokens or IDs. Subsequent requests will immediately use <code className="text-sky-400">&#123;&#123;token&#125;&#125;</code> in Headers or Auth!
              </p>
            </div>
          )}
        </div>
      </div>

      <SaveToCollectionModal
        isOpen={isSaveModalOpen}
        onClose={() => {
          setIsSaveModalOpen(false);
          setIsSaveAsMode(false);
        }}
        request={currentTab}
        isSaveAs={isSaveAsMode}
      />
    </>
  );
};
