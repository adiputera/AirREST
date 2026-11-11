import React, { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { EditorView, lineNumbers, highlightActiveLineGutter, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { Annotation, EditorState, Compartment, Transaction } from '@codemirror/state';
import { foldGutter, foldAll, unfoldAll, syntaxHighlighting, indentUnit, foldKeymap, HighlightStyle } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands';
import { json, jsonLanguage } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';
import { tags as t } from '@lezer/highlight';
import { useApiStore } from '../../store/useApiStore';
import { resolveTheme } from '../../lib/theme';

export interface CodeEditorHandle {
  foldAll: () => void;
  unfoldAll: () => void;
  focus: () => void;
  getView: () => EditorView | null;
}

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string, isDiscrete?: boolean) => void;
  readOnly?: boolean;
  language?: 'json' | 'xml' | 'text';
  placeholder?: string;
  height?: string | number;
  minHeight?: string | number;
  maxHeight?: string | number;
  className?: string;
  lineNumbers?: boolean;
  foldGutter?: boolean;
  historyMode?: 'editor' | 'external';
  onUndo?: () => void;
  onRedo?: () => void;
}

const externalValueSync = Annotation.define<boolean>();

/**
 * High-contrast dark syntax highlighting style.
 * Uses bright yellow/amber (#facc15) for string values for excellent readability against dark backgrounds.
 */
export const darkHighlightStyle = HighlightStyle.define([
  // String literals: Bright high-contrast yellow (#facc15)
  { tag: [t.string, t.character, t.attributeValue], color: '#facc15' },
  // Property names / Keys: Crisp, high-contrast sky blue (#38bdf8)
  { tag: [t.propertyName, t.attributeName], color: '#38bdf8', fontWeight: '500' },
  // Numbers: Vibrant orange (#fb923c)
  { tag: [t.number, t.integer, t.float], color: '#fb923c' },
  // Booleans & Null: Vibrant rose/coral (#f43f5e)
  { tag: [t.bool, t.null, t.atom], color: '#f43f5e', fontWeight: '600' },
  // Comments: Readable muted slate (#94a3b8) with italic
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#94a3b8', fontStyle: 'italic' },
  // Braces, brackets, and punctuation: Crisp light slate (#cbd5e1)
  { tag: [t.punctuation, t.bracket, t.brace, t.separator], color: '#cbd5e1' },
  // Tags (for XML/HTML): Sky blue (#38bdf8)
  { tag: [t.tagName, t.angleBracket], color: '#38bdf8' },
  // Keywords & Operators: Pink (#ec4899)
  { tag: [t.keyword, t.operatorKeyword, t.operator], color: '#ec4899', fontWeight: '600' },
]);

/**
 * High-contrast light syntax highlighting style.
 */
export const lightHighlightStyle = HighlightStyle.define([
  // String literals: Deep rich amber/gold (#b45309) for great contrast on white/light background
  { tag: [t.string, t.character, t.attributeValue], color: '#b45309' },
  // Property names / Keys: Deep sky blue (#0284c7)
  { tag: [t.propertyName, t.attributeName], color: '#0284c7', fontWeight: '600' },
  // Numbers: Deep orange (#c2410c)
  { tag: [t.number, t.integer, t.float], color: '#c2410c' },
  // Booleans & Null: Deep rose (#be123c)
  { tag: [t.bool, t.null, t.atom], color: '#be123c', fontWeight: '600' },
  // Comments: Muted slate (#64748b) with italic
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#64748b', fontStyle: 'italic' },
  // Braces, brackets, and punctuation: Slate-600 (#475569)
  { tag: [t.punctuation, t.bracket, t.brace, t.separator], color: '#475569' },
  // Tags (for XML/HTML): Deep blue (#0369a1)
  { tag: [t.tagName, t.angleBracket], color: '#0369a1' },
  // Keywords & Operators: Deep pink (#be185d)
  { tag: [t.keyword, t.operatorKeyword, t.operator], color: '#be185d', fontWeight: '600' },
]);

