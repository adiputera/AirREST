/// <reference lib="webworker" />
import { runQuickJsGuest } from './quickjsRunner';
import type { ScriptWorkerRequest, ScriptWorkerResponse } from '@airrest/common/protocol';

self.onmessage = async (e: MessageEvent<ScriptWorkerRequest>) => {
  const req = e.data;
  if (!req || req.type !== 'EXECUTE') return;

  try {
    const result = await runQuickJsGuest(req.input, {
      timeoutMs: req.timeoutMs,
      onEvalStart: () => {
        self.postMessage({ id: req.id, type: 'EVAL_START' } satisfies ScriptWorkerResponse);
      },
    });
    const resp: ScriptWorkerResponse = {
      id: req.id,
      type: 'RESULT',
      result,
    };
    self.postMessage(resp);
  } catch (err: unknown) {
    const resp: ScriptWorkerResponse = {
      id: req.id,
      type: 'RESULT',
      result: {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        environment: { ...(req.input.environment || {}) },
        variables: { ...(req.input.variables || {}) },
      },
    };
    self.postMessage(resp);
  }
};
