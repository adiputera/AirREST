import React from 'react';

interface EditorKeyDownOptions {
  indent?: string;
  onChange?: (value: string) => void;
}

/**
 * Handles Tab and Shift+Tab keydown events for code and text editors (JSON, XML, GraphQL, JavaScript, etc.).
 *
 * Behaviors:
 * - Tab (no selection): Inserts 2 spaces indentation at the cursor position and preserves undo history.
 * - Tab (multi-line selection): Indents all selected lines by 2 spaces.
 * - Shift + Tab: Outdents the current line or all selected lines by up to 2 spaces (or 1 tab).
 * - Escape: Blurs the textarea to allow accessible keyboard navigation away from the editor.
 * - Ctrl/Cmd/Alt + Tab: Ignored so standard browser and OS tab-switching shortcuts remain functional.
 */
export function handleCodeEditorKeyDown(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  options: EditorKeyDownOptions = {}
): void {
  const { indent = '  ', onChange } = options;

  // Escape key blurs the textarea for accessibility navigation
  if (e.key === 'Escape') {
    e.currentTarget.blur();
    return;
  }

  // Only handle the Tab key
  if (e.key !== 'Tab') return;

  // Never intercept browser or operating system tab switching shortcuts
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  e.preventDefault();

  const textarea = e.currentTarget;
  const { selectionStart, selectionEnd, value } = textarea;

  const hasLineBreaksInSelection =
    selectionStart !== selectionEnd && value.slice(selectionStart, selectionEnd).includes('\n');

  // Single cursor (or collapsed selection) Tab without Shift:
  // Prefer native execCommand to integrate cleanly with browser native Undo / Redo stack (Ctrl+Z)
  if (!e.shiftKey && selectionStart === selectionEnd) {
    try {
      if (typeof document !== 'undefined' && document.queryCommandSupported?.('insertText')) {
        const success = document.execCommand('insertText', false, indent);
        if (success) {
          if (onChange && textarea.value !== value) {
            onChange(textarea.value);
          }
          return;
        }
      }
    } catch {
      // Fallback to programmatic update
    }
  }

  // Single-line text replacement with Tab
  if (!e.shiftKey && !hasLineBreaksInSelection && selectionStart !== selectionEnd) {
    try {
      if (typeof document !== 'undefined' && document.queryCommandSupported?.('insertText')) {
        const success = document.execCommand('insertText', false, indent);
        if (success) {
          if (onChange && textarea.value !== value) {
            onChange(textarea.value);
          }
          return;
        }
      }
    } catch {
      // Fallback to programmatic update
    }
  }

  // Single cursor without Shift when execCommand is unavailable
  if (!e.shiftKey && selectionStart === selectionEnd) {
    const before = value.substring(0, selectionStart);
    const after = value.substring(selectionEnd);
    const newValue = before + indent + after;
    const newPos = selectionStart + indent.length;
    applyTextareaChange(textarea, newValue, newPos, newPos, onChange);
    return;
  }

  // Multi-line selection Indent or Shift+Tab Outdent
  const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
  let lineEnd = value.indexOf('\n', selectionEnd);
  if (lineEnd === -1) lineEnd = value.length;

  const textBefore = value.substring(0, lineStart);
  const textBetween = value.substring(lineStart, lineEnd);
  const textAfter = value.substring(lineEnd);

  const lines = textBetween.split('\n');

  if (e.shiftKey) {
    // Outdent: remove up to indent.length spaces or 1 tab from each touched line
    let firstLineDiff = 0;
    let totalDiff = 0;

    const modifiedLines = lines.map((line, idx) => {
      let trimmed = line;
      let diff = 0;
      if (line.startsWith(indent)) {
        trimmed = line.substring(indent.length);
        diff = indent.length;
      } else if (line.startsWith(' ')) {
        trimmed = line.substring(1);
        diff = 1;
      } else if (line.startsWith('\t')) {
        trimmed = line.substring(1);
        diff = 1;
      }

      if (idx === 0) firstLineDiff = diff;
      totalDiff += diff;
      return trimmed;
    });

    const newBetween = modifiedLines.join('\n');
    const newValue = textBefore + newBetween + textAfter;

    // Adjust selection boundaries so the selection stays aligned with the modified text
    const newStart = Math.max(lineStart, selectionStart - firstLineDiff);
    const newEnd = Math.max(newStart, selectionEnd - totalDiff);

    applyTextareaChange(textarea, newValue, newStart, newEnd, onChange);
  } else {
    // Indent: add indent to each touched line
    const modifiedLines = lines.map((line) => indent + line);
    const newBetween = modifiedLines.join('\n');
    const newValue = textBefore + newBetween + textAfter;

    const firstLineDiff = indent.length;
    const totalDiff = lines.length * indent.length;

    const newStart = selectionStart + firstLineDiff;
    const newEnd = selectionEnd + totalDiff;

    applyTextareaChange(textarea, newValue, newStart, newEnd, onChange);
  }
}

function applyTextareaChange(
  textarea: HTMLTextAreaElement,
  newValue: string,
  newStart: number,
  newEnd: number,
  onChange?: (value: string) => void
): void {
  // Use HTMLTextAreaElement prototype setter to keep React's value tracker in sync
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  )?.set;

  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(textarea, newValue);
  } else {
    textarea.value = newValue;
  }

  // Dispatch standard input event so React synthetic onChange listeners trigger
  textarea.dispatchEvent(new Event('input', { bubbles: true }));

  // Call explicit callback if provided
  onChange?.(newValue);

  // Restore cursor and selection immediately and on next frame (after React re-render)
  textarea.selectionStart = newStart;
  textarea.selectionEnd = newEnd;

  if (typeof requestAnimationFrame !== 'undefined') {
    requestAnimationFrame(() => {
      textarea.selectionStart = newStart;
      textarea.selectionEnd = newEnd;
    });
  }
}
