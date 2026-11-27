import type {
  ApiRequest,
  ApiResponse,
  HttpMethod,
  LoadProfileConfig,
  PerformanceDataFileMeta,
  PerformanceDataFileReadMode,
  PerformanceEndpointBreakdown,
  PerformanceEngineMode,
  PerformanceErrorGroup,
  PerformanceErrorSample,
  PerformanceExecutionMode,
  PerformanceMetricSnapshot,
  PerformanceNetworkOptions,
  PerformanceRequestBucketMetrics,
  PerformanceRequestDescriptor,
  PerformanceRunReport,
  PerformanceSetupRefreshConfig,
  PerformanceSetupRefreshStats,
  PerformanceSetupStepResult,
  PerformanceThresholdConfig,
  PerformanceTimeBucket,
} from '../types/api';
import type {
  NativePerformanceAttachmentPayload,
  NativePerformanceRequestItem,
  PlatformAdapter,
  ScriptExecutor,
  ScriptRequest,
} from '../types/platform';
import {
  getActiveFunctionalRunState,
  getActivePerformanceRun,
  setActivePerformanceRunController,
  stopActivePerformanceRun,
} from './examples';
import {
  categorizeNetworkError,
  getChromiumNetworkError,
  getDefaultPlatformAdapter,
  interpolateVariables,
  prepareRequest,
  RESPONSE_SIZE_LIMIT_BYTES,
  ResponseTooLargeError,
} from './fetcher';
import {
  clampPerformanceTimeoutMs,
  getDurationSeconds,
  getPlatformPerformanceLimits,
  getTargetVusAtTime,
} from './loadProfileMath';
import { selectDataRowIndex } from './perfDataFile';
import { PerfHistogram } from './perfHistogram';
import { createAutoStopTracker, evaluatePerformanceThresholds } from './perfThresholds';
import { executePostResponseScript, executePreRequestScript } from './scriptRunner';

const MAX_ERROR_SAMPLES = 50;
const MAX_ERROR_SNIPPET_BYTES = 4096;
const MAX_NATIVE_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MiB per attachment for native preload

export { getActivePerformanceRun, stopActivePerformanceRun };