const getCustomAirRestTheme = (isDark: boolean) =>
  EditorView.theme(
    {
      '&': {
        backgroundColor: 'transparent',
        color: 'var(--text-primary, #f8fafc)',
        fontSize: '12px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        height: '100%',
      },
      '.cm-scroller': {
        overflow: 'auto',
        fontFamily: 'inherit',
        lineHeight: '1.6',
      },
      '.cm-content': {
        padding: '10px 14px',
        caretColor: isDark ? '#38bdf8' : '#0284c7',
      },
      '.cm-gutters': {
        backgroundColor: 'transparent',
        color: 'var(--text-faint, #64748b)',
        borderRight: '1px solid var(--border-line, rgba(255, 255, 255, 0.08))',
        paddingRight: '2px',
        userSelect: 'none',
      },
      '.cm-lineNumbers .cm-gutterElement': {
        minWidth: '28px',
        textAlign: 'right',
        padding: '0 6px 0 4px',
        color: 'inherit',
        opacity: '0.6',
      },
      '.cm-activeLineGutter': {
        color: 'var(--text-primary, #f8fafc)',
        opacity: '1',
        fontWeight: '600',
      },
      '.cm-foldGutter .cm-gutterElement': {
        width: '18px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
      },
      '.cm-fold-marker': {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '14px',
        height: '14px',
        borderRadius: '3px',
        fontSize: '11px',
        fontWeight: '700',
        lineHeight: '1',
        cursor: 'pointer',
        color: 'var(--text-muted, #94a3b8)',
        transition: 'all 0.15s ease',
      },
      '.cm-fold-marker:hover': {
        color: 'var(--text-primary, #f8fafc)',
        backgroundColor: 'var(--border-line, rgba(255, 255, 255, 0.12))',
      },
      '.cm-foldPlaceholder': {
        backgroundColor: isDark ? 'rgba(250, 204, 21, 0.12)' : 'rgba(217, 119, 6, 0.12)',
        border: isDark ? '1px solid rgba(250, 204, 21, 0.35)' : '1px solid rgba(217, 119, 6, 0.35)',
        color: isDark ? '#facc15' : '#b45309',
        borderRadius: '4px',
        padding: '0 6px',
        margin: '0 3px',
        fontSize: '11px',
        fontWeight: '600',
        cursor: 'pointer',
      },
      '.cm-activeLine': {
        backgroundColor: isDark ? 'rgba(255, 255, 255, 0.02)' : 'rgba(0, 0, 0, 0.02)',
      },
      '&.cm-focused .cm-selectionBackground, ::selection': {
        backgroundColor: isDark ? 'rgba(14, 165, 233, 0.25) !important' : 'rgba(2, 132, 199, 0.2) !important',
      },
      '.cm-selectionMatch': {
        backgroundColor: isDark ? 'rgba(14, 165, 233, 0.15)' : 'rgba(2, 132, 199, 0.12)',
      },
    },
    { dark: isDark }
  );

