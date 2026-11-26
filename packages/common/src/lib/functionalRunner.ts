import type {
  ApiResponse,
  FunctionalRunReport,
  FunctionalRunnerConfig,
  FunctionalStepResult,
  PerformanceDataFileMeta,
  PerformanceNetworkOptions,
  PerformanceRequestDescriptor,
} from '../types/api';
import type { PlatformAdapter, ScriptTestResult } from '../types/platform';
import { interpolateVariables } from './fetcher';
import {
  applyScriptMutatedRequest,
  executePerfHttpStep,
  toScriptRequest,
} from './perfRunner';
import { captureFunctionalExchange } from './functionalSessionStore';
import { registerFunctionalStopHook } from './examples';
import { executePostResponseScript, executePreRequestScript } from './scriptRunner';

export interface ActiveFunctionalRunController {
  runId: string;
  tabId: string;
  stop: () => Promise<void>;
}

let activeFunctionalRun: ActiveFunctionalRunController | null = null;

export function getActiveFunctionalRun(): ActiveFunctionalRunController | null {
  return activeFunctionalRun;
}

export async function stopActiveFunctionalRun(): Promise<void> {
  if (activeFunctionalRun) {
    await activeFunctionalRun.stop();
  }
}

registerFunctionalStopHook(async (tabId?: string) => {
  if (!activeFunctionalRun) return;
  if (!tabId || activeFunctionalRun.tabId === tabId) {
    await activeFunctionalRun.stop();
  }
});

