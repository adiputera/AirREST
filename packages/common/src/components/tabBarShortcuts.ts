export interface CloseTabShortcutEventLike {
  key?: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  getModifierState?: (keyArg: string) => boolean;
}

export interface CloseTabShortcutOptions {
  isDesktop: boolean;
  isMac: boolean;
}

export interface RequestShortcutLabels {
  send: string;
  save: string;
  undo: string;
  redo: string;
  paste: string;
}

const BLOCKING_MODAL_SELECTOR =
  '[data-modal="true"], [role="dialog"], [data-payload-modal="true"], .fixed.inset-0[class*="z-50"]:not([data-non-blocking-overlay="true"]), .fixed.inset-0[class*="z-[60]"]:not([data-non-blocking-overlay="true"]), .fixed.inset-0[class*="z-[70]"]:not([data-non-blocking-overlay="true"])';

/**
 * Detects whether the current environment runs on an Apple OS (macOS, iOS, iPadOS).
 *
 * @returns True on Apple platforms, otherwise false.
 */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || navigator.platform || '';
  return /Mac|iPod|iPhone|iPad/i.test(platform);
}

/**
 * Checks whether a keyboard event matches the close-active-tab shortcut.
 * Supports Alt+W on all platforms and Ctrl+W / Cmd+W on native desktop.
 *
 * @param event Keyboard event fields to evaluate.
 * @param options Runtime platform flags.
 * @returns True when the shortcut should close the active request tab.
 */
export function isCloseActiveTabShortcut(
  event: CloseTabShortcutEventLike,
  options: CloseTabShortcutOptions,
): boolean {
  if (event.defaultPrevented || event.repeat) return false;
  if (event.getModifierState?.('AltGraph')) return false;

  const key = (event.key || '').toLowerCase();
  const isWKey = key === 'w' || (options.isMac && Boolean(event.altKey) && key === '∑');
  if (!isWKey) return false;

  const isAltClose =
    Boolean(event.altKey) &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey;
  if (isAltClose) return true;

  if (!options.isDesktop) return false;

  if (options.isMac) {
    return Boolean(event.metaKey) && !event.ctrlKey && !event.altKey && !event.shiftKey;
  }

  return Boolean(event.ctrlKey) && !event.metaKey && !event.altKey && !event.shiftKey;
}

/**
 * Formats the display shortcut label for closing the active request tab.
 *
 * @param options Runtime platform flags.
 * @returns Human-readable shortcut hint string.
 */
export function getCloseTabShortcutLabel(options: CloseTabShortcutOptions): string {
  const altLabel = options.isMac ? 'Option+W' : 'Alt+W';
  if (!options.isDesktop) return altLabel;
  return options.isMac ? `⌘+W / ${altLabel}` : `Ctrl+W / ${altLabel}`;
}

/**
 * Formats platform-appropriate keyboard shortcut labels for request studio actions.
 *
 * @param isMac Whether the current platform uses Apple Command modifier conventions.
 * @returns Display shortcut labels for send, save, undo, redo, and paste.
 */
export function getRequestShortcutLabels(isMac: boolean = isApplePlatform()): RequestShortcutLabels {
  return {
    send: isMac ? '⌘+Enter' : 'Ctrl+Enter',
    save: isMac ? '⌘+S' : 'Ctrl+S',
    undo: isMac ? '⌘+Z' : 'Ctrl+Z',
    redo: isMac ? '⌘+Shift+Z' : 'Ctrl+Y',
    paste: isMac ? '⌘+V' : 'Ctrl+V',
  };
}

/**
 * Returns true if a modal dialog or workspace-blocking overlay is currently mounted.
 *
 * @returns True when a blocking modal element exists in the document.
 */
export function hasOpenBlockingModal(): boolean {
  if (typeof document === 'undefined') return false;
  return Boolean(document.querySelector(BLOCKING_MODAL_SELECTOR));
}
