import type { FunctionalCapturedExchange } from '../types/api';
import { registerFunctionalSessionCleanup } from './examples';

export const MAX_FUNCTIONAL_CAPTURED_STEPS = 500;
export const MAX_FUNCTIONAL_BODY_BYTES = 128 * 1024; // 128 KiB per request or response body
export const MAX_FUNCTIONAL_SESSION_BYTES = 16 * 1024 * 1024; // 16 MiB total budget per run

interface RunCaptureBucket {
  tabId: string;
  totalBytes: number;
  capturedCount: number;
  exchanges: Map<string, FunctionalCapturedExchange>;
}

interface RunEnvSnapshotEntry {
  tabId: string;
  env: Record<string, string>;
}

const sessionCaptures = new Map<string, RunCaptureBucket>();
const sessionEnvSnapshots = new Map<string, RunEnvSnapshotEntry>();

function utf8ByteLength(str: string): number {
  return new TextEncoder().encode(str).length;
}

function truncateToUtf8ByteLimit(
  value: string,
  maxBytes: number
): { text: string; truncated: boolean; bytes: number } {
  const totalBytes = utf8ByteLength(value);
  if (totalBytes <= maxBytes) {
    return { text: value, truncated: false, bytes: totalBytes };
  }
  const suffix = '\n... (truncated at 128 KiB session capture limit)';
  const suffixBytes = utf8ByteLength(suffix);
  const target = Math.max(0, maxBytes - suffixBytes);
  const encoder = new TextEncoder();
  const encoded = encoder.encode(value).slice(0, target);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(encoded) + suffix;
  return { text, truncated: true, bytes: utf8ByteLength(text) };
}

export interface CaptureExchangeResult {
  captured: boolean;
  reason?: 'step_limit' | 'memory_budget';
}

export function captureFunctionalExchange(
  runId: string,
  tabId: string,
  stepId: string,
  exchange: FunctionalCapturedExchange
): CaptureExchangeResult {
  let bucket = sessionCaptures.get(runId);
  if (!bucket) {
    bucket = {
      tabId,
      totalBytes: 0,
      capturedCount: 0,
      exchanges: new Map(),
    };
    sessionCaptures.set(runId, bucket);
  }

  if (bucket.capturedCount >= MAX_FUNCTIONAL_CAPTURED_STEPS) {
    return { captured: false, reason: 'step_limit' };
  }

  const reqBodyRes =
    typeof exchange.requestBody === 'string' && exchange.requestBody.length > 0
      ? truncateToUtf8ByteLimit(exchange.requestBody, MAX_FUNCTIONAL_BODY_BYTES)
      : null;
  const respBodyRes = truncateToUtf8ByteLimit(exchange.responseBody || '', MAX_FUNCTIONAL_BODY_BYTES);

  const overheadBytes =
    utf8ByteLength(JSON.stringify(exchange.requestHeaders || {})) +
    utf8ByteLength(JSON.stringify(exchange.responseHeaders || {})) +
    (exchange.dataRow ? utf8ByteLength(JSON.stringify(exchange.dataRow)) : 0) +
    utf8ByteLength(exchange.requestUrl || '');

  const entryBytes = (reqBodyRes?.bytes ?? 0) + respBodyRes.bytes + overheadBytes;

  if (bucket.totalBytes + entryBytes > MAX_FUNCTIONAL_SESSION_BYTES) {
    return { captured: false, reason: 'memory_budget' };
  }

  bucket.exchanges.set(stepId, {
    requestMethod: exchange.requestMethod,
    requestUrl: exchange.requestUrl,
    requestHeaders: { ...exchange.requestHeaders },
    ...(reqBodyRes ? { requestBody: reqBodyRes.text, requestBodyTruncated: reqBodyRes.truncated } : {}),
    responseHeaders: { ...exchange.responseHeaders },
    responseBody: respBodyRes.text,
    responseBodyTruncated: respBodyRes.truncated,
    ...(exchange.dataRow ? { dataRow: { ...exchange.dataRow } } : {}),
  });
  bucket.capturedCount += 1;
  bucket.totalBytes += entryBytes;

  return { captured: true };
}

export function getFunctionalCapturedExchange(
  runId: string,
  stepId: string
): FunctionalCapturedExchange | undefined {
  return sessionCaptures.get(runId)?.exchanges.get(stepId);
}

export function getFunctionalSessionStats(runId: string): {
  capturedCount: number;
  totalBytes: number;
} {
  const bucket = sessionCaptures.get(runId);
  return {
    capturedCount: bucket?.capturedCount ?? 0,
    totalBytes: bucket?.totalBytes ?? 0,
  };
}

export function saveFunctionalRunEnvSnapshot(
  runId: string,
  tabId: string,
  env: Record<string, string>
): void {
  if (!runId) return;
  sessionEnvSnapshots.set(runId, { tabId, env: { ...env } });
}

export function getFunctionalRunEnvSnapshot(runId: string): Record<string, string> | undefined {
  const entry = sessionEnvSnapshots.get(runId);
  return entry ? { ...entry.env } : undefined;
}

export function clearFunctionalSessionForTab(tabId: string): void {
  for (const [runId, bucket] of sessionCaptures.entries()) {
    if (bucket.tabId === tabId) {
      sessionCaptures.delete(runId);
    }
  }
  for (const [runId, entry] of sessionEnvSnapshots.entries()) {
    if (entry.tabId === tabId) {
      sessionEnvSnapshots.delete(runId);
    }
  }
}

export function clearAllFunctionalSessions(): void {
  sessionCaptures.clear();
  sessionEnvSnapshots.clear();
}

registerFunctionalSessionCleanup((tabId?: string) => {
  if (tabId) clearFunctionalSessionForTab(tabId);
  else clearAllFunctionalSessions();
});
