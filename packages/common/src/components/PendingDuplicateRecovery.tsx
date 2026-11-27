'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
import { useApiStore } from '../store/useApiStore';
import { useProductPolicy } from '../context';
import { DuplicateActionResult, PendingDuplicateIntent } from '../types/api';
import { getOwnedPendingDuplicateIntents, getPendingDuplicateOwnerKey } from '../lib/duplicate';

interface RecoveryOutcome {
  ownerKey: string | null;
  operationId: string;
  kind: 'committed' | 'committed_partial' | 'deleted' | 'uncertain' | 'rejected';
  label: string;
  detail: string;
}

function describeIntentLabel(intent: PendingDuplicateIntent): string {
  if (intent.sourceName) return intent.sourceName;
  if (intent.sanitizedPayload?.name) return intent.sanitizedPayload.name;
  if (intent.kind === 'item') return intent.sourceItemId || 'Saved item';
  return intent.sourceCollectionId || 'Collection';
}

function describeIntentTarget(intent: PendingDuplicateIntent): string {
  if (intent.kind === 'item') {
    return intent.targetCollectionName || intent.targetCollectionId || 'Target collection';
  }
  return intent.targetScope?.name || 'Cloud workspace';
}

function mapRecoveryOutcome(
  ownerKey: string | null,
  intent: PendingDuplicateIntent,
  res: DuplicateActionResult,
): RecoveryOutcome {
  const label = res.name || describeIntentLabel(intent);
  if (res.success) {
    if (res.deletedOnServer) {
      return {
        ownerKey,
        operationId: intent.operationId,
        kind: 'deleted',
        label,
        detail: 'Deleted or expired on server; no extra copy created.',
      };
    }
    if (res.detailsUnavailable) {
      return {
        ownerKey,
        operationId: intent.operationId,
        kind: 'committed_partial',
        label,
        detail: `Committed on server, but details are unavailable (${res.detailsError || 'sync to load'}).`,
      };
    }
    return {
      ownerKey,
      operationId: intent.operationId,
      kind: 'committed',
      label,
      detail: 'Committed and synced.',
    };
  }
  if (res.reconcilePending) {
    return {
      ownerKey,
      operationId: intent.operationId,
      kind: 'uncertain',
      label,
      detail: res.error || 'Status still uncertain; resume again safely.',
    };
  }
  return {
    ownerKey,
    operationId: intent.operationId,
    kind: 'rejected',
    label,
    detail: res.error || 'Rejected or expired by server.',
  };
}