function makeFunctionalRunId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `func_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function resolveNextStepIndex(
  items: PerformanceRequestDescriptor[],
  target: string
): number {
  const trimmed = target.trim();
  if (!trimmed) return -1;
  const byId = items.findIndex((it) => it.id === trimmed || it.itemId === trimmed);
  if (byId >= 0) return byId;
  const byExactName = items.findIndex((it) => it.name === trimmed);
  if (byExactName >= 0) return byExactName;
  const lower = trimmed.toLowerCase();
  return items.findIndex((it) => it.name.trim().toLowerCase() === lower);
}

export interface StartFunctionalRunParams {
  tabId: string;
  title: string;
  sourceType: 'collection' | 'folder' | 'request';
  sourceId: string;
  items: PerformanceRequestDescriptor[];
  /** Optional subset of item IDs to execute (used by Re-run Failed). */
  onlyItemIds?: string[];
  config: FunctionalRunnerConfig;
  dataFileMeta?: PerformanceDataFileMeta;
  dataRows?: Array<Record<string, string>>;
  initialVariables: Record<string, string>;
  adapter?: PlatformAdapter;
  onCommitEnvironmentUpdates?: (
    finalEnv: Record<string, string>,
    unsetKeys: string[]
  ) => string[];
  onUpdate: (report: FunctionalRunReport) => void;
  onFinish: (report: FunctionalRunReport) => void;
}

export interface StartFunctionalRunOutcome {
  started: boolean;
  runId?: string;
  error?: string;
}

function recomputeReportMetrics(
  base: FunctionalRunReport,
  steps: FunctionalStepResult[],
  startedAt: number
): FunctionalRunReport {
  let requestsPassed = 0;
  let requestsFailed = 0;
  let requestsErrored = 0;
  let requestsSkipped = 0;
  let testsPassed = 0;
  let testsFailed = 0;
  let executedCount = 0;
  let totalLatencyMs = 0;
  const failedItemSet = new Set<string>();

  for (const s of steps) {
    testsPassed += s.testsPassed;
    testsFailed += s.testsFailed;
    if (s.status === 'skipped') {
      requestsSkipped += 1;
    } else {
      executedCount += 1;
      totalLatencyMs += s.timeMs;
      if (s.status === 'passed') requestsPassed += 1;
      else if (s.status === 'failed') {
        requestsFailed += 1;
        failedItemSet.add(s.itemId);
      } else if (s.status === 'error') {
        requestsErrored += 1;
        failedItemSet.add(s.itemId);
      }
    }
  }

  return {
    ...base,
    durationMs: Math.max(0, Date.now() - startedAt),
    totalRequestsExecuted: executedCount,
    requestsPassed,
    requestsFailed,
    requestsErrored,
    requestsSkipped,
    totalTests: testsPassed + testsFailed,
    testsPassed,
    testsFailed,
    avgResponseTimeMs: executedCount > 0 ? Math.round(totalLatencyMs / executedCount) : 0,
    steps: [...steps],
    failedItemIds: Array.from(failedItemSet),
  };
}

export async function startFunctionalRun(
  params: StartFunctionalRunParams
): Promise<StartFunctionalRunOutcome> {
  if (activeFunctionalRun) {
    return {
      started: false,
      error: 'Another functional runner execution is already in progress. Stop it first.',
    };
  }

  const onlySet = params.onlyItemIds ? new Set(params.onlyItemIds) : null;
  const selectedItems = (params.items || []).filter(
    (it) => it.selected && (!onlySet || onlySet.has(it.id) || onlySet.has(it.itemId))
  );

  if (selectedItems.length === 0) {
    return {
      started: false,
      error: 'Select at least one request to run.',
    };
  }

  const platformId = params.adapter?.platformId || 'web';

  // Extension host permissions pre-flight
  if (params.adapter && platformId === 'extension') {
    const requestedOrigins = new Set<string>();
    for (const item of selectedItems) {
      const resolvedUrl = interpolateVariables((item.request.url || '').trim(), params.initialVariables);
      const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//i.test(resolvedUrl)
        ? resolvedUrl
        : `https://${resolvedUrl}`;
      try {
        const origin = new URL(withScheme).origin;
        if (!requestedOrigins.has(origin)) {
          requestedOrigins.add(origin);
          const hasPerm = await params.adapter.hasHostPermission(withScheme);
          if (hasPerm === false) {
            const granted = await params.adapter.requestHostPermission(withScheme);
            if (!granted) {
              return {
                started: false,
                error: `Host permission denied for ${origin}. Grant access to execute requests.`,
              };
            }
          }
        }
      } catch {
        // Malformed URL handled per-step during run
      }
    }
  }

  const runId = makeFunctionalRunId();
  const startedAt = Date.now();
  const abortController = new AbortController();
  const safeIterations = Math.max(1, Math.min(10_000, Math.round(params.config.iterations || 1)));
  const safeDelayMs = Math.max(0, Math.min(60_000, Math.round(params.config.delayMs || 0)));
  const safeTimeoutMs = Math.max(500, Math.min(300_000, Math.round(params.config.requestTimeoutMs || 60_000)));
  const effectiveConfig: FunctionalRunnerConfig = {
    ...params.config,
    iterations: safeIterations,
    delayMs: safeDelayMs,
    requestTimeoutMs: safeTimeoutMs,
  };
  const safeDataRows = params.dataRows && params.dataRows.length > 0 ? params.dataRows : undefined;

  const baseReport: FunctionalRunReport = {
    id: runId,
    tabId: params.tabId,
    title: params.title,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    status: 'running',
    startedAt,
    durationMs: 0,
    config: effectiveConfig,
    dataFile:
      params.dataFileMeta && safeDataRows
        ? {
            filename: params.dataFileMeta.filename,
            format: params.dataFileMeta.format,
            fileBytes: params.dataFileMeta.fileBytes,
            rowCount: safeDataRows.length,
            columns: params.dataFileMeta.columns,
            readMode: params.dataFileMeta.readMode,
          }
        : undefined,
    plannedIterations: safeIterations,
    completedIterations: 0,
    totalRequestsExecuted: 0,
    requestsPassed: 0,
    requestsFailed: 0,
    requestsErrored: 0,
    requestsSkipped: 0,
    totalTests: 0,
    testsPassed: 0,
    testsFailed: 0,
    avgResponseTimeMs: 0,
    steps: [],
    failedItemIds: [],
  };

  let stoppedByUser = false;
  activeFunctionalRun = {
    runId,
    tabId: params.tabId,
    stop: async () => {
      stoppedByUser = true;
      abortController.abort();
    },
  };

  const clearRunIfCurrent = () => {
    if (activeFunctionalRun?.runId === runId) {
      activeFunctionalRun = null;
    }
  };

  params.onUpdate({ ...baseReport });

  void (async () => {
    const steps: FunctionalStepResult[] = [];
    const network: PerformanceNetworkOptions = {
      requestTimeoutMs: effectiveConfig.requestTimeoutMs,
      followRedirects: effectiveConfig.followRedirects,
      ignoreSslErrors: effectiveConfig.ignoreSslErrors,
    };
    const scriptExecutor = params.adapter?.scriptExecutor;
    let runEnv: Record<string, string> = { ...params.initialVariables };
    let runVars: Record<string, string> = {};
    let completedIterations = 0;
    let stopReason: string | undefined;
    let captureBudgetExhausted = false;

    try {
      const maxStepsPerIteration = Math.max(selectedItems.length * 10, 100);

      outerLoop: for (let iterIdx = 0; iterIdx < safeIterations; iterIdx++) {
        if (abortController.signal.aborted) break;
        const iterationNum = iterIdx + 1;
        const dataRowIndex = safeDataRows ? iterIdx % safeDataRows.length : undefined;
        const dataRow = safeDataRows && dataRowIndex !== undefined ? safeDataRows[dataRowIndex] : undefined;

        let cursor = 0;
        let iterStepCount = 0;

        while (cursor >= 0 && cursor < selectedItems.length) {
          if (abortController.signal.aborted) break outerLoop;

          if (iterStepCount >= maxStepsPerIteration) {
            stopReason = `Stopped iteration ${iterationNum}: setNextRequest() exceeded ${maxStepsPerIteration} steps (loop guard).`;
            break outerLoop;
          }

          const item = selectedItems[cursor];
          const stepId = `${runId}_i${iterationNum}_s${iterStepCount}`;
          const preScript = item.request.preRequestScript || '';
          const postScript = item.request.postResponseScript || '';

          let reqToRun = item.request;
          let preScriptError: string | undefined;
          let nextReqDirective: string | null | undefined;
          let mergedTestResults: ScriptTestResult[] = [];

          // Effective overlay matching pm.variables.get precedence: runVars > dataRow > runEnv
          const buildEffectiveVars = (): Record<string, string> => ({
            ...runEnv,
            ...(dataRow || {}),
            ...runVars,
          });

          if (preScript.trim()) {
            const preRes = await executePreRequestScript(preScript, runEnv, runVars, {
              signal: abortController.signal,
              scriptExecutor,
              request: toScriptRequest(reqToRun),
              iterationData: dataRow,
            });
            runEnv = { ...preRes.environment };
            runVars = { ...preRes.variables };
            if (preRes.testResults?.length) {
              mergedTestResults = [...mergedTestResults, ...preRes.testResults];
            }
            if (preRes.nextRequest !== undefined) {
              nextReqDirective = preRes.nextRequest;
            }
            if (!preRes.success) {
              preScriptError = preRes.error || 'Pre-request script failed.';
            } else if (preRes.mutatedRequest) {
              reqToRun = applyScriptMutatedRequest(reqToRun, preRes.mutatedRequest);
            }
          }

          if (abortController.signal.aborted) break outerLoop;

          if (preScriptError) {
            const errStep: FunctionalStepResult = {
              id: stepId,
              iteration: iterationNum,
              stepIndex: iterStepCount,
              itemId: item.itemId,
              name: item.name,
              method: item.request.method,
              url: reqToRun.url || '',
              status: 'error',
              httpStatus: 0,
              statusText: 'Pre-request Script Error',
              timeMs: 0,
              sizeBytes: 0,
              testResults: mergedTestResults,
              testsPassed: mergedTestResults.filter((t) => t.passed).length,
              testsFailed: mergedTestResults.filter((t) => !t.passed).length,
              scriptError: preScriptError,
              scriptErrorStage: 'pre-request',
              dataRowIndex,
              hasCapturedExchange: false,
              timestamp: Date.now(),
            };
            steps.push(errStep);
            params.onUpdate(recomputeReportMetrics({ ...baseReport, completedIterations }, steps, startedAt));

            if (effectiveConfig.stopOnError !== 'never') {
              stopReason = `Stopped on pre-request script error in "${item.name}".`;
              for (let rem = cursor + 1; rem < selectedItems.length; rem++) {
                const remItem = selectedItems[rem];
                steps.push({
                  id: `${runId}_i${iterationNum}_skip_${rem}`,
                  iteration: iterationNum,
                  stepIndex: iterStepCount + (rem - cursor),
                  itemId: remItem.itemId,
                  name: remItem.name,
                  method: remItem.request.method,
                  url: remItem.request.url || '',
                  status: 'skipped',
                  httpStatus: 0,
                  statusText: 'Skipped',
                  timeMs: 0,
                  sizeBytes: 0,
                  testResults: [],
                  testsPassed: 0,
                  testsFailed: 0,
                  errorMessage: 'Skipped due to earlier error',
                  dataRowIndex,
                  hasCapturedExchange: false,
                  timestamp: Date.now(),
                });
              }
              break outerLoop;
            }
            iterStepCount += 1;
            cursor += 1;
            continue;
          }

          const httpRes = await executePerfHttpStep(
            reqToRun,
            buildEffectiveVars(),
            abortController.signal,
            params.adapter,
            network,
            true,
            effectiveConfig.persistResponses
          );

          if (abortController.signal.aborted && httpRes.errorCategory === 'cancelled') {
            break outerLoop;
          }

          let postScriptError: string | undefined;
          const hadTransportFailure = httpRes.status === 0 && httpRes.isError;

          if (!hadTransportFailure && postScript.trim()) {
            const postApiResp: ApiResponse = {
              status: httpRes.status,
              statusText: httpRes.statusText,
              timeMs: httpRes.timeMs,
              sizeBytes: httpRes.sizeBytes,
              headers: httpRes.headers,
              data: httpRes.data,
              timestamp: Date.now(),
            };
            const postRes = await executePostResponseScript(postScript, postApiResp, runEnv, runVars, {
              signal: abortController.signal,
              scriptExecutor,
              request: toScriptRequest(reqToRun),
              iterationData: dataRow,
            });
            runEnv = { ...postRes.environment };
            runVars = { ...postRes.variables };
            if (postRes.testResults?.length) {
              mergedTestResults = [...mergedTestResults, ...postRes.testResults];
            }
            if (postRes.nextRequest !== undefined) {
              nextReqDirective = postRes.nextRequest;
            }
            if (!postRes.success) {
              postScriptError = postRes.error || 'Post-response script failed.';
            }
          }

          const testsPassedCount = mergedTestResults.filter((t) => t.passed).length;
          const testsFailedCount = mergedTestResults.filter((t) => !t.passed).length;

          const hasRequestOrScriptError = hadTransportFailure || Boolean(postScriptError);
          const stepStatus: FunctionalStepResult['status'] = hasRequestOrScriptError
            ? 'error'
            : testsFailedCount > 0
              ? 'failed'
              : 'passed';

          let hasCapturedExchange = false;
          let captureSkippedReason: FunctionalStepResult['captureSkippedReason'];
          if (!effectiveConfig.persistResponses) {
            captureSkippedReason = 'disabled';
          } else {
            const capRes = captureFunctionalExchange(runId, params.tabId, stepId, {
              requestMethod: reqToRun.method,
              requestUrl: httpRes.finalUrl,
              requestHeaders: httpRes.requestHeaders || {},
              requestBody: httpRes.requestBody,
              responseHeaders: httpRes.headers || {},
              responseBody: httpRes.data || '',
              dataRow,
            });
            hasCapturedExchange = capRes.captured;
            if (!capRes.captured) {
              captureSkippedReason = capRes.reason;
              captureBudgetExhausted = true;
            }
          }

          steps.push({
            id: stepId,
            iteration: iterationNum,
            stepIndex: iterStepCount,
            itemId: item.itemId,
            name: item.name,
            method: reqToRun.method,
            url: httpRes.finalUrl,
            status: stepStatus,
            httpStatus: httpRes.status,
            statusText: httpRes.statusText,
            timeMs: httpRes.timeMs,
            sizeBytes: httpRes.sizeBytes,
            testResults: mergedTestResults,
            testsPassed: testsPassedCount,
            testsFailed: testsFailedCount,
            errorMessage: hadTransportFailure ? httpRes.errorMessage : undefined,
            scriptError: postScriptError,
            scriptErrorStage: postScriptError ? 'post-response' : undefined,
            nextRequestTarget: nextReqDirective,
            dataRowIndex,
            hasCapturedExchange,
            captureSkippedReason,
            timestamp: Date.now(),
          });

          const shouldStopOnThisStep =
            (effectiveConfig.stopOnError === 'request_or_script_error' && hasRequestOrScriptError) ||
            (effectiveConfig.stopOnError === 'failed_test' && (hasRequestOrScriptError || testsFailedCount > 0));

          if (shouldStopOnThisStep) {
            stopReason = hasRequestOrScriptError
              ? `Stopped on ${hadTransportFailure ? 'request' : 'script'} error in "${item.name}".`
              : `Stopped on failed test assertion in "${item.name}".`;
            for (let rem = cursor + 1; rem < selectedItems.length; rem++) {
              const remItem = selectedItems[rem];
              steps.push({
                id: `${runId}_i${iterationNum}_skip_${rem}`,
                iteration: iterationNum,
                stepIndex: iterStepCount + (rem - cursor),
                itemId: remItem.itemId,
                name: remItem.name,
                method: remItem.request.method,
                url: remItem.request.url || '',
                status: 'skipped',
                httpStatus: 0,
                statusText: 'Skipped',
                timeMs: 0,
                sizeBytes: 0,
                testResults: [],
                testsPassed: 0,
                testsFailed: 0,
                errorMessage: 'Skipped due to Stop run on error',
                dataRowIndex,
                hasCapturedExchange: false,
                timestamp: Date.now(),
              });
            }
            params.onUpdate(
              recomputeReportMetrics(
                { ...baseReport, completedIterations, stopReason, captureBudgetExhausted },
                steps,
                startedAt
              )
            );
            break outerLoop;
          }

          params.onUpdate(
            recomputeReportMetrics(
              { ...baseReport, completedIterations, captureBudgetExhausted },
              steps,
              startedAt
            )
          );

          iterStepCount += 1;

          if (nextReqDirective === null) {
            break;
          }
          if (typeof nextReqDirective === 'string') {
            const targetIdx = resolveNextStepIndex(selectedItems, nextReqDirective);
            if (targetIdx < 0) {
              stopReason = `setNextRequest("${nextReqDirective}") could not find a matching selected request.`;
              break outerLoop;
            }
            cursor = targetIdx;
          } else {
            cursor += 1;
          }

          if (safeDelayMs > 0 && cursor < selectedItems.length) {
            await abortableDelay(safeDelayMs, abortController.signal);
          }
        }

        completedIterations = iterationNum;
        if (safeDelayMs > 0 && iterIdx + 1 < safeIterations && !abortController.signal.aborted) {
          await abortableDelay(safeDelayMs, abortController.signal);
        }
      }

      let updatedEnvVars: string[] | undefined;
      if (effectiveConfig.keepVariableValues && params.onCommitEnvironmentUpdates) {
        const unsetKeys = Object.keys(params.initialVariables).filter(
          (k) => !Object.prototype.hasOwnProperty.call(runEnv, k)
        );
        const committed = params.onCommitEnvironmentUpdates(runEnv, unsetKeys);
        if (committed.length > 0) {
          updatedEnvVars = committed;
        }
      }

      const computed = recomputeReportMetrics(
        { ...baseReport, completedIterations, stopReason, captureBudgetExhausted },
        steps,
        startedAt
      );
      const finalStatus = stoppedByUser
        ? 'stopped'
        : stopReason || computed.requestsErrored > 0 || computed.requestsFailed > 0
          ? 'failed'
          : 'completed';

      const finalReport: FunctionalRunReport = {
        ...computed,
        status: finalStatus,
        finishedAt: Date.now(),
        durationMs: Math.max(0, Date.now() - startedAt),
        ...(updatedEnvVars ? { updatedEnvVars } : {}),
      };
      clearRunIfCurrent();
      params.onFinish(finalReport);
    } catch (err) {
      const computed = recomputeReportMetrics(
        {
          ...baseReport,
          completedIterations,
          stopReason: err instanceof Error ? err.message : String(err),
          captureBudgetExhausted,
        },
        steps,
        startedAt
      );
      clearRunIfCurrent();
      params.onFinish({
        ...computed,
        status: stoppedByUser ? 'stopped' : 'failed',
        finishedAt: Date.now(),
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    }
  })();

  return { started: true, runId };
}
