import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Code2,
  Eye,
  Sliders,
  Plus,
  Copy,
  Check,
  Sparkles,
  AlertCircle,
  RotateCcw,
  Maximize2,
  Minimize2,
  GripHorizontal,
  X,
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
import { beautifyJson, beautifyXml } from '../../lib/formatters';
import { useBackHandler } from '../../lib/backNavigation';

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
  const initialParse = useMemo(() => {
    if (bodyContent && bodyContent.trim()) {
      return format === 'json' ? jsonToTree(bodyContent) : xmlToTree(bodyContent);
    }
    return { config: createInitialPayloadConfig('object') };
  }, [bodyContent, format]);

  // Default to 'raw' view mode as requested, preserving comments, whitespace, and user formatting
  const [viewMode, setViewMode] = useState<ViewMode>('raw');

  const [copied, setCopied] = useState(false);
  const [parseError, setParseError] = useState<string | null>(initialParse.error || null);
  const [rawText, setRawText] = useState(bodyContent || '');
  const [isExpandedModalOpen, setIsExpandedModalOpen] = useState(false);

  // Drag-to-resize editor height (persisted in localStorage)
  const [editorHeight, setEditorHeight] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('airrest:payload_editor_height');
      if (saved) {
        const val = parseInt(saved, 10);
        if (!isNaN(val) && val >= 140 && val <= 800) return val;
      }
    } catch {
      // ignore
    }
    return 260;
  });

  const isResizingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(260);

  // Initialize builder tree configuration
  const [builderConfig, setBuilderConfig] = useState<PayloadBuilderConfig>(() => {
    return initialParse.config || createInitialPayloadConfig('object');
  });

  const isInternalUpdateRef = useRef(false);

  // Register back navigation handler for expanded modal
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
        isInternalUpdateRef.current = true;
        onBodyContentChange(compiled);
        setRawText(compiled);
        setParseError(null);
        return next;
      });
    },
    [compileTree, onBodyContentChange]
  );

  // Keep builderConfig and rawText synced when bodyContent changes externally (e.g. storage hydration, tab switch)
  useEffect(() => {
    if (isInternalUpdateRef.current) {
      isInternalUpdateRef.current = false;
      return;
    }

    const text = bodyContent || '';
    setRawText(text);

    if (text.trim()) {
      const parsed = format === 'json' ? jsonToTree(text) : xmlToTree(text);
      if (parsed.config) {
        setBuilderConfig(parsed.config);
        setParseError(null);
      } else if (parsed.error) {
        setParseError(parsed.error);
        setViewMode('raw');
      }
    } else {
      setBuilderConfig(createInitialPayloadConfig('object'));
      setParseError(null);
    }
  }, [bodyContent, format]);

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
    }
    setParseError(null);
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

  // Format / Beautify action
  const handleBeautify = () => {
    if (format === 'json') {
      const res = beautifyJson(rawText);
      if (res.error) {
        setParseError(`Beautify JSON error: ${res.error}`);
      } else {
        setRawText(res.formatted);
        onBodyContentChange(res.formatted);
        setParseError(null);
      }
    } else {
      const res = beautifyXml(rawText);
      if (res.error) {
        setParseError(`Beautify XML error: ${res.error}`);
      } else {
        setRawText(res.formatted);
        onBodyContentChange(res.formatted);
        setParseError(null);
      }
    }
  };

  // Copy compiled output to clipboard
  const handleCopy = () => {
    const textToCopy = viewMode === 'raw' ? rawText : compileTree(builderConfig);
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Resize handler (Mouse)
  const handleStartResize = (clientY: number) => {
    isResizingRef.current = true;
    startYRef.current = clientY;
    startHeightRef.current = editorHeight;

    const onMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;
      const deltaY = e.clientY - startYRef.current;
      const newHeight = Math.max(140, Math.min(800, startHeightRef.current + deltaY));
      setEditorHeight(newHeight);
    };

    const onMouseUp = () => {
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.style.removeProperty('user-select');
      document.body.style.removeProperty('cursor');
      try {
        setEditorHeight((curr) => {
          localStorage.setItem('airrest:payload_editor_height', String(curr));
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

  // Resize handler (Touch)
  const handleTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    const startY = touch.clientY;
    const startH = editorHeight;

    const onTouchMove = (ev: TouchEvent) => {
      const t = ev.touches[0];
      if (!t) return;
      const deltaY = t.clientY - startY;
      const newHeight = Math.max(140, Math.min(800, startH + deltaY));
      setEditorHeight(newHeight);
    };

    const onTouchEnd = () => {
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      try {
        setEditorHeight((curr) => {
          localStorage.setItem('airrest:payload_editor_height', String(curr));
          return curr;
        });
      } catch {
        // ignore
      }
    };

    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd);
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

  // Shared Sub-Views
  const renderBuilderView = (isModal: boolean) => (
    <div className={`space-y-3 ${isModal ? 'flex-1 min-h-0 flex flex-col' : ''}`}>
      {/* Builder Sub-Header: Root Type Switcher & XML Tags */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-element/50 p-2 text-xs shrink-0">
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
      <div
        style={!isModal ? { maxHeight: `${editorHeight}px` } : undefined}
        className={`rounded-xl border border-line bg-surface p-2 space-y-1 overflow-y-auto ${
          isModal ? 'flex-1 min-h-0' : ''
        }`}
      >
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
      <div className="flex items-center gap-2 shrink-0">
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
  );

  const renderPreviewView = (isModal: boolean) => (
    <div className={`space-y-2 ${isModal ? 'flex-1 min-h-0 flex flex-col' : ''}`}>
      <div className="flex items-center justify-between text-[11px] text-tx-muted shrink-0">
        <span>
          Real-time compiled {format.toUpperCase()} output (read-only):
        </span>
      </div>

      <pre
        style={!isModal ? { height: `${editorHeight}px` } : undefined}
        className={`w-full overflow-auto rounded-xl border border-line bg-element p-3.5 font-mono text-xs text-tx-primary select-text leading-relaxed ${
          isModal ? 'flex-1 min-h-0' : ''
        }`}
      >
        <code>{compiledText || (format === 'json' ? '{}' : '<request />')}</code>
      </pre>
    </div>
  );

  const renderRawView = (isModal: boolean) => (
    <div className={`space-y-2 ${isModal ? 'flex-1 min-h-0 flex flex-col' : ''}`}>
      <div className="flex items-center justify-between text-[11px] text-tx-muted shrink-0">
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
        style={!isModal ? { height: `${editorHeight}px`, minHeight: '140px' } : undefined}
        className={`w-full rounded-xl border border-line bg-card p-3 font-mono text-xs text-tx-primary placeholder-tx-faint focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 transition leading-relaxed ${
          isModal ? 'flex-1 min-h-0 resize-none' : 'resize-y'
        }`}
        placeholder={
          format === 'json'
            ? '{\n  "title": "foo",\n  "count": 1\n}'
            : '<request>\n  <title>foo</title>\n</request>'
        }
      />
    </div>
  );

  return (
    <div className="space-y-3">
      {/* Top Segmented Navigation & Actions */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2.5">
        {/* Segmented Mode Control */}
        <div className="flex items-center rounded-xl border border-line bg-element p-0.5">
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

          {/* 4-Arrow Expand Button for Fullscreen/Modal View */}
          <button
            type="button"
            onClick={() => setIsExpandedModalOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 py-1 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition cursor-pointer"
            title="Expand payload editor to modal pop-up"
          >
            <Maximize2 className="h-3.5 w-3.5 text-tx-muted hover:text-sky-500" />
            <span>Expand</span>
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

      {/* ACTIVE INLINE VIEW */}
      {viewMode === 'builder' && renderBuilderView(false)}
      {viewMode === 'preview' && renderPreviewView(false)}
      {viewMode === 'raw' && renderRawView(false)}

      {/* Draggable Height Resize Handle */}
      <div
        onMouseDown={(e) => handleStartResize(e.clientY)}
        onTouchStart={handleTouchStart}
        onDoubleClick={() => {
          setEditorHeight(260);
          try {
            localStorage.setItem('airrest:payload_editor_height', '260');
          } catch {
            // ignore
          }
        }}
        className="flex items-center justify-center py-1 cursor-row-resize hover:bg-hover/60 rounded-md transition select-none group"
        title="Drag up/down to resize height (Double-click to reset)"
      >
        <div className="flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-element/50 group-hover:bg-element border border-transparent group-hover:border-line transition">
          <GripHorizontal className="h-3.5 w-3.5 text-tx-muted group-hover:text-sky-500 transition" />
          <span className="text-[10px] font-mono text-tx-muted group-hover:text-tx-secondary hidden group-hover:inline">
            {editorHeight}px (Drag to resize)
          </span>
        </div>
      </div>

      {/* EXPANDED FULL-SCREEN / LARGE MODAL POP-UP */}
      {isExpandedModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-3 md:p-6 animate-in fade-in duration-150">
          <div className="flex flex-col w-full max-w-6xl h-[92vh] max-h-[960px] rounded-2xl border border-line bg-surface shadow-2xl overflow-hidden">
            {/* Modal Top Header */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3 bg-element/40 shrink-0">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-sky-500/20 bg-sky-500/10 text-sky-500">
                    <Code2 className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-tx-primary">Request Payload Editor</span>
                      <span className="rounded bg-sky-500/10 border border-sky-500/20 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-sky-600 dark:text-sky-400">
                        {format.toUpperCase()}
                      </span>
                    </div>
                    <span className="text-[11px] text-tx-muted hidden sm:inline">
                      Spacious editor with instant two-way synchronization
                    </span>
                  </div>
                </div>

                {/* Segmented Mode Control in Modal Header */}
                <div className="flex items-center rounded-xl border border-line bg-element p-0.5 ml-1">
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
                </div>
              </div>

              {/* Modal Actions */}
              <div className="flex items-center gap-2">
                {/* Beautify Button inside modal */}
                <button
                  type="button"
                  onClick={handleBeautify}
                  className="flex items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition cursor-pointer"
                  title={`Format ${format.toUpperCase()} payload`}
                >
                  <Sparkles className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" />
                  <span>Beautify {format.toUpperCase()}</span>
                </button>

                <span className="font-mono text-xs text-tx-muted px-1">{byteSize} B</span>

                {/* Copy Button */}
                <button
                  type="button"
                  onClick={handleCopy}
                  className="flex items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs font-medium text-tx-secondary hover:bg-hover hover:text-tx-primary transition cursor-pointer"
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

                {/* Collapse Button with 4-Arrow Minimize Icon */}
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

            {/* Parse Error Alert in Modal */}
            {parseError && (
              <div className="mx-5 mt-3 flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-600 dark:text-rose-400 shrink-0">
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

            {/* Modal Main Content Area */}
            <div className="flex-1 min-h-0 p-5 overflow-hidden flex flex-col bg-app">
              {viewMode === 'builder' && renderBuilderView(true)}
              {viewMode === 'preview' && renderPreviewView(true)}
              {viewMode === 'raw' && renderRawView(true)}
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between border-t border-line px-5 py-2.5 bg-element/30 text-xs text-tx-muted shrink-0">
              <div className="flex items-center gap-2 text-[11px]">
                <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                <span>Real-time sync active. Press <kbd className="rounded border border-line bg-card px-1.5 py-0.5 font-mono text-[10px] text-tx-primary">Esc</kbd> or click <b>Collapse</b> when finished.</span>
              </div>
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
    </div>
  );
};