export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(
  (
    {
      value,
      onChange,
      readOnly = false,
      language = 'json',
      placeholder: placeholderText = '',
      height,
      minHeight = '140px',
      maxHeight,
      className = '',
      lineNumbers: showLineNumbers = true,
      foldGutter: showFoldGutter = true,
      historyMode = 'editor',
      onUndo,
      onRedo,
    },
    ref
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);

    // Resolve current theme mode from store (dark vs light)
    const themeMode = useApiStore((state) => state.theme || 'system');
    const isDark = resolveTheme(themeMode) === 'dark';

    // Compartments for dynamic configuration changes
    const readOnlyCompartmentRef = useRef(new Compartment());
    const languageCompartmentRef = useRef(new Compartment());
    const themeCompartmentRef = useRef(new Compartment());
    const highlightCompartmentRef = useRef(new Compartment());

    // Keep latest value and onChange in refs to prevent stale closures
    const valueRef = useRef(value);
    valueRef.current = value;
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const onUndoRef = useRef(onUndo);
    onUndoRef.current = onUndo;
    const onRedoRef = useRef(onRedo);
    onRedoRef.current = onRedo;
    const isDiscreteChangeRef = useRef(false);

    useImperativeHandle(
      ref,
      () => ({
        foldAll: () => {
          if (viewRef.current) {
            foldAll(viewRef.current);
          }
        },
        unfoldAll: () => {
          if (viewRef.current) {
            unfoldAll(viewRef.current);
          }
        },
        focus: () => {
          viewRef.current?.focus();
        },
        getView: () => viewRef.current,
      }),
      []
    );

    // Helper to get language extension
    const getLanguageExtension = (lang: 'json' | 'xml' | 'text') => {
      if (lang === 'json') {
        return [
          json(),
          jsonLanguage.data.of({
            commentTokens: {
              line: '//',
              block: { open: '/*', close: '*/' },
            },
          }),
        ];
      }
      if (lang === 'xml') return xml();
      return [];
    };

    // Initialize CodeMirror instance
    useEffect(() => {
      if (!containerRef.current) return;

      const extensions = [
        themeCompartmentRef.current.of(getCustomAirRestTheme(isDark)),
        EditorView.lineWrapping,
        indentUnit.of('  '),
        readOnlyCompartmentRef.current.of(EditorState.readOnly.of(readOnly)),
        languageCompartmentRef.current.of(getLanguageExtension(language)),
        highlightCompartmentRef.current.of(
          syntaxHighlighting(isDark ? darkHighlightStyle : lightHighlightStyle, { fallback: true })
        ),
      ];

      if (showLineNumbers) {
        extensions.push(lineNumbers());
        extensions.push(highlightActiveLineGutter());
      }

      if (showFoldGutter) {
        extensions.push(
          foldGutter({
            markerDOM(open: boolean) {
              const span = document.createElement('span');
              span.className = `cm-fold-marker ${open ? 'cm-fold-open' : 'cm-fold-closed'}`;
              span.textContent = open ? '−' : '+';
              span.title = open ? 'Collapse block' : 'Expand block';
              return span;
            },
          })
        );
      }

      if (placeholderText) {
        extensions.push(cmPlaceholder(placeholderText));
      }

      if (!readOnly) {
        const keyBindings = [indentWithTab, ...defaultKeymap, ...foldKeymap];
        if (historyMode === 'external') {
          const commentBinding = language === 'json'
            ? [{
                key: 'Mod-/',
                run: (view: EditorView) => {
                  isDiscreteChangeRef.current = true;
                  const changed = toggleComment(view);
                  if (!changed) isDiscreteChangeRef.current = false;
                  return changed;
                },
                preventDefault: true,
                stopPropagation: true,
              }]
            : [];
          extensions.push(
            keymap.of([
              {
                key: 'Mod-z',
                run: () => {
                  onUndoRef.current?.();
                  return true;
                },
                preventDefault: true,
                stopPropagation: true,
              },
              {
                key: 'Mod-Shift-z',
                run: () => {
                  onRedoRef.current?.();
                  return true;
                },
                preventDefault: true,
                stopPropagation: true,
              },
              {
                key: 'Mod-y',
                run: () => {
                  onRedoRef.current?.();
                  return true;
                },
                preventDefault: true,
                stopPropagation: true,
              },
              ...commentBinding,
              ...keyBindings.filter((binding) => !['Mod-z', 'Mod-Shift-z', 'Mod-y'].includes(binding.key || '')),
            ])
          );
        } else {
          extensions.push(history());
          extensions.push(keymap.of([...keyBindings, ...historyKeymap]));
        }
        extensions.push(
          EditorView.updateListener.of((update) => {
            const isExternalValueSync = update.transactions.some((transaction) =>
              transaction.annotation(externalValueSync)
            );
            if (update.docChanged && !isExternalValueSync && onChangeRef.current) {
              const newDoc = update.state.doc.toString();
              const isDiscreteChange = isDiscreteChangeRef.current;
              isDiscreteChangeRef.current = false;
              onChangeRef.current(newDoc, isDiscreteChange);
            }
          })
        );
      } else {
        extensions.push(keymap.of([...defaultKeymap, ...foldKeymap]));
      }

      const state = EditorState.create({
        doc: value,
        extensions,
      });

      const view = new EditorView({
        state,
        parent: containerRef.current,
      });

      viewRef.current = view;

      return () => {
        view.destroy();
        viewRef.current = null;
      };
    }, [showLineNumbers, showFoldGutter, readOnly, historyMode]);

    // Synchronize external value changes (e.g. from Undo / Redo or tab switch)
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const currentDoc = view.state.doc.toString();
      if (currentDoc !== value) {
        view.dispatch({
          changes: { from: 0, to: currentDoc.length, insert: value || '' },
          annotations: [externalValueSync.of(true), Transaction.addToHistory.of(false)],
        });
      }
    }, [value]);

    // Synchronize language changes
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: languageCompartmentRef.current.reconfigure(getLanguageExtension(language)),
      });
    }, [language]);

    // Synchronize theme changes (dark vs light mode syntax highlighting)
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: [
          themeCompartmentRef.current.reconfigure(getCustomAirRestTheme(isDark)),
          highlightCompartmentRef.current.reconfigure(
            syntaxHighlighting(isDark ? darkHighlightStyle : lightHighlightStyle, { fallback: true })
          ),
        ],
      });
    }, [isDark]);

    const styleHeight = typeof height === 'number' ? `${height}px` : height;
    const styleMinHeight = typeof minHeight === 'number' ? `${minHeight}px` : minHeight;
    const styleMaxHeight = typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight;

    return (
      <div
        ref={containerRef}
        style={{
          height: styleHeight,
          minHeight: styleMinHeight,
          maxHeight: styleMaxHeight,
        }}
        className={`w-full overflow-hidden rounded-xl border border-line bg-card font-mono text-xs text-tx-primary ${
          readOnly ? '' : 'focus-within:border-sky-500 focus-within:ring-1 focus-within:ring-sky-500'
        } transition ${className}`}
      />
    );
  }
);

CodeEditor.displayName = 'CodeEditor';
