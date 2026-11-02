import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Code2,
  Eye,
  Sliders,
  Plus,
  Copy,
  Check,
  Sparkles,
  AlertCircle,
  FolderTree,
  ChevronDown,
  ChevronRight,
  RotateCcw,
} from 'lucide-react';
import { PayloadBuilderConfig, PayloadNode } from '../../types/payloadBuilder';
import {
  treeToJson,
  treeToXml,
  createDefaultPayloadNode,
  createInitialPayloadConfig,
  sanitizeXmlTagName,
} from '../../lib/payloadCompiler';
import { jsonToTree, xmlToTree } from '../../lib/payloadReverseParser';
import { PayloadNodeRow } from './PayloadNodeRow';
import { handleCodeEditorKeyDown } from '../../lib/editorHelper';

interface PayloadBuilderProps {
  format: 'json' | 'xml';
  bodyContent: string;
  onBodyContentChange: (newContent: string) => void;
}

type ViewMode = 'builder' | 'preview' | 'raw';

export const PayloadBuilder: React.FC<PayloadBuilderProps> = ({
  format,
  bodyContent,
  onBodyContentChange,
}) => {
  const [viewMode, setViewMode] = useState<ViewMode>('builder');
  const [copied, setCopied] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [rawText, setRawText] = useState(bodyContent || '');

  // Initialize builder tree configuration
  const [builderConfig, setBuilderConfig] = useState<PayloadBuilderConfig>(() => {
    if (bodyContent && bodyContent.trim()) {
      const parsed = format === 'json' ? jsonToTree(bodyContent) : xmlToTree(bodyContent);
      if (parsed.config) {
        return parsed.config;
      }
    }
    return createInitialPayloadConfig('object');
  });

  // Keep rawText synced when bodyContent changes externally
  useEffect(() => {
    setRawText(bodyContent || '');
  }, [bodyContent]);

  // Serializer function
  const compileTree = useCallback(
    (config: PayloadBuilderConfig): string => {
      return format === 'json' ? treeToJson(config) : treeToXml(config);
    },
    [format]
  );

  // Synchronize builder changes to bodyContent
  const updateBuilderConfig = useCallback(
    (updater: (prev: PayloadBuilderConfig) => PayloadBuilderConfig) => {
      setBuilderConfig((prev) => {
        const next = updater(prev);
        const compiled = compileTree(next);
        onBodyContentChange(compiled);
        setRawText(compiled);
        setParseError(null);
        return next;
      });
    },
    [compileTree, onBodyContentChange]
  );

  // Switch between view modes with automatic two-way sync
  const handleSelectViewMode = (mode: ViewMode) => {
    if (mode === 'builder' && viewMode === 'raw') {
      // User switched from Raw to Builder: attempt reverse parse
      const res = format === 'json' ? jsonToTree(rawText) : xmlToTree(rawText);
      if (res.error) {
        setParseError(`Reverse parse failed: ${res.error}. Showing previous builder state.`);
      } else if (res.config) {
        setBuilderConfig(res.config);
        setParseError(null);
      }
    } else if (mode === 'raw' && viewMode === 'builder') {
      // Ensure rawText matches the latest compiled tree
      setRawText(compileTree(builderConfig));
      setParseError(null);
    }
    setViewMode(mode);
  };

  // Manual "Sync from Raw" action
  const handleSyncFromRaw = () => {
    const res = format === 'json' ? jsonToTree(rawText) : xmlToTree(rawText);
    if (res.error) {
      setParseError(res.error);
    } else if (res.config) {
      setBuilderConfig(res.config);
      onBodyContentChange(rawText);
      setParseError(null);
      setViewMode('builder');
    }
  };

  // Copy compiled output to clipboard
  const handleCopy = () => {
    const textToCopy = viewMode === 'raw' ? rawText : compileTree(builderConfig);
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Add Root Field / Item
  const handleAddRootNode = () => {
    updateBuilderConfig((prev) => {
      const isList = prev.rootType === 'list';
      const newNode = createDefaultPayloadNode({
        key: isList ? '' : `field_${prev.nodes.length + 1}`,
        type: 'string',
        value: '',
      });
      return {
        ...prev,
        nodes: [...prev.nodes, newNode],
      };
    });
  };

  // Switch Root Type (Object <-> List)
  const handleToggleRootType = (rootType: 'object' | 'list') => {
    updateBuilderConfig((prev) => {
      if (prev.rootType === rootType) return prev;
      return {
        ...prev,
        rootType,
      };
    });
  };

  // Expand / Collapse All
  const handleToggleAllCollapse = (collapse: boolean) => {
    const applyCollapse = (nodes: PayloadNode[]): PayloadNode[] => {
      return nodes.map((n) => ({
        ...n,
        isCollapsed: collapse,
        children: n.children ? applyCollapse(n.children) : undefined,
      }));
    };

    updateBuilderConfig((prev) => ({
      ...prev,
      nodes: applyCollapse(prev.nodes),
    }));
  };

  // Node CRUD handlers
  const handleUpdateNode = (nodeId: string, updatedNode: PayloadNode) => {
    updateBuilderConfig((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === nodeId ? updatedNode : n)),
    }));
  };

  const handleDeleteNode = (nodeId: string) => {
    updateBuilderConfig((prev) => ({
      ...prev,
      nodes: prev.nodes.filter((n) => n.id !== nodeId),
    }));
  };

  // Compiled text for preview
  const compiledText = useMemo(() => {
    return compileTree(builderConfig);
  }, [compileTree, builderConfig]);

  const byteSize = useMemo(() => {
    const text = viewMode === 'raw' ? rawText : compiledText;
    return new TextEncoder().encode(text).length;
  }, [viewMode, rawText, compiledText]);

  return (
    <div className="space-y-3">
      {/* Top Segmented Navigation & Actions */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2.5">
        {/* Segmented Mode Control */}
        <div className="flex items-center rounded-xl border border-line bg-element p-0.5">
          <button
            type="button"
            onClick={() => handleSelectViewMode('builder')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium transition ${
              viewMode === 'builder'
                ? 'bg-card text-sky-600 dark:text-sky-400 font-semibold shadow-sm'
                : 'text-tx-muted hover:text-tx-primary'
            }`}
          >
            <Sliders className="h-3.5 w-3.5" />
            <span>Builder</span>
          </button>

          <button
            type="button"
            onClick={() => handleSelectViewMode('preview')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium transition ${
              viewMode === 'preview'
                ? 'bg-card text-emerald-600 dark:text-emerald-400 font-semibold shadow-sm'
                : 'text-tx-muted hover:text-tx-primary'
            }`}
          >
            <Eye className="h-3.5 w-3.5" />
            <span>Result Preview</span>
          </button>

          <button
            type="button"
            onClick={() => handleSelectViewMode('raw')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium transition ${
              viewMode === 'raw'
                ? 'bg-card text-amber-600 dark:text-amber-400 font-semibold shadow-sm'
                : 'text-tx-muted hover:text-tx-primary'
            }`}
          >
            <Code2 className="h-3.5 w-3.5" />
            <span>Raw</span>
          </button>
        </div>

        {/* Right Action Utilities */}
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-tx-muted">
            {byteSize} B
          </span>

          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 py-1 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition cursor-pointer"
            title="Copy payload to clipboard"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-500" />
                <span className="text-emerald-500 font-semibold">Copied!</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5 text-sky-500" />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Parse Error Alert Banner (if any) */}
      {parseError && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-600 dark:text-rose-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="flex-1 font-mono text-[11px]">{parseError}</span>
          <button
            type="button"
            onClick={() => setParseError(null)}
            className="text-rose-500 hover:text-rose-700 font-bold px-1"
          >
            ×
          </button>
        </div>
      )}

      {/* VIEW 1: VISUAL FORM BUILDER */}
      {viewMode === 'builder' && (
        <div className="space-y-3">
          {/* Builder Sub-Header: Root Type Switcher & XML Tags */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-element/50 p-2 text-xs">
            {/* Root Type Buttons */}
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-tx-muted font-medium">Root:</span>
              <div className="flex rounded-lg border border-line bg-card p-0.5">
                <button
                  type="button"
                  onClick={() => handleToggleRootType('object')}
                  className={`rounded px-2.5 py-0.5 font-mono text-xs font-medium transition ${
                    builderConfig.rootType === 'object'
                      ? 'bg-sky-500/20 text-sky-600 dark:text-sky-400 font-bold shadow-xs'
                      : 'text-tx-muted hover:text-tx-primary'
                  }`}
                >
                  {'{ } Object'}
                </button>
                <button
                  type="button"
                  onClick={() => handleToggleRootType('list')}
                  className={`rounded px-2.5 py-0.5 font-mono text-xs font-medium transition ${
                    builderConfig.rootType === 'list'
                      ? 'bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 font-bold shadow-xs'
                      : 'text-tx-muted hover:text-tx-primary'
                  }`}
                >
                  {'[ ] List'}
                </button>
              </div>

              {/* XML Root / Container Tag Inputs */}
              {format === 'xml' && (
                <div className="flex items-center gap-2 pl-2 border-l border-line">
                  {builderConfig.rootType === 'object' ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] text-tx-muted">Root Tag:</span>
                      <input
                        type="text"
                        value={builderConfig.rootKey || 'request'}
                        onChange={(e) =>
                          updateBuilderConfig((prev) => ({
                            ...prev,
                            rootKey: sanitizeXmlTagName(e.target.value, 'request'),
                          }))
                        }
                        placeholder="request"
                        className="w-24 rounded border border-line bg-card px-2 py-0.5 font-mono text-xs text-tx-primary focus:outline-none focus:ring-1 focus:ring-sky-500"
                      />
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1">
                        <span className="text-[11px] text-tx-muted">Container:</span>
                        <input
                          type="text"
                          value={builderConfig.xmlContainerTag || 'items'}
                          onChange={(e) =>
                            updateBuilderConfig((prev) => ({
                              ...prev,
                              xmlContainerTag: sanitizeXmlTagName(e.target.value, 'items'),
                            }))
                          }
                          placeholder="items"
                          className="w-20 rounded border border-line bg-card px-2 py-0.5 font-mono text-xs text-tx-primary focus:outline-none focus:ring-1 focus:ring-sky-500"
                        />
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-[11px] text-tx-muted">Item:</span>
                        <input
                          type="text"
                          value={builderConfig.xmlItemTag || 'item'}
                          onChange={(e) =>
                            updateBuilderConfig((prev) => ({
                              ...prev,
                              xmlItemTag: sanitizeXmlTagName(e.target.value, 'item'),
                            }))
                          }
                          placeholder="item"
                          className="w-16 rounded border border-line bg-card px-2 py-0.5 font-mono text-xs text-tx-primary focus:outline-none focus:ring-1 focus:ring-sky-500"
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Tree Utilities */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleToggleAllCollapse(false)}
                className="text-[11px] text-tx-muted hover:text-tx-primary px-1.5 py-0.5 rounded transition"
                title="Expand all tree nodes"
              >
                Expand All
              </button>
              <button
                type="button"
                onClick={() => handleToggleAllCollapse(true)}
                className="text-[11px] text-tx-muted hover:text-tx-primary px-1.5 py-0.5 rounded transition"
                title="Collapse all tree nodes"
              >
                Collapse All
              </button>
            </div>
          </div>

          {/* Tree Node List Container */}
          <div className="rounded-xl border border-line bg-surface p-2 space-y-1">
            {builderConfig.nodes.map((node, idx) => (
              <PayloadNodeRow
                key={node.id || `root_${idx}`}
                node={node}
                parentType={builderConfig.rootType}
                index={idx}
                level={0}
                isXmlMode={format === 'xml'}
                onUpdate={(updated) => handleUpdateNode(node.id, updated)}
                onDelete={() => handleDeleteNode(node.id)}
              />
            ))}

            {builderConfig.nodes.length === 0 && (
              <div className="py-6 text-center text-xs text-tx-muted">
                No fields defined in this payload. Click below to add your first field.
              </div>
            )}
          </div>

          {/* Add Root Field Button */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleAddRootNode}
              className="flex items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-1.5 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5 text-sky-500" />
              <span>{builderConfig.rootType === 'list' ? 'Add Item' : 'Add Field'}</span>
            </button>
          </div>
        </div>
      )}

      {/* VIEW 2: RESULT PREVIEW */}
      {viewMode === 'preview' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-[11px] text-tx-muted">
            <span>
              Real-time compiled {format.toUpperCase()} output (read-only):
            </span>
          </div>

          <pre className="w-full max-h-[420px] overflow-auto rounded-xl border border-line bg-element p-3.5 font-mono text-xs text-tx-primary select-text leading-relaxed">
            <code>{compiledText || (format === 'json' ? '{}' : '<request />')}</code>
          </pre>
        </div>
      )}

      {/* VIEW 3: RAW EDITOR (with Sync to Builder) */}
      {viewMode === 'raw' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-[11px] text-tx-muted">
            <span>Edit raw {format.toUpperCase()} payload or paste from external source:</span>
            <button
              type="button"
              onClick={handleSyncFromRaw}
              className="flex items-center gap-1 text-xs text-sky-600 dark:text-sky-400 hover:underline font-semibold"
            >
              <RotateCcw className="h-3 w-3" />
              <span>Sync to Builder</span>
            </button>
          </div>

          <textarea
            value={rawText}
            onChange={(e) => {
              setRawText(e.target.value);
              onBodyContentChange(e.target.value);
              if (parseError) setParseError(null);
            }}
            onKeyDown={(e) =>
              handleCodeEditorKeyDown(e, {
                onChange: (val) => {
                  setRawText(val);
                  onBodyContentChange(val);
                  if (parseError) setParseError(null);
                },
              })
            }
            rows={10}
            className="w-full rounded-xl border border-line bg-card p-3 font-mono text-xs text-tx-primary placeholder-tx-faint focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 transition resize-y leading-relaxed"
            placeholder={
              format === 'json'
                ? '{\n  "title": "foo",\n  "count": 1\n}'
                : '<request>\n  <title>foo</title>\n</request>'
            }
          />
        </div>
      )}
    </div>
  );
};