function makeRunId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `perf_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function toScriptRequest(req: ApiRequest): ScriptRequest {
  return {
    url: req.url,
    method: req.method,
    headers: (req.headers || []).map((h) => ({ key: h.key, value: h.value, enabled: h.enabled })),
    params: (req.params || []).map((p) => ({ key: p.key, value: p.value, enabled: p.enabled })),
    body: {
      mode: req.bodyType,
      raw: req.bodyContent,
      urlencoded: (req.bodyUrlEncoded || []).map((u) => ({ key: u.key, value: u.value, enabled: u.enabled })),
      formdata: (req.bodyFormData || []).map((f) => ({ key: f.key, value: f.value, enabled: f.enabled })),
    },
  };
}

export function applyScriptMutatedRequest(
  req: ApiRequest,
  mutated?: {
    url?: string;
    queryParams?: Array<{ key: string; value: string }>;
    headers?: Array<{ key: string; value: string }>;
  }
): ApiRequest {
  if (!mutated) return req;
  return {
    ...req,
    url: mutated.url ?? req.url,
    params: mutated.queryParams
      ? mutated.queryParams.map((p, idx) => ({ id: `mut_p_${idx}`, key: p.key, value: p.value, enabled: true }))
      : req.params,
    headers: mutated.headers
      ? mutated.headers.map((h, idx) => ({ id: `mut_h_${idx}`, key: h.key, value: h.value, enabled: true }))
      : req.headers,
  };
}

async function readAndDiscardOrSample(
  response: Response,
  controller: AbortController,
  options: { method: string; needTextBody: boolean; isErrorResponse: boolean }
): Promise<{ sizeBytes: number; textData: string; errorSnippet?: string }> {
  const isBodyless =
    options.method.toUpperCase() === 'HEAD' ||
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304;

  if (isBodyless) {
    if (response.body) {
      try {
        await response.body.cancel();
      } catch {
        // ignore cancel failure
      }
    }
    return { sizeBytes: 0, textData: '' };
  }

  const declaredSize = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(declaredSize) && declaredSize > RESPONSE_SIZE_LIMIT_BYTES) {
    controller.abort();
    if (response.body) {
      try {
        await response.body.cancel();
      } catch {
        // ignore cancel failure
      }
    }
    throw new ResponseTooLargeError();
  }

  if (!response.body) {
    return { sizeBytes: 0, textData: '' };
  }

  const reader = response.body.getReader();
  let totalBytes = 0;
  const maxRetainBytes = options.needTextBody
    ? 2 * 1024 * 1024
    : options.isErrorResponse
      ? MAX_ERROR_SNIPPET_BYTES
      : 0;
  const retainedChunks: Uint8Array[] = [];
  let retainedTotal = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (totalBytes + value.byteLength > RESPONSE_SIZE_LIMIT_BYTES) {
        controller.abort();
        try {
          await reader.cancel();
        } catch {
          // ignore secondary cancel failure
        }
        throw new ResponseTooLargeError();
      }
      totalBytes += value.byteLength;
      if (maxRetainBytes > 0 && retainedTotal < maxRetainBytes) {
        const remaining = maxRetainBytes - retainedTotal;
        const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
        retainedChunks.push(slice);
        retainedTotal += slice.byteLength;
      }
    }
  } catch (err) {
    controller.abort();
    throw err;
  } finally {
    reader.releaseLock();
  }

  if (retainedTotal === 0) {
    return { sizeBytes: totalBytes, textData: '' };
  }

  const merged = new Uint8Array(retainedTotal);
  let offset = 0;
  for (const chunk of retainedChunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(merged);
  return {
    sizeBytes: totalBytes,
    textData: options.needTextBody ? decoded : '',
    errorSnippet: options.isErrorResponse ? decoded : undefined,
  };
}

export interface SingleHttpExecutionResult {
  status: number;
  statusText: string;
  timeMs: number;
  sizeBytes: number;
  headers: Record<string, string>;
  data: string;
  isError: boolean;
  isWarning?: boolean;
  errorCategory: string;
  errorMessage: string;
  errorSnippet?: string;
  finalUrl: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
}

function summarizePreparedBodyForCapture(body: BodyInit | undefined): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return body.toString();
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const entries: string[] = [];
    body.forEach((v, k) => {
      if (typeof v === 'string') {
        entries.push(`${k}=${v}`);
      } else {
        entries.push(`${k}=[File: ${(v as File).name || 'blob'} (${(v as File).size ?? 0} bytes)]`);
      }
    });
    return entries.join('\n');
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return `[Binary Blob: ${body.size} bytes${body.type ? `, ${body.type}` : ''}]`;
  }
  return '[Binary / Stream Body]';
}

export async function executePerfHttpStep(
  request: ApiRequest,
  variables: Record<string, string>,
  signal: AbortSignal,
  adapter: PlatformAdapter | undefined,
  network: PerformanceNetworkOptions,
  needTextBody: boolean,
  capturePrepared = false
): Promise<SingleHttpExecutionResult> {
  const startTime = performance.now();
  let finalUrl = request.url || '';
  let capturedHeaders: Record<string, string> | undefined;
  let capturedBody: string | undefined;
  const controller = new AbortController();
  let timedOut = false;

  const onParentAbort = () => controller.abort();
  if (signal.aborted) controller.abort();
  signal.addEventListener('abort', onParentAbort, { once: true });

  const timeoutMs = Math.max(500, Math.min(300_000, network.requestTimeoutMs || 60_000));
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const prepared = prepareRequest(request, variables);
    finalUrl = prepared.finalUrl;
    if (capturePrepared) {
      capturedHeaders = { ...prepared.finalHeaders };
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        capturedBody = summarizePreparedBodyForCapture(prepared.finalBody);
      }
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(finalUrl);
    } catch {
      return {
        status: 0,
        statusText: 'Invalid URL',
        timeMs: Math.round(performance.now() - startTime),
        sizeBytes: 0,
        headers: {},
        data: '',
        isError: true,
        errorCategory: 'invalid_url',
        errorMessage: `Invalid URL "${finalUrl}"`,
        finalUrl,
      };
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return {
        status: 0,
        statusText: 'Unsupported Protocol',
        timeMs: Math.round(performance.now() - startTime),
        sizeBytes: 0,
        headers: {},
        data: '',
        isError: true,
        errorCategory: 'other',
        errorMessage: `Protocol "${parsedUrl.protocol}" is not supported.`,
        finalUrl,
      };
    }

    const transportInit = {
      method: request.method,
      headers: prepared.finalHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? prepared.finalBody : undefined,
      signal: controller.signal,
    };

    const transportOptions = {
      followRedirects: network.followRedirects,
      ignoreSslErrors: network.ignoreSslErrors,
    };

    const response = adapter
      ? await adapter.transport.fetch(finalUrl, transportInit, transportOptions)
      : await fetch(finalUrl, {
        ...transportInit,
        redirect: network.followRedirects === false ? 'manual' : 'follow',
        cache: 'no-store',
      });

    const isRedirectWarning =
      network.followRedirects === false && response.status >= 300 && response.status < 400;
    const isHttpError = !response.ok && !isRedirectWarning;
    const { sizeBytes, textData, errorSnippet } = await readAndDiscardOrSample(response, controller, {
      method: request.method,
      needTextBody: needTextBody || false,
      isErrorResponse: isHttpError,
    });
    const timeMs = Math.max(0, Math.round(performance.now() - startTime));

    const headers: Record<string, string> = {};
    if (needTextBody) {
      response.headers.forEach((v, k) => {
        headers[k] = v;
      });
    }

    return {
      status: response.status,
      statusText: response.statusText || (response.ok ? 'OK' : `HTTP ${response.status}`),
      timeMs,
      sizeBytes,
      headers,
      data: textData,
      isError: isHttpError,
      isWarning: isRedirectWarning,
      errorCategory: isHttpError ? `http_${Math.floor(response.status / 100)}xx` : '',
      errorMessage: isHttpError ? `HTTP ${response.status} ${response.statusText || ''}`.trim() : '',
      errorSnippet: isHttpError ? errorSnippet : undefined,
      finalUrl,
      ...(capturePrepared ? { requestHeaders: capturedHeaders, requestBody: capturedBody } : {}),
    };
  } catch (err: unknown) {
    const timeMs = Math.max(0, Math.round(performance.now() - startTime));
    const preparedExtra = capturePrepared
      ? { requestHeaders: capturedHeaders, requestBody: capturedBody }
      : {};
    if (err instanceof ResponseTooLargeError) {
      return {
        status: 0,
        statusText: 'Response Too Large',
        timeMs,
        sizeBytes: 0,
        headers: {},
        data: '',
        isError: true,
        errorCategory: 'response_size_limit',
        errorMessage: err.message,
        finalUrl,
        ...preparedExtra,
      };
    }
    if (controller.signal.aborted) {
      return {
        status: 0,
        statusText: timedOut ? 'Timed Out' : 'Cancelled',
        timeMs,
        sizeBytes: 0,
        headers: {},
        data: '',
        isError: true,
        errorCategory: timedOut ? 'timeout' : 'cancelled',
        errorMessage: timedOut ? `Request timed out after ${timeoutMs} ms` : 'Request cancelled',
        finalUrl,
        ...preparedExtra,
      };
    }

    if (adapter) {
      const classified = await adapter.transport.classifyError(err, finalUrl);
      return {
        status: 0,
        statusText: `Network Error (${classified.category})`,
        timeMs,
        sizeBytes: 0,
        headers: {},
        data: '',
        isError: true,
        errorCategory: classified.category,
        errorMessage: classified.detail,
        finalUrl,
        ...preparedExtra,
      };
    }

    const netCode = await getChromiumNetworkError(finalUrl);
    const category = categorizeNetworkError(netCode);
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 0,
      statusText: netCode ? `Network Error (${netCode})` : 'Network Error',
      timeMs,
      sizeBytes: 0,
      headers: {},
      data: '',
      isError: true,
      errorCategory: category,
      errorMessage: netCode || msg,
      finalUrl,
      ...preparedExtra,
    };
  } finally {
    clearTimeout(timeoutId);
    signal.removeEventListener('abort', onParentAbort);
  }
}

export interface ExecutePreRunSetupResult {
  success: boolean;
  variables: Record<string, string>;
  setupResults: PerformanceSetupStepResult[];
  error?: string;
}

/**
 * Executes 1+ pre-run setup requests sequentially before load begins.
 * Fails fast on any network, HTTP >= 400, or script error.
 * Variables updated during setup are stored ONLY in the returned run-local map.
 */
export async function executePreRunSetup(
  setupItems: PerformanceRequestDescriptor[],
  initialVariables: Record<string, string>,
  options: {
    signal: AbortSignal;
    adapter?: PlatformAdapter;
    scriptExecutor?: ScriptExecutor;
    network: PerformanceNetworkOptions;
  }
): Promise<ExecutePreRunSetupResult> {
  let envVars: Record<string, string> = { ...initialVariables };
  let localVars: Record<string, string> = {};
  const setupResults: PerformanceSetupStepResult[] = [];

  for (const item of setupItems) {
    if (options.signal.aborted) {
      return {
        success: false,
        variables: envVars,
        setupResults,
        error: 'Performance test cancelled during Pre-run Setup.',
      };
    }

    let reqToRun = item.request;
    const preScript = reqToRun.preRequestScript || '';
    const postScript = reqToRun.postResponseScript || '';
    const beforeKeys = { ...envVars };

    if (preScript.trim()) {
      const preRes = await executePreRequestScript(preScript, envVars, localVars, {
        signal: options.signal,
        scriptExecutor: options.scriptExecutor,
        request: toScriptRequest(reqToRun),
      });
      envVars = { ...preRes.environment };
      localVars = { ...preRes.variables };
      if (!preRes.success) {
        setupResults.push({
          requestId: item.id,
          name: item.name,
          method: item.request.method,
          url: item.request.url,
          status: 0,
          timeMs: 0,
          success: false,
          error: `Pre-request script failed: ${preRes.error || 'Unknown script error'}`,
          updatedVariables: [],
        });
        return {
          success: false,
          variables: envVars,
          setupResults,
          error: `Pre-run setup "${item.name}" failed in pre-request script: ${preRes.error || 'Unknown error'}`,
        };
      }
      reqToRun = applyScriptMutatedRequest(reqToRun, preRes.mutatedRequest);
    }

    const mergedVars = { ...envVars, ...localVars };
    const httpRes = await executePerfHttpStep(
      reqToRun,
      mergedVars,
      options.signal,
      options.adapter,
      options.network,
      Boolean(postScript.trim())
    );

    if (httpRes.isError) {
      setupResults.push({
        requestId: item.id,
        name: item.name,
        method: item.request.method,
        url: httpRes.finalUrl,
        status: httpRes.status,
        timeMs: httpRes.timeMs,
        success: false,
        error: httpRes.errorMessage || httpRes.statusText,
        updatedVariables: [],
      });
      return {
        success: false,
        variables: envVars,
        setupResults,
        error: `Pre-run setup "${item.name}" failed (${httpRes.errorMessage || httpRes.statusText}).`,
      };
    }

    if (postScript.trim()) {
      const apiResp: ApiResponse = {
        status: httpRes.status,
        statusText: httpRes.statusText,
        timeMs: httpRes.timeMs,
        sizeBytes: httpRes.sizeBytes,
        headers: httpRes.headers,
        data: httpRes.data,
        timestamp: Date.now(),
      };
      const postRes = await executePostResponseScript(postScript, apiResp, envVars, localVars, {
        signal: options.signal,
        scriptExecutor: options.scriptExecutor,
        request: toScriptRequest(reqToRun),
      });
      envVars = { ...postRes.environment };
      localVars = { ...postRes.variables };
      if (!postRes.success) {
        setupResults.push({
          requestId: item.id,
          name: item.name,
          method: item.request.method,
          url: httpRes.finalUrl,
          status: httpRes.status,
          timeMs: httpRes.timeMs,
          success: false,
          error: `Post-response script failed: ${postRes.error || 'Unknown script error'}`,
          updatedVariables: [],
        });
        return {
          success: false,
          variables: envVars,
          setupResults,
          error: `Pre-run setup "${item.name}" failed in post-response script: ${postRes.error || 'Unknown error'}`,
        };
      }
    }

    // Track which variables were created or modified by this setup step
    const updatedKeys: string[] = [];
    for (const [k, v] of Object.entries(envVars)) {
      if (beforeKeys[k] !== v) updatedKeys.push(k);
    }
    for (const k of Object.keys(localVars)) {
      envVars[k] = localVars[k];
      if (!updatedKeys.includes(k)) updatedKeys.push(k);
    }

    setupResults.push({
      requestId: item.id,
      name: item.name,
      method: item.request.method,
      url: httpRes.finalUrl,
      status: httpRes.status,
      timeMs: httpRes.timeMs,
      success: true,
      updatedVariables: updatedKeys,
    });
  }

  return {
    success: true,
    variables: { ...envVars, ...localVars },
    setupResults,
  };
}

class EndpointAccumulator {
  readonly requestId: string;
  readonly name: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly hist = new PerfHistogram();
  totalRequests = 0;
  errorCount = 0;
  warningCount = 0;
  bytesReceived = 0;

  constructor(item: PerformanceRequestDescriptor) {
    this.requestId = item.id;
    this.name = item.name;
    this.method = item.request.method;
    this.path = item.path;
  }

  record(timeMs: number, bytes: number, isError: boolean, isWarning = false): void {
    this.totalRequests += 1;
    if (isError) this.errorCount += 1;
    if (isWarning) this.warningCount += 1;
    this.bytesReceived += bytes;
    this.hist.record(timeMs);
  }

  toBreakdown(elapsedSec: number): PerformanceEndpointBreakdown {
    const h = this.hist.getSummary();
    const safeSec = Math.max(0.001, elapsedSec);
    return {
      requestId: this.requestId,
      name: this.name,
      method: this.method,
      path: this.path,
      totalRequests: this.totalRequests,
      errorCount: this.errorCount,
      warningCount: this.warningCount,
      errorRatePct: this.totalRequests > 0 ? Number(((this.errorCount / this.totalRequests) * 100).toFixed(2)) : 0,
      requestsPerSec: Number((this.totalRequests / safeSec).toFixed(2)),
      avgMs: h.avgMs,
      minMs: h.minMs,
      maxMs: h.maxMs,
      p90Ms: h.p90Ms,
      p95Ms: h.p95Ms,
      p99Ms: h.p99Ms,
      bytesReceived: this.bytesReceived,
    };
  }
}

class SecondBucketAccumulator {
  readonly second: number;
  readonly timestampMs: number;
  virtualUsers = 0;
  readonly hist = new PerfHistogram();
  totalRequests = 0;
  errorCount = 0;
  readonly byRequest = new Map<
    string,
    { hist: PerfHistogram; totalRequests: number; errorCount: number }
  >();

  constructor(second: number, timestampMs: number) {
    this.second = second;
    this.timestampMs = timestampMs;
  }

  record(requestId: string, timeMs: number, isError: boolean): void {
    this.totalRequests += 1;
    if (isError) this.errorCount += 1;
    this.hist.record(timeMs);

    let reqAcc = this.byRequest.get(requestId);
    if (!reqAcc) {
      reqAcc = { hist: new PerfHistogram(), totalRequests: 0, errorCount: 0 };
      this.byRequest.set(requestId, reqAcc);
    }
    reqAcc.totalRequests += 1;
    if (isError) reqAcc.errorCount += 1;
    reqAcc.hist.record(timeMs);
  }

  toBucket(): PerformanceTimeBucket {
    const h = this.hist.getSummary();
    const byReqOut: Record<string, PerformanceRequestBucketMetrics> = {};
    for (const [reqId, acc] of this.byRequest.entries()) {
      const rh = acc.hist.getSummary();
      byReqOut[reqId] = {
        totalRequests: acc.totalRequests,
        errorCount: acc.errorCount,
        errorRatePct: acc.totalRequests > 0 ? Number(((acc.errorCount / acc.totalRequests) * 100).toFixed(2)) : 0,
        requestsPerSec: acc.totalRequests,
        avgMs: rh.avgMs,
        minMs: rh.minMs,
        maxMs: rh.maxMs,
        p90Ms: rh.p90Ms,
        p95Ms: rh.p95Ms,
        p99Ms: rh.p99Ms,
      };
    }

    return {
      second: this.second,
      timestampMs: this.timestampMs,
      virtualUsers: this.virtualUsers,
      totalRequests: this.totalRequests,
      errorCount: this.errorCount,
      errorRatePct: this.totalRequests > 0 ? Number(((this.errorCount / this.totalRequests) * 100).toFixed(2)) : 0,
      requestsPerSec: this.totalRequests,
      avgMs: h.avgMs,
      minMs: h.minMs,
      maxMs: h.maxMs,
      p90Ms: h.p90Ms,
      p95Ms: h.p95Ms,
      p99Ms: h.p99Ms,
      byRequest: byReqOut,
    };
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function serializeNativeRequests(
  items: PerformanceRequestDescriptor[]
): Promise<NativePerformanceRequestItem[]> {
  const out: NativePerformanceRequestItem[] = [];
  for (const item of items) {
    const req = item.request;
    let binaryBase64: string | undefined;
    let formAttachments: Record<string, NativePerformanceAttachmentPayload> | undefined;

    if (req.bodyType === 'binary' && req.bodyBinaryFile?.file instanceof Blob) {
      if (req.bodyBinaryFile.file.size > MAX_NATIVE_ATTACHMENT_BYTES) {
        throw new Error(
          `Binary attachment "${req.bodyBinaryFile.name}" exceeds the 10 MiB limit for high-concurrency load tests.`
        );
      }
      binaryBase64 = await blobToBase64(req.bodyBinaryFile.file);
    }

    if (req.bodyType === 'form-data' && Array.isArray(req.bodyFormData)) {
      for (const f of req.bodyFormData) {
        if (f.enabled && f.type === 'file' && f.file instanceof Blob) {
          if (f.file.size > MAX_NATIVE_ATTACHMENT_BYTES) {
            throw new Error(
              `Attachment "${f.fileName || f.key}" exceeds the 10 MiB limit for high-concurrency load tests.`
            );
          }
          if (!formAttachments) formAttachments = {};
          formAttachments[f.id] = {
            fieldKey: f.key,
            fileName: f.file.name || f.fileName || 'file.bin',
            mimeType: f.file.type || f.fileType || 'application/octet-stream',
            bytesBase64: await blobToBase64(f.file),
          };
        }
      }
    }

    out.push({
      id: item.id,
      name: item.name,
      path: item.path,
      request: req,
      binaryBase64,
      formAttachments,
    });
  }
  return out;
}

export interface StartPerformanceRunParams {
  tabId: string;
  title: string;
  sourceType: 'collection' | 'folder' | 'request';
  sourceId: string;
  items: PerformanceRequestDescriptor[];
  executionMode: PerformanceExecutionMode;
  setupItemIds: string[];
  setupRefresh?: PerformanceSetupRefreshConfig;
  runInLoopScripts: boolean;
  loadProfile: LoadProfileConfig;
  network: PerformanceNetworkOptions;
  dataFileMeta?: PerformanceDataFileMeta;
  dataRows?: Array<Record<string, string>>;
  thresholds?: PerformanceThresholdConfig;
  initialVariables: Record<string, string>;
  adapter?: PlatformAdapter;
  onUpdate: (report: PerformanceRunReport) => void;
  onFinish: (report: PerformanceRunReport) => void;
}

export async function startPerformanceTest(params: StartPerformanceRunParams): Promise<{
  started: boolean;
  runId?: string;
  error?: string;
}> {
  if (getActivePerformanceRun()) {
    return {
      started: false,
      error: 'Another performance test is already running. Stop it before starting a new run.',
    };
  }
  if (getActiveFunctionalRunState()) {
    return {
      started: false,
      error: 'A functional collection run is currently in progress. Stop it before starting a performance test.',
    };
  }

  const adapter = params.adapter || getDefaultPlatformAdapter() || undefined;
  const platformId = adapter?.platformId || 'web';
  const limits = getPlatformPerformanceLimits(platformId);

  const selectedItems = params.items.filter((it) => it.selected);
  const setupSet = new Set(params.setupItemIds);
  const setupItems =
    params.executionMode === 'pre_run_setup'
      ? params.items.filter((it) => setupSet.has(it.id))
      : [];
  const loopItems =
    params.executionMode === 'pre_run_setup'
      ? selectedItems.filter((it) => !setupSet.has(it.id))
      : selectedItems;

  if (params.executionMode === 'pre_run_setup' && setupItems.length === 0) {
    return {
      started: false,
      error: 'Select at least one Pre-run Setup request (e.g. token endpoint) or switch to Sequential mode.',
    };
  }
  if (loopItems.length === 0) {
    return {
      started: false,
      error: 'Select at least one request to run in the load loop.',
    };
  }

  const clampedPeakVu = Math.max(1, Math.min(limits.maxVUs, Math.round(params.loadProfile.virtualUsers || 1)));
  const clampedBaseVu = Math.max(0, Math.min(clampedPeakVu - 1, Math.round(params.loadProfile.baseLoad || 0)));
  const effectiveProfile: LoadProfileConfig = {
    ...params.loadProfile,
    virtualUsers: clampedPeakVu,
    baseLoad: clampedBaseVu,
  };
  const effectiveDurationSec = getDurationSeconds(effectiveProfile);
  const effectiveNetwork: PerformanceNetworkOptions = {
    ...params.network,
    requestTimeoutMs: clampPerformanceTimeoutMs(params.network.requestTimeoutMs, effectiveDurationSec),
  };

  // Pre-flight host permissions for browser extension
  if (adapter && platformId === 'extension') {
    const candidateItems = [...setupItems, ...loopItems];
    const requestedOrigins = new Set<string>();
    for (const item of candidateItems) {
      const resolvedUrl = interpolateVariables((item.request.url || '').trim(), params.initialVariables);
      const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//i.test(resolvedUrl)
        ? resolvedUrl
        : `https://${resolvedUrl}`;
      try {
        const origin = new URL(withScheme).origin;
        if (!requestedOrigins.has(origin)) {
          requestedOrigins.add(origin);
          const hasPerm = await adapter.hasHostPermission(withScheme);
          if (hasPerm === false) {
            const granted = await adapter.requestHostPermission(withScheme);
            if (!granted) {
              return {
                started: false,
                error: `Host permission denied for ${origin}. Grant access to run the performance test.`,
              };
            }
          }
        }
      } catch {
        // Ignore uninterpolated URLs here; runtime will report Invalid URL if malformed
      }
    }
  }

  const runId = makeRunId();
  const startedAt = Date.now();
  const abortController = new AbortController();
  const warnings: string[] = [];

  if (platformId === 'extension') {
    warnings.push(
      `Browser Extension mode is capped at ${limits.maxVUs} VUs (Chromium limits HTTP/1.1 to ${limits.http1ConnectionLimit || 6} concurrent sockets per host). Use AirREST Desktop for high concurrency.`
    );
  } else if (platformId === 'android') {
    warnings.push(`Android mode is capped at ${limits.maxVUs} VUs for device stability.`);
  } else if (clampedPeakVu > limits.strongWarnThreshold) {
    warnings.push(
      `High load configured (${clampedPeakVu} VUs): higher virtual users consume significant CPU, memory, and OS sockets.`
    );
  } else if (clampedPeakVu > limits.warnThreshold) {
    warnings.push(
      `Moderate-to-high load (${clampedPeakVu} VUs): ensure your machine and target host allow sufficient open file descriptors.`
    );
  }

  const hasLoopScripts = loopItems.some(
    (it) => Boolean(it.request.preRequestScript?.trim() || it.request.postResponseScript?.trim())
  );
  const useInLoopScripts = params.runInLoopScripts && hasLoopScripts;
  const canUseNativeFastPath = Boolean(adapter?.performanceRunner) && !useInLoopScripts;
  const engineMode: PerformanceEngineMode = canUseNativeFastPath
    ? 'rust_native'
    : platformId === 'desktop'
      ? 'hybrid_pool'
      : 'js_bounded';

  if (useInLoopScripts && platformId === 'desktop') {
    warnings.push(
      'In-loop Pre-request / Post-response scripts are active: executing via Reusable JS Worker Pool (lower max throughput than Pure Rust fast-path).'
    );
  }

  const safeDataRows = params.dataRows && params.dataRows.length > 0 ? params.dataRows : undefined;
  const dataReadMode: PerformanceDataFileReadMode = params.dataFileMeta?.readMode || 'sequential';
  const sanitizedDataFileMeta =
    params.dataFileMeta && safeDataRows
      ? {
        filename: params.dataFileMeta.filename,
        format: params.dataFileMeta.format,
        fileBytes: params.dataFileMeta.fileBytes,
        rowCount: safeDataRows.length,
        columns: params.dataFileMeta.columns,
        readMode: dataReadMode,
      }
      : undefined;

  if (params.dataFileMeta && !safeDataRows) {
    warnings.push(
      `Data file "${params.dataFileMeta.filename}" rows were not found in session memory; running without iteration dataset.`
    );
  }

  const baseReport: PerformanceRunReport = {
    id: runId,
    tabId: params.tabId,
    title: params.title,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    status: 'running',
    engineMode,
    platformId,
    executionMode: params.executionMode,
    setupResults: [],
    configSnapshot: {
      loadProfile: effectiveProfile,
      network: effectiveNetwork,
      requestCount: loopItems.length,
      setupRequestCount: setupItems.length,
      runInLoopScripts: useInLoopScripts,
      dataFile: sanitizedDataFileMeta,
      thresholds: params.thresholds,
      setupRefresh: params.executionMode === 'pre_run_setup' ? params.setupRefresh : undefined,
    },
    summary: {
      totalRequests: 0,
      errorCount: 0,
      warningCount: 0,
      errorRatePct: 0,
      requestsPerSec: 0,
      avgMs: 0,
      minMs: 0,
      maxMs: 0,
      p90Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      bytesReceived: 0,
    },
    timeSeries: [],
    endpoints: loopItems.map((it) => ({
      requestId: it.id,
      name: it.name,
      method: it.request.method,
      path: it.path,
      totalRequests: 0,
      errorCount: 0,
      warningCount: 0,
      errorRatePct: 0,
      requestsPerSec: 0,
      avgMs: 0,
      minMs: 0,
      maxMs: 0,
      p90Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      bytesReceived: 0,
    })),
    errorGroups: [],
    errorSamples: [],
    warnings,
  };

  let stoppedByUser = false;
  let activeNativeRunId: string | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  const abortExecution = async (fromUserStop: boolean) => {
    if (fromUserStop) stoppedByUser = true;
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    abortController.abort();
    if (activeNativeRunId && adapter?.performanceRunner) {
      try {
        await adapter.performanceRunner.stopRun(activeNativeRunId);
      } catch {
        // ignore native stop race
      }
    }
  };

  setActivePerformanceRunController({
    runId,
    tabId: params.tabId,
    stop: async () => {
      await abortExecution(true);
    },
  });

  const clearRunIfCurrent = () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (getActivePerformanceRun()?.runId === runId) {
      setActivePerformanceRunController(null);
    }
  };

  params.onUpdate({ ...baseReport });

  // Execute asynchronously so startPerformanceTest returns immediately with started: true
  void (async () => {
    try {
      let runVariables = { ...params.initialVariables };
      let setupResults: PerformanceSetupStepResult[] = [];

      if (params.executionMode === 'pre_run_setup' && setupItems.length > 0) {
        const setupOutcome = await executePreRunSetup(setupItems, runVariables, {
          signal: abortController.signal,
          adapter,
          scriptExecutor: adapter?.perfScriptExecutor || adapter?.scriptExecutor,
          network: effectiveNetwork,
        });
        setupResults = setupOutcome.setupResults;
        baseReport.setupResults = setupResults;

        if (!setupOutcome.success) {
          const finishedAt = Date.now();
          const failedReport: PerformanceRunReport = {
            ...baseReport,
            status: stoppedByUser ? 'stopped' : 'failed',
            finishedAt,
            durationMs: Math.max(0, finishedAt - startedAt),
            failureReason: setupOutcome.error || 'Pre-run setup failed.',
          };
          clearRunIfCurrent();
          params.onFinish(failedReport);
          return;
        }
        runVariables = setupOutcome.variables;
      }

      if (abortController.signal.aborted) {
        const finishedAt = Date.now();
        const stoppedReport: PerformanceRunReport = {
          ...baseReport,
          status: 'stopped',
          finishedAt,
          durationMs: Math.max(0, finishedAt - startedAt),
        };
        clearRunIfCurrent();
        params.onFinish(stoppedReport);
        return;
      }

      const sharedBaseVarsRef = {
        current: { ...runVariables },
        version: 0,
      };
      const autoStopTracker = createAutoStopTracker(params.thresholds);
      let autoAbortMeta: { ruleId: string; reason: string } | undefined;
      let unauthorizedSeen = 0;
      let isRefreshingSetup = false;
      let last401RefreshAttemptAt = 0;
      const refreshStats: PerformanceSetupRefreshStats = {
        attempts: 0,
        successes: 0,
        failures: 0,
      };

      const canRefreshSetup =
        params.executionMode === 'pre_run_setup' &&
        setupItems.length > 0 &&
        Boolean(params.setupRefresh?.enabled || params.setupRefresh?.refreshOn401);
      const refreshCooldownMs = Math.max(15, params.setupRefresh?.cooldownSec ?? 15) * 1000;

      const MAX_CONSECUTIVE_REFRESH_FAILURES = 3;
      let consecutiveRefreshFailures = 0;
      let refreshDisabledByFailures = false;

      const triggerSetupRefresh = async (trigger: 'interval' | 'http_401') => {
        if (
          !canRefreshSetup ||
          refreshDisabledByFailures ||
          isRefreshingSetup ||
          abortController.signal.aborted ||
          autoAbortMeta
        ) {
          return;
        }
        const now = Date.now();
        if (trigger === 'http_401' && now - last401RefreshAttemptAt < refreshCooldownMs) return;
        isRefreshingSetup = true;
        if (trigger === 'http_401') {
          last401RefreshAttemptAt = now;
        }
        refreshStats.attempts += 1;

        try {
          const outcome = await executePreRunSetup(setupItems, { ...sharedBaseVarsRef.current }, {
            signal: abortController.signal,
            adapter,
            scriptExecutor: adapter?.perfScriptExecutor || adapter?.scriptExecutor,
            network: effectiveNetwork,
          });
          if (outcome.success) {
            consecutiveRefreshFailures = 0;
            last401RefreshAttemptAt = Date.now();
            runVariables = outcome.variables;
            sharedBaseVarsRef.current = { ...outcome.variables };
            sharedBaseVarsRef.version += 1;
            refreshStats.successes += 1;
            refreshStats.lastRefreshedAt = Date.now();
            refreshStats.lastError = undefined;
            if (canUseNativeFastPath && activeNativeRunId && adapter?.performanceRunner?.updateVariables) {
              await adapter.performanceRunner.updateVariables(activeNativeRunId, outcome.variables).catch(() => { });
            }
          } else {
            consecutiveRefreshFailures += 1;
            refreshStats.failures += 1;
            refreshStats.lastError = outcome.error || 'Setup refresh failed.';
            const warnMsg = `Token refresh (${trigger === 'http_401' ? '401 recovery' : 'periodic'}) failed: ${refreshStats.lastError}. Keeping previous variables.`;
            if (!warnings.includes(warnMsg)) warnings.push(warnMsg);
            if (consecutiveRefreshFailures >= MAX_CONSECUTIVE_REFRESH_FAILURES) {
              refreshDisabledByFailures = true;
              if (refreshTimer) {
                clearInterval(refreshTimer);
                refreshTimer = null;
              }
              const pauseMsg = `Token refresh paused after ${MAX_CONSECUTIVE_REFRESH_FAILURES} consecutive failures. Keeping last valid variables.`;
              if (!warnings.includes(pauseMsg)) warnings.push(pauseMsg);
            }
          }
        } catch (err) {
          consecutiveRefreshFailures += 1;
          refreshStats.failures += 1;
          refreshStats.lastError = err instanceof Error ? err.message : String(err);
          const warnMsg = `Token refresh failed: ${refreshStats.lastError}. Keeping previous variables.`;
          if (!warnings.includes(warnMsg)) warnings.push(warnMsg);
          if (consecutiveRefreshFailures >= MAX_CONSECUTIVE_REFRESH_FAILURES) {
            refreshDisabledByFailures = true;
            if (refreshTimer) {
              clearInterval(refreshTimer);
              refreshTimer = null;
            }
            const pauseMsg = `Token refresh paused after ${MAX_CONSECUTIVE_REFRESH_FAILURES} consecutive failures. Keeping last valid variables.`;
            if (!warnings.includes(pauseMsg)) warnings.push(pauseMsg);
          }
        } finally {
          isRefreshingSetup = false;
        }
      };

      if (canRefreshSetup && params.setupRefresh?.enabled) {
        const rawIntervalSec =
          params.setupRefresh.intervalUnit === 'minutes'
            ? (params.setupRefresh.intervalValue || 1) * 60
            : params.setupRefresh.intervalValue || 60;
        const clampedIntervalMs = Math.max(10, Math.round(rawIntervalSec)) * 1000;
        refreshTimer = setInterval(() => {
          void triggerSetupRefresh('interval');
        }, clampedIntervalMs);
      }

      const processLiveTick = (liveReport: PerformanceRunReport, elapsedMs: number, current401Count: number) => {
        if (!autoAbortMeta && !stoppedByUser) {
          const decision = autoStopTracker.evaluateTick(liveReport, elapsedMs / 1000);
          if (decision.shouldAbort && decision.ruleId && decision.reason) {
            autoAbortMeta = { ruleId: decision.ruleId, reason: decision.reason };
            if (!warnings.includes(decision.reason)) warnings.push(decision.reason);
            void abortExecution(false);
          }
        }

        if (canRefreshSetup && params.setupRefresh?.refreshOn401 && current401Count > unauthorizedSeen) {
          unauthorizedSeen = current401Count;
          void triggerSetupRefresh('http_401');
        } else {
          unauthorizedSeen = Math.max(unauthorizedSeen, current401Count);
        }

        params.onUpdate({
          ...liveReport,
          autoAborted: Boolean(autoAbortMeta),
          setupRefreshStats: refreshStats.attempts > 0 ? { ...refreshStats } : undefined,
          warnings: Array.from(new Set(warnings)),
        });
      };

      const finalizeReportWithSla = (rawReport: PerformanceRunReport): PerformanceRunReport => {
        if (refreshTimer) {
          clearInterval(refreshTimer);
          refreshTimer = null;
        }
        const slaResult = evaluatePerformanceThresholds(rawReport, params.thresholds, autoAbortMeta);
        return {
          ...rawReport,
          status: stoppedByUser || autoAbortMeta ? 'stopped' : rawReport.status,
          autoAborted: Boolean(autoAbortMeta),
          slaResult,
          setupRefreshStats: refreshStats.attempts > 0 ? { ...refreshStats } : undefined,
          warnings: Array.from(new Set([...(rawReport.warnings || []), ...warnings])),
        };
      };

      // Path A: Native Rust High-Concurrency Engine
      if (canUseNativeFastPath && adapter?.performanceRunner) {
        const serializedItems = await serializeNativeRequests(loopItems);
        const liveBuckets: PerformanceTimeBucket[] = [];

        await new Promise<void>((resolve, reject) => {
          let settled = false;
          adapter.performanceRunner!
            .startRun(
              {
                runId,
                items: serializedItems,
                initialVariables: runVariables,
                loadProfile: effectiveProfile,
                network: effectiveNetwork,
                dataFile: safeDataRows
                  ? { readMode: dataReadMode, rows: safeDataRows }
                  : undefined,
              },
              {
                onTick: (tick) => {
                  if (tick.bucket) {
                    const idx = liveBuckets.findIndex((b) => b.second === tick.bucket!.second);
                    if (idx >= 0) liveBuckets[idx] = tick.bucket;
                    else liveBuckets.push(tick.bucket);
                  }
                  const liveReport: PerformanceRunReport = {
                    ...baseReport,
                    durationMs: tick.elapsedMs,
                    summary: tick.summary,
                    timeSeries: [...liveBuckets],
                    endpoints: tick.endpoints,
                    errorGroups: tick.errorGroups,
                    errorSamples: tick.errorSamples,
                  };
                  processLiveTick(liveReport, tick.elapsedMs, tick.unauthorizedCount ?? 0);
                },
                onComplete: (result) => {
                  if (settled) return;
                  settled = true;
                  const finishedAt = Date.now();
                  const finalReport = finalizeReportWithSla({
                    ...baseReport,
                    status: result.status,
                    finishedAt,
                    durationMs: result.durationMs,
                    failureReason: result.failureReason,
                    summary: result.summary,
                    timeSeries: result.timeSeries.length > 0 ? result.timeSeries : [...liveBuckets],
                    endpoints: result.endpoints,
                    errorGroups: result.errorGroups,
                    errorSamples: result.errorSamples,
                    warnings: result.warnings || [],
                  });
                  clearRunIfCurrent();
                  params.onFinish(finalReport);
                  resolve();
                },
              }
            )
            .then((handle) => {
              activeNativeRunId = handle.runId;
              if (handle.warnings?.length) {
                for (const w of handle.warnings) {
                  if (!warnings.includes(w)) warnings.push(w);
                }
              }
              if (sharedBaseVarsRef.version > 0 && adapter.performanceRunner?.updateVariables) {
                void adapter.performanceRunner.updateVariables(handle.runId, sharedBaseVarsRef.current).catch(() => { });
              }
              if (abortController.signal.aborted) {
                void adapter.performanceRunner?.stopRun(handle.runId);
              }
            })
            .catch((err) => {
              if (settled) return;
              settled = true;
              reject(err);
            });
        });
        return;
      }

      // Path B: Bounded JS / Hybrid VU Scheduler
      const rawFinalReport = await runJsPerformanceEngine({
        baseReport,
        loopItems,
        sharedBaseVarsRef,
        loadProfile: effectiveProfile,
        network: effectiveNetwork,
        dataReadMode,
        dataRows: safeDataRows,
        useInLoopScripts,
        adapter,
        signal: abortController.signal,
        stoppedByUser: () => stoppedByUser || Boolean(autoAbortMeta),
        onTick: (report, elapsedMs, unauthCount) => processLiveTick(report, elapsedMs, unauthCount),
      });

      const finalReport = finalizeReportWithSla(rawFinalReport);
      clearRunIfCurrent();
      params.onFinish(finalReport);
    } catch (err: unknown) {
      const finishedAt = Date.now();
      const failedReport: PerformanceRunReport = {
        ...baseReport,
        status: stoppedByUser ? 'stopped' : 'failed',
        finishedAt,
        durationMs: Math.max(0, finishedAt - startedAt),
        failureReason: err instanceof Error ? err.message : String(err),
      };
      clearRunIfCurrent();
      params.onFinish(failedReport);
    }
  })();

  return { started: true, runId };
}