export const PendingDuplicateRecovery: React.FC = () => {
  const productPolicy = useProductPolicy();
  const isOfflineOnly = !productPolicy.workspace.cloud;
  const workspaceMode = useApiStore((state) => state.workspaceMode);
  const activeOfflineWorkspaceId = useApiStore((state) => state.activeOfflineWorkspaceId);
  const cloudConfig = useApiStore((state) => state.cloudConfig);
  const pendingDuplicateIntents = useApiStore((state) => state.pendingDuplicateIntents);
  const activeDuplicateOperationIds = useApiStore((state) => state.activeDuplicateOperationIds) || {};
  const retryPendingDuplicateIntent = useApiStore((state) => state.retryPendingDuplicateIntent);
  const clearPendingDuplicateIntent = useApiStore((state) => state.clearPendingDuplicateIntent);

  const [retryingOpId, setRetryingOpId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<RecoveryOutcome | null>(null);

  const ownerKey = useMemo(
    () => (isOfflineOnly ? null : getPendingDuplicateOwnerKey(cloudConfig)),
    [isOfflineOnly, cloudConfig],
  );
  const recoveryContextKey = useMemo(() => {
    if (!ownerKey) return null;
    if (!workspaceMode) return ownerKey;
    if (workspaceMode === 'offline') {
      return `${ownerKey}|offline|${activeOfflineWorkspaceId || ''}`;
    }
    const scope = cloudConfig?.activeScope;
    return `${ownerKey}|cloud|${scope ? `${scope.type}:${scope.id}` : ''}`;
  }, [ownerKey, workspaceMode, activeOfflineWorkspaceId, cloudConfig?.activeScope]);

  const sessionGenRef = useRef(0);
  const prevContextKeyRef = useRef<string | null>(recoveryContextKey);
  const contextKeyRef = useRef<string | null>(recoveryContextKey);
  const requestSeqRef = useRef(0);
  const activeAttemptRef = useRef<{ sessionGen: number; requestId: number } | null>(null);

  contextKeyRef.current = recoveryContextKey;
  if (prevContextKeyRef.current !== recoveryContextKey) {
    prevContextKeyRef.current = recoveryContextKey;
    sessionGenRef.current += 1;
    activeAttemptRef.current = null;
  }

  useEffect(() => {
    setOutcome(null);
    setRetryingOpId(null);
  }, [recoveryContextKey]);

  const workspaceContext = useMemo(
    () => ({
      workspaceMode,
      activeScope: cloudConfig?.activeScope ?? null,
      activeOfflineWorkspaceId,
    }),
    [workspaceMode, cloudConfig?.activeScope, activeOfflineWorkspaceId],
  );

  const ownedIntents = useMemo(
    () => getOwnedPendingDuplicateIntents(pendingDuplicateIntents, cloudConfig, isOfflineOnly, workspaceContext),
    [pendingDuplicateIntents, cloudConfig, isOfflineOnly, workspaceContext],
  );

  const visibleOutcome = outcome && outcome.ownerKey === recoveryContextKey ? outcome : null;

  if (ownedIntents.length === 0 && !visibleOutcome) {
    return null;
  }

  const hasAnyActiveOp =
    retryingOpId !== null ||
    ownedIntents.some((intent) => Boolean(activeDuplicateOperationIds[intent.operationId]));

  const handleResume = async (intent: PendingDuplicateIntent) => {
    if (
      retryingOpId !== null ||
      activeDuplicateOperationIds[intent.operationId] ||
      !retryPendingDuplicateIntent
    ) {
      return;
    }
    const capturedSessionGen = sessionGenRef.current;
    const capturedContextKey = contextKeyRef.current;
    const requestId = ++requestSeqRef.current;
    activeAttemptRef.current = { sessionGen: capturedSessionGen, requestId };
    setRetryingOpId(intent.operationId);
    try {
      const res = await retryPendingDuplicateIntent(intent.operationId);
      if (
        sessionGenRef.current !== capturedSessionGen ||
        contextKeyRef.current !== capturedContextKey
      ) {
        return;
      }
      setOutcome(mapRecoveryOutcome(capturedContextKey, intent, res));
    } finally {
      if (
        activeAttemptRef.current?.sessionGen === capturedSessionGen &&
        activeAttemptRef.current?.requestId === requestId &&
        sessionGenRef.current === capturedSessionGen &&
        contextKeyRef.current === capturedContextKey
      ) {
        activeAttemptRef.current = null;
        setRetryingOpId(null);
      }
    }
  };

  return (
    <div
      role="region"
      aria-label="Pending duplicate recovery"
      className="mx-2 mt-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5 space-y-2"
    >
      {ownedIntents.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>Pending Duplicates ({ownedIntents.length})</span>
            </div>
            <span className="text-[10px] text-amber-700/80 dark:text-amber-300/80">
              {hasAnyActiveOp ? 'In Progress' : 'Needs Recovery'}
            </span>
          </div>

          <div className="space-y-1.5 max-h-40 overflow-y-auto">
            {ownedIntents.map((intent) => {
              const isInFlight =
                Boolean(activeDuplicateOperationIds[intent.operationId]) ||
                retryingOpId === intent.operationId;
              const targetLabel = describeIntentTarget(intent);
              const sourceLabel = describeIntentLabel(intent);
              const kindLabel =
                intent.kind === 'item'
                  ? intent.sourceItemType === 'folder'
                    ? 'Folder'
                    : 'Request'
                  : intent.kind === 'import_duplicate'
                    ? 'Upload'
                    : 'Collection';
              const statusLabel = isInFlight
                ? 'In Progress'
                : intent.status === 'pending'
                  ? 'Pending'
                  : 'Uncertain';

              return (
                <div
                  key={intent.operationId}
                  className="rounded-lg border border-line bg-surface/90 p-2 space-y-1.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                          {kindLabel}
                        </span>
                        <span className="text-[11px] font-semibold text-tx-primary truncate">
                          {sourceLabel}
                        </span>
                      </div>
                      <div className="text-[10px] text-tx-muted truncate mt-0.5">
                        Target: {targetLabel}
                      </div>
                      {intent.lastError && (
                        <div className="text-[10px] text-rose-500 dark:text-rose-400 truncate mt-0.5">
                          {intent.lastError}
                        </div>
                      )}
                    </div>
                    <span className="shrink-0 rounded bg-element px-1.5 py-0.5 text-[9px] font-semibold text-tx-muted">
                      {statusLabel}
                    </span>
                  </div>

                  <div className="flex items-center justify-end gap-1.5">
                    <button
                      type="button"
                      disabled={isInFlight || retryingOpId !== null}
                      onClick={() => {
                        if (isInFlight || retryingOpId !== null) return;
                        clearPendingDuplicateIntent?.(intent.operationId);
                      }}
                      className="rounded-md px-2 py-1 text-[10px] font-medium text-tx-muted hover:bg-hover hover:text-tx-primary disabled:opacity-50 transition"
                    >
                      Dismiss
                    </button>
                    <button
                      type="button"
                      disabled={isInFlight || retryingOpId !== null}
                      onClick={() => void handleResume(intent)}
                      className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-2 py-1 text-[10px] font-semibold text-white hover:bg-amber-400 disabled:opacity-50 transition"
                    >
                      {isInFlight ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          <span>Resuming...</span>
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-3 w-3" />
                          <span>Resume</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {visibleOutcome && (
        <div
          role="status"
          className={`flex items-start justify-between gap-2 rounded-lg border p-2 text-[11px] ${
            visibleOutcome.kind === 'committed'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : visibleOutcome.kind === 'committed_partial' ||
                  visibleOutcome.kind === 'deleted' ||
                  visibleOutcome.kind === 'uncertain'
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                : 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300'
          }`}
        >
          <div className="flex items-start gap-1.5 min-w-0">
            {visibleOutcome.kind === 'committed' ? (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            ) : visibleOutcome.kind === 'rejected' ? (
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            )}
            <div className="min-w-0">
              <div className="font-semibold truncate">
                {visibleOutcome.kind === 'committed'
                  ? `Committed: ${visibleOutcome.label}`
                  : visibleOutcome.kind === 'committed_partial'
                    ? `Committed (Details Unavailable): ${visibleOutcome.label}`
                    : visibleOutcome.kind === 'deleted'
                      ? `Deleted / Expired: ${visibleOutcome.label}`
                      : visibleOutcome.kind === 'uncertain'
                        ? `Uncertain: ${visibleOutcome.label}`
                        : `Rejected: ${visibleOutcome.label}`}
              </div>
              <div className="text-[10px] opacity-90">{visibleOutcome.detail}</div>
            </div>
          </div>
          <button
            type="button"
            aria-label="Dismiss recovery status"
            onClick={() => setOutcome(null)}
            className="rounded p-0.5 opacity-70 hover:opacity-100 transition shrink-0"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
};
