import { useEffect, useRef } from 'react';

type BackHandler = { handler: () => void; priority: number };
const handlers: BackHandler[] = [];

/** Register an overlay until it closes; higher priority overlays handle Back first. */
export function registerBackHandler(handler: () => void, priority = 0): () => void {
  const entry = { handler, priority };
  handlers.push(entry);
  return () => {
    const index = handlers.indexOf(entry);
    if (index !== -1) handlers.splice(index, 1);
  };
}

/** Returns true when an overlay consumed the event, including a busy overlay. */
export function dispatchBack(): boolean {
  let selected: BackHandler | undefined;
  for (const entry of handlers) {
    if (!selected || entry.priority >= selected.priority) selected = entry;
  }
  if (!selected) return false;
  selected.handler();
  return true;
}

export function useBackHandler(active: boolean, handler: () => void, priority = 0): void {
  const current = useRef(handler);
  current.current = handler;
  useEffect(() => {
    if (!active) return;
    return registerBackHandler(() => current.current(), priority);
  }, [active, priority]);
}