async function runJsPerformanceEngine(params: {
  baseReport: PerformanceRunReport;
  loopItems: PerformanceRequestDescriptor[];
  sharedBaseVarsRef: { current: Record<string, string>; version: number };
  loadProfile: LoadProfileConfig;
  network: PerformanceNetworkOptions;
  dataReadMode: PerformanceDataFileReadMode;
  dataRows?: Array<Record<string, string>>;
  useInLoopScripts: boolean;
  adapter?: PlatformAdapter;
  signal: AbortSignal;
  stoppedByUser: () => boolean;
  onTick: (report: PerformanceRunReport, elapsedMs: number, unauthorizedCount: number) => void;
}): Promise<PerformanceRunReport> {
  const {
    baseReport,
    loopItems,
    sharedBaseVarsRef,
    loadProfile,
    network,
    dataReadMode,
    dataRows,
    useInLoopScripts,
    adapter,
    signal,
  } = params;
  const durationSec = getDurationSeconds(loadProfile);
  const peakVus = Math.max(1, loadProfile.virtualUsers || 1);
  const runStartPerf = performance.now();
  const runStartWall = Date.now();

  const totalHist = new PerfHistogram();
  const endpointMap = new Map<string, EndpointAccumulator>();
  for (const item of loopItems) {
    endpointMap.set(item.id, new EndpointAccumulator(item));
  }

  let totalRequests = 0;
  let errorCount = 0;
  let warningCount = 0;
  let unauthorizedCount = 0;
  let totalBytes = 0;
  let seqRowCounter = 0;
  let nextVuIndex = 0;
  const errorGroupMap = new Map<string, { status: number; category: string; label: string; count: number; requestIds: Set<string> }>();
  const errorSamples: PerformanceErrorSample[] = [];
  const secondBuckets = new Map<number, SecondBucketAccumulator>();

  const getBucket = (secIndex: number): SecondBucketAccumulator => {
    let b = secondBuckets.get(secIndex);
    if (!b) {
      b = new SecondBucketAccumulator(secIndex, runStartWall + secIndex * 1000);
      secondBuckets.set(secIndex, b);
    }
    return b;
  };

  const recordOutcome = (
    item: PerformanceRequestDescriptor,
    timeMs: number,
    bytes: number,
    isError: boolean,
    errInfo?: { status: number; statusText: string; category: string; message: string; snippet?: string; url: string },
    isWarning = false
  ) => {
    const elapsedSec = Math.min(durationSec - 1, Math.max(0, Math.floor((performance.now() - runStartPerf) / 1000)));
    totalRequests += 1;
    if (isError) errorCount += 1;
    if (isWarning) warningCount += 1;
    if (errInfo?.status === 401) unauthorizedCount += 1;
    totalBytes += bytes;
    totalHist.record(timeMs);
    endpointMap.get(item.id)?.record(timeMs, bytes, isError, isWarning);
    getBucket(elapsedSec).record(item.id, timeMs, isError);

    if (isError && errInfo) {
      const groupKey = `${errInfo.status}:${errInfo.category}`;
      let grp = errorGroupMap.get(groupKey);
      if (!grp) {
        const label = errInfo.status > 0 ? `HTTP ${errInfo.status} ${errInfo.statusText}`.trim() : errInfo.statusText || errInfo.category;
        grp = { status: errInfo.status, category: errInfo.category, label, count: 0, requestIds: new Set() };
        errorGroupMap.set(groupKey, grp);
      }
      grp.count += 1;
      grp.requestIds.add(item.id);

      if (errorSamples.length < MAX_ERROR_SAMPLES) {
        errorSamples.push({
          id: `err_${errorSamples.length + 1}_${Date.now()}`,
          timestampMs: Date.now(),
          requestId: item.id,
          requestName: item.name,
          method: item.request.method,
          url: errInfo.url,
          status: errInfo.status,
          statusText: errInfo.statusText,
          category: errInfo.category,
          message: errInfo.message,
          responseSnippet: errInfo.snippet,
          timeMs,
        });
      }
    }
  };

  const buildSnapshot = (elapsedMs: number): Pick<
    PerformanceRunReport,
    'durationMs' | 'summary' | 'timeSeries' | 'endpoints' | 'errorGroups' | 'errorSamples'
  > => {
    const elapsedSec = Math.max(0.001, elapsedMs / 1000);
    const h = totalHist.getSummary();
    const sortedBuckets = Array.from(secondBuckets.values())
      .sort((a, b) => a.second - b.second)
      .map((b) => b.toBucket());
    const maxRequestsPerSec = sortedBuckets.reduce((max, b) => Math.max(max, b.requestsPerSec), 0);

    return {
      durationMs: Math.round(elapsedMs),
      summary: {
        totalRequests,
        errorCount,
        warningCount,
        errorRatePct: totalRequests > 0 ? Number(((errorCount / totalRequests) * 100).toFixed(2)) : 0,
        requestsPerSec: Number((totalRequests / elapsedSec).toFixed(2)),
        maxRequestsPerSec,
        avgMs: h.avgMs,
        minMs: h.minMs,
        maxMs: h.maxMs,
        p90Ms: h.p90Ms,
        p95Ms: h.p95Ms,
        p99Ms: h.p99Ms,
        bytesReceived: totalBytes,
      },
      timeSeries: sortedBuckets,
      endpoints: loopItems.map((it) => {
        const ep = endpointMap.get(it.id)!.toBreakdown(elapsedSec);
        const epMaxRps = sortedBuckets.reduce(
          (max, b) => Math.max(max, b.byRequest?.[it.id]?.requestsPerSec ?? 0),
          0
        );
        return {
          ...ep,
          maxRequestsPerSec: epMaxRps,
        };
      }),
      errorGroups: Array.from(errorGroupMap.entries())
        .map(([key, g]) => ({
          key,
          status: g.status,
          category: g.category,
          label: g.label,
          count: g.count,
          requestIds: Array.from(g.requestIds),
        }))
        .sort((a, b) => b.count - a.count),
      errorSamples: [...errorSamples],
    };
  };

  // Manage active VU loops dynamically via per-VU AbortController
  const activeVus: AbortController[] = [];
  const vuPromises: Promise<void>[] = [];
  const runDeadlinePerf = runStartPerf + durationSec * 1000;

  const spawnVu = () => {
    const vuCtrl = new AbortController();
    const onRunAbort = () => vuCtrl.abort();
    signal.addEventListener('abort', onRunAbort, { once: true });
    activeVus.push(vuCtrl);

    const vuIndex = nextVuIndex++;
    const promise = (async () => {
      // Isolated per-VU variable state cloned from run snapshot
      let vuEnv: Record<string, string> = { ...sharedBaseVarsRef.current };
      let vuVars: Record<string, string> = {};
      let seenBaseVersion = sharedBaseVarsRef.version;
      let vuIteration = 0;

      while (!vuCtrl.signal.aborted && !signal.aborted && performance.now() < runDeadlinePerf) {
        if (sharedBaseVarsRef.version !== seenBaseVersion) {
          vuEnv = { ...sharedBaseVarsRef.current };
          seenBaseVersion = sharedBaseVarsRef.version;
        }

        let iterationRow: Record<string, string> | undefined;
        if (dataRows && dataRows.length > 0) {
          const rowIdx = selectDataRowIndex(
            dataReadMode,
            dataRows.length,
            vuIndex,
            peakVus,
            vuIteration,
            seqRowCounter++
          );
          iterationRow = dataRows[rowIdx];
        }
        vuIteration += 1;

        for (const item of loopItems) {
          if (vuCtrl.signal.aborted || signal.aborted || performance.now() >= runDeadlinePerf) break;

          let reqToRun = item.request;
          const hasPre = useInLoopScripts && Boolean(reqToRun.preRequestScript?.trim());
          const hasPost = useInLoopScripts && Boolean(reqToRun.postResponseScript?.trim());

          if (hasPre) {
            const preRes = await executePreRequestScript(reqToRun.preRequestScript!, vuEnv, vuVars, {
              signal: vuCtrl.signal,
              scriptExecutor: adapter?.perfScriptExecutor || adapter?.scriptExecutor,
              request: toScriptRequest(reqToRun),
              iterationData: iterationRow,
            });
            vuEnv = { ...preRes.environment };
            vuVars = { ...preRes.variables };
            if (!preRes.success) {
              recordOutcome(item, 0, 0, true, {
                status: 0,
                statusText: 'Script Error',
                category: 'script_error',
                message: preRes.error || 'Pre-request script error',
                url: reqToRun.url,
              });
              continue;
            }
            reqToRun = applyScriptMutatedRequest(reqToRun, preRes.mutatedRequest);
          }

          const mergedVars = iterationRow
            ? { ...vuEnv, ...iterationRow, ...vuVars }
            : { ...vuEnv, ...vuVars };
          const res = await executePerfHttpStep(reqToRun, mergedVars, vuCtrl.signal, adapter, network, hasPost);

          if (vuCtrl.signal.aborted && res.errorCategory === 'cancelled') {
            break;
          }

          let finalIsError = res.isError;
          let errMeta:
            | {
              status: number;
              statusText: string;
              category: string;
              message: string;
              snippet?: string;
              url: string;
            }
            | undefined = res.isError
              ? {
                status: res.status,
                statusText: res.statusText,
                category: res.errorCategory,
                message: res.errorMessage,
                snippet: res.errorSnippet,
                url: res.finalUrl,
              }
              : undefined;

          if (hasPost && !res.errorCategory.startsWith('cancelled')) {
            const postRes = await executePostResponseScript(
              reqToRun.postResponseScript!,
              {
                status: res.status,
                statusText: res.statusText,
                timeMs: res.timeMs,
                sizeBytes: res.sizeBytes,
                headers: res.headers,
                data: res.data,
                timestamp: Date.now(),
              },
              vuEnv,
              vuVars,
              {
                signal: vuCtrl.signal,
                scriptExecutor: adapter?.perfScriptExecutor || adapter?.scriptExecutor,
                request: toScriptRequest(reqToRun),
                iterationData: iterationRow,
              }
            );
            vuEnv = { ...postRes.environment };
            vuVars = { ...postRes.variables };
            if (!postRes.success && !finalIsError) {
              finalIsError = true;
              errMeta = {
                status: res.status,
                statusText: 'Script Assertion Failed',
                category: 'script_error',
                message: postRes.error || 'Post-response script failed',
                url: res.finalUrl,
              };
            }
          }

          recordOutcome(item, res.timeMs, res.sizeBytes, finalIsError, errMeta, Boolean(res.isWarning && !finalIsError));
        }

        if (
          loadProfile.thinkTimeMs > 0 &&
          !vuCtrl.signal.aborted &&
          !signal.aborted &&
          performance.now() < runDeadlinePerf
        ) {
          await new Promise<void>((resSleep) => {
            const remaining = Math.max(0, runDeadlinePerf - performance.now());
            const waitMs = Math.min(loadProfile.thinkTimeMs, remaining);
            const t = setTimeout(resSleep, waitMs);
            vuCtrl.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(t);
                resSleep();
              },
              { once: true }
            );
          });
        }
      }
    })().finally(() => {
      signal.removeEventListener('abort', onRunAbort);
    });

    vuPromises.push(promise);
  };

  const reconcileVus = () => {
    const elapsedSec = Math.max(0, (performance.now() - runStartPerf) / 1000);
    const target = signal.aborted || performance.now() >= runDeadlinePerf
      ? 0
      : getTargetVusAtTime(loadProfile, elapsedSec);

    while (activeVus.length < target) {
      spawnVu();
    }
    while (activeVus.length > target) {
      const removed = activeVus.pop();
      removed?.abort();
    }
    const secIdx = Math.min(durationSec - 1, Math.max(0, Math.floor(elapsedSec)));
    const bucket = getBucket(secIdx);
    bucket.virtualUsers = Math.max(bucket.virtualUsers, activeVus.length);
  };

  reconcileVus();

  await new Promise<void>((resolveLoop) => {
    let lastTickSec = -1;
    const schedulerTimer = setInterval(() => {
      const elapsedMs = performance.now() - runStartPerf;
      if (signal.aborted || elapsedMs >= durationSec * 1000) {
        clearInterval(schedulerTimer);
        while (activeVus.length > 0) {
          activeVus.pop()?.abort();
        }
        resolveLoop();
        return;
      }

      reconcileVus();
      const currentSec = Math.floor(elapsedMs / 1000);
      if (currentSec > lastTickSec) {
        lastTickSec = currentSec;
        const snap = buildSnapshot(elapsedMs);
        params.onTick(
          {
            ...baseReport,
            ...snap,
            status: 'running',
          },
          elapsedMs,
          unauthorizedCount
        );
      }
    }, 250);

    signal.addEventListener(
      'abort',
      () => {
        clearInterval(schedulerTimer);
        while (activeVus.length > 0) {
          activeVus.pop()?.abort();
        }
        resolveLoop();
      },
      { once: true }
    );
  });

  await Promise.allSettled(vuPromises);

  const totalElapsedMs = Math.min(durationSec * 1000, Math.max(1, performance.now() - runStartPerf));
  const finalSnap = buildSnapshot(totalElapsedMs);
  const runWarnings = [...(baseReport.warnings || [])];
  if (warningCount > 0) {
    runWarnings.push(
      `Received ${warningCount.toLocaleString()} HTTP 3xx redirect response(s) while "Follow HTTP redirects" was disabled (counted as warnings, not errors).`
    );
  }
  return {
    ...baseReport,
    ...finalSnap,
    warnings: Array.from(new Set(runWarnings)),
    status: params.stoppedByUser() ? 'stopped' : 'completed',
    finishedAt: Date.now(),
  };
}
