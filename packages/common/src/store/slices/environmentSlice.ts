import type { Environment } from '../../types/api';
import type { ImportTargetBinding } from '../../lib/importBatch';
import { canModifyEnvironment, hasScopePermission } from '../../lib/jwt';
import { importPostmanEnvironment } from '../../lib/postman';
import { alignEnvironmentVariableIds } from '../../lib/requestDiff';
import { isCloudSessionActive } from '../../workspace/cloudSession';
import { getScopeCacheKey } from '../../workspace/scopeCache';
import { DEFAULT_OFFLINE_WORKSPACE_ID, type ApiStoreState } from '../storeTypes';
import {
  generateId,
  getRemoteEnvironment,
  matchesImportTarget,
  preserveCurrentValues,
  sanitizeVariablesForUpstream,
} from '../storeHelpers';
import type { StoreSliceContext, StoreSliceGet, StoreSliceSet } from '../sliceContext';

export type EnvironmentSlice = Pick<
  ApiStoreState,
  | 'setActiveEnvironmentId'
  | 'createEnvironment'
  | 'deleteEnvironment'
  | 'updateEnvironment'
  | 'addEnvironmentVariable'
  | 'updateEnvironmentVariable'
  | 'removeEnvironmentVariable'
  | 'resetEnvironmentCurrentValues'
  | 'persistEnvironmentCurrentValues'
  | 'addEnvironment'
  | 'replaceEnvironment'
  | 'importEnvironmentFromJson'
  | 'discardEnvironmentOccConflict'
  | 'overwriteEnvironmentOccConflict'
  | 'applyEnvironmentVariableUpdates'
>;

export function createEnvironmentSlice(ctx: StoreSliceContext): EnvironmentSlice {
  const { set, get, isOfflineOnly, cloudClient, refs, collections, helpers } = ctx;
  const {
    createScopeEnvironment,
    updateScopeEnvironment,
    deleteScopeEnvironment,
    fetchScopeEnvironments: fetchScopeEnvironmentsForRuntime,
  } = cloudClient;
  const {
    envSyncDebounceTimers,
    envSyncInFlight,
    envSyncQueued,
    envIdAliasMap,
    pendingEnvCreatePromises,
    pendingEnvEditedWhileCreating,
  } = collections;
  const {
    beginAsyncOperation,
    completeAsyncOperation,
    isAsyncOperationCurrent,
    flushStorePersistence,
  } = helpers;

  function resolveCanonicalEnvId(envId: string): string {
    return envIdAliasMap.get(envId) || envId;
  }

  function isCloudEnvSyncActive(state: Pick<ApiStoreState, 'workspaceMode' | 'cloudConfig'>): boolean {
    return !isOfflineOnly && !refs.isStoreDisposed && state.workspaceMode === 'cloud' && isCloudSessionActive(state.cloudConfig);
  }

  function dispatchCloudEnvironmentCreate(
    newEnv: Environment,
    scope: NonNullable<ApiStoreState['cloudConfig']['activeScope']>,
    initialStamp: number,
    getState: StoreSliceGet,
    setState: StoreSliceSet,
  ): void {
    const operation = beginAsyncOperation();
    const liveCloud = getState().cloudConfig;
    const createPromise = createScopeEnvironment(
      liveCloud.apiUrl,
      liveCloud.token,
      scope,
      {
        name: newEnv.name,
        variables: sanitizeVariablesForUpstream(newEnv.variables),
        min_role: newEnv.minRole || 'reader',
      },
      liveCloud.refreshToken,
      operation.controller.signal
    ).then((created) => {
      if (!isAsyncOperationCurrent(operation)) return null;
      if (created && created.id) {
        envIdAliasMap.set(newEnv.id, created.id);
        if (envSyncDebounceTimers[newEnv.id]) {
          clearTimeout(envSyncDebounceTimers[newEnv.id]);
          delete envSyncDebounceTimers[newEnv.id];
        }
        const latestLocalEnv = getState().environments.find((e) => e.id === newEnv.id);
        const editedWhileCreating = Boolean(
          pendingEnvEditedWhileCreating.has(newEnv.id) ||
          (latestLocalEnv && latestLocalEnv.updatedAt > initialStamp)
        );
        pendingEnvEditedWhileCreating.delete(newEnv.id);
        setState((state) => {
          if (!isAsyncOperationCurrent(operation)) return {};
          return {
            environments: state.environments.map((e) =>
              e.id === newEnv.id
                ? {
                    ...e,
                    id: created.id,
                    version: created.version || 1,
                    _syncStatus: editedWhileCreating ? 'pending' : 'synced',
                    _pendingCreate: undefined,
                  }
                : e
            ),
            activeEnvironmentId: state.activeEnvironmentId === newEnv.id ? created.id : state.activeEnvironmentId,
          };
        });
        if (editedWhileCreating) {
          scheduleEnvironmentCloudSync(created.id, getState, setState);
        }
        return created.id;
      }
      pendingEnvEditedWhileCreating.delete(newEnv.id);
      return null;
    }).catch((err) => {
      pendingEnvEditedWhileCreating.delete(newEnv.id);
      if (!isAsyncOperationCurrent(operation)) return null;
      console.error('Failed to sync created environment to cloud:', err);
      return null;
    }).finally(() => {
      if (pendingEnvCreatePromises.get(newEnv.id) === createPromise) {
        pendingEnvCreatePromises.delete(newEnv.id);
      }
      completeAsyncOperation(operation);
    });
    pendingEnvCreatePromises.set(newEnv.id, createPromise);
  }

  function scheduleEnvironmentCloudSync(
    rawEnvId: string,
    getState: StoreSliceGet,
    setState: StoreSliceSet,
  ) {
    if (isOfflineOnly || refs.isStoreDisposed) return;

    const initialEnvId = resolveCanonicalEnvId(rawEnvId);
    if (envSyncDebounceTimers[initialEnvId]) {
      clearTimeout(envSyncDebounceTimers[initialEnvId]);
      delete envSyncDebounceTimers[initialEnvId];
    }

    envSyncDebounceTimers[initialEnvId] = setTimeout(async () => {
      delete envSyncDebounceTimers[initialEnvId];

      const inFlightCreate = pendingEnvCreatePromises.get(rawEnvId) || pendingEnvCreatePromises.get(initialEnvId);
      if (inFlightCreate) {
        await inFlightCreate.catch(() => null);
      }

      if (refs.isStoreDisposed) return;
      const envId = resolveCanonicalEnvId(initialEnvId);
      const { workspaceMode, cloudConfig } = getState();
      if (workspaceMode !== 'cloud' || !isCloudSessionActive(cloudConfig)) return;

      if (envSyncInFlight[envId]) {
        envSyncQueued[envId] = true;
        return;
      }

      const executeSync = async () => {
        if (refs.isStoreDisposed) return;
        const state = getState();
        if (state.workspaceMode !== 'cloud' || !isCloudSessionActive(state.cloudConfig)) return;

        const currentEnv = state.environments.find((e) => e.id === envId);
        if (!currentEnv) return;

        if (currentEnv._pendingCreate && envId === rawEnvId && !envIdAliasMap.has(rawEnvId)) {
          return;
        }

        envSyncInFlight[envId] = true;
        const syncStartedAt = currentEnv.updatedAt;
        const operation = beginAsyncOperation();
        try {
          const liveCloud = getState().cloudConfig;
          const res = await updateScopeEnvironment(
            liveCloud.apiUrl,
            liveCloud.token,
            envId,
            {
              name: currentEnv.name,
              variables: sanitizeVariablesForUpstream(currentEnv.variables),
              min_role: currentEnv.minRole,
              base_version: currentEnv.version || 1,
            },
            liveCloud.refreshToken,
            operation.controller.signal
          );

          if (!isAsyncOperationCurrent(operation)) return;

          if (res && typeof res.version === 'number') {
            setState((s) => {
              if (!isAsyncOperationCurrent(operation)) return {};
              return {
                environments: s.environments.map((e) =>
                  e.id === envId
                    ? { ...e, version: res.version, _syncStatus: e.updatedAt > syncStartedAt ? 'pending' : 'synced' }
                    : e
                ),
              };
            });
          }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
          if (!isAsyncOperationCurrent(operation)) return;
          if (err?.status === 409) {
            const remote = getRemoteEnvironment(err.data);
            console.warn('Environment sync conflict requires explicit resolution:', err);
            setState((currentState) => {
              if (!isAsyncOperationCurrent(operation)) return {};
              return {
                syncStatus: 'error',
                syncError: 'Environment changes conflict with a newer server version. Review the conflict before saving again.',
                environmentOccConflict: remote
                  ? { local: currentState.environments.find((environment) => environment.id === envId) || currentEnv, remote }
                  : null,
              };
            });
            return;
          }
          setState((currentState) => {
            if (!isAsyncOperationCurrent(operation)) return {};
            return {
              environments: currentState.environments.map((e) =>
                e.id === envId ? { ...e, _syncStatus: 'pending' as const } : e
              ),
            };
          });
          console.error('Failed to sync updated environment to cloud:', err);
        } finally {
          completeAsyncOperation(operation);
          delete envSyncInFlight[envId];
          if (envSyncQueued[envId]) {
            delete envSyncQueued[envId];
            void executeSync();
          }
        }
      };

      await executeSync();
    }, 1200);
  }

  helpers.resolveCanonicalEnvId = resolveCanonicalEnvId;
  helpers.isCloudEnvSyncActive = isCloudEnvSyncActive;
  helpers.dispatchCloudEnvironmentCreate = dispatchCloudEnvironmentCreate;
  helpers.scheduleEnvironmentCloudSync = scheduleEnvironmentCloudSync;

  return {
    setActiveEnvironmentId: (activeEnvironmentId) =>
      set({ activeEnvironmentId }),

    createEnvironment: (name, minRole = 'reader') => {
      const { workspaceMode, cloudConfig } = get();
      let effectiveMinRole = minRole;
      if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
        if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role)) {
          console.warn('User lacks permission to create environment in this scope');
          return '';
        }
        if (effectiveMinRole && !canModifyEnvironment(effectiveMinRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          effectiveMinRole = 'reader';
        }
      }

      const isCloudCreate = workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && Boolean(cloudConfig.activeScope);
      const initialStamp = Date.now();
      const newEnv: Environment = {
        id: generateId(),
        name: name.trim() || 'New Environment',
        variables: [{ id: generateId(), key: '', value: '', initialValue: '', currentValue: '', enabled: true }],
        minRole: effectiveMinRole,
        version: 1,
        createdAt: initialStamp,
        updatedAt: initialStamp,
        ...(isCloudCreate ? { _syncStatus: 'pending' as const, _pendingCreate: true } : {}),
      };
      set((state) => ({
        environments: [...state.environments, newEnv],
        activeEnvironmentId: newEnv.id,
      }));

      if (isCloudCreate) {
        dispatchCloudEnvironmentCreate(newEnv, cloudConfig.activeScope!, initialStamp, get, set);
      }

      return newEnv.id;
    },

    deleteEnvironment: (id) => {
      const resolvedAtCall = resolveCanonicalEnvId(id);
      const { workspaceMode, cloudConfig, environments } = get();
      const env = environments.find((e) => e.id === id || e.id === resolvedAtCall);
      if (env && workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
        if (!hasScopePermission(cloudConfig.activeScope, 'env:delete', workspaceMode, cloudConfig.user?.role) ||
          !canModifyEnvironment(env.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          console.warn(`User lacks permission to delete environment "${env.name}"`);
          return;
        }
      }

      for (const key of [id, resolvedAtCall]) {
        if (envSyncDebounceTimers[key]) {
          clearTimeout(envSyncDebounceTimers[key]);
          delete envSyncDebounceTimers[key];
        }
      }

      set((state) => ({
        environments: state.environments.filter((e) => e.id !== id && e.id !== resolvedAtCall),
        activeEnvironmentId:
          state.activeEnvironmentId === id || state.activeEnvironmentId === resolvedAtCall
            ? null
            : state.activeEnvironmentId,
      }));

      if (workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig)) {
        const operation = beginAsyncOperation();
        void (async () => {
          try {
            const inFlightCreate = pendingEnvCreatePromises.get(id) || pendingEnvCreatePromises.get(resolvedAtCall);
            if (inFlightCreate) {
              await inFlightCreate.catch(() => null);
            }
            if (!isAsyncOperationCurrent(operation)) return;
            const targetEnvId = resolveCanonicalEnvId(id);
            if (env?._pendingCreate && targetEnvId === id && !envIdAliasMap.has(id)) {
              return;
            }
            const liveCloud = get().cloudConfig;
            await deleteScopeEnvironment(
              liveCloud.apiUrl,
              liveCloud.token,
              targetEnvId,
              liveCloud.refreshToken,
              operation.controller.signal
            );
          } catch (err) {
            if (!isAsyncOperationCurrent(operation)) return;
            console.error('Failed to delete environment from cloud:', err);
          } finally {
            completeAsyncOperation(operation);
          }
        })();
      }
    },

    updateEnvironment: (id, updates) => {
      const { workspaceMode, cloudConfig, environments } = get();
      const env = environments.find((e) => e.id === id);
      if (env && workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
        if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role) ||
          !canModifyEnvironment(env.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          console.warn(`User lacks permission to update environment "${env.name}"`);
          return;
        }
        if (updates.minRole && !canModifyEnvironment(updates.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          console.warn(`User lacks permission to assign minRole "${updates.minRole}" to environment "${env.name}"`);
          return;
        }
      }

      const pendingPatch = isCloudEnvSyncActive(get()) ? ({ _syncStatus: 'pending' as const }) : {};
      set((state) => ({
        environments: state.environments.map((e) => {
          if (e.id === id) {
            if (e._pendingCreate) pendingEnvEditedWhileCreating.add(e.id);
            return { ...e, ...updates, ...pendingPatch, updatedAt: Date.now() };
          }
          return e;
        }),
      }));

      scheduleEnvironmentCloudSync(id, get, set);
    },

    addEnvironmentVariable: (envId) => {
      const { workspaceMode, cloudConfig, environments } = get();
      const env = environments.find((e) => e.id === envId);
      if (env && workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
        if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role) ||
          !canModifyEnvironment(env.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          console.warn('User lacks permission to modify environments in this scope');
          return;
        }
      }

      const pendingPatch = isCloudEnvSyncActive(get()) ? ({ _syncStatus: 'pending' as const }) : {};
      set((state) => ({
        environments: state.environments.map((e) => {
          if (e.id !== envId) return e;
          if (e._pendingCreate) pendingEnvEditedWhileCreating.add(e.id);
          return {
            ...e,
            ...pendingPatch,
            variables: [
              ...e.variables,
              { id: generateId(), key: '', value: '', initialValue: '', currentValue: '', enabled: true },
            ],
            updatedAt: Date.now(),
          };
        }),
      }));

      scheduleEnvironmentCloudSync(envId, get, set);
    },

    updateEnvironmentVariable: (envId, varId, updates) => {
      const updateKeys = Object.keys(updates);
      const isOnlyCurrentValue = updateKeys.length === 1 && updateKeys[0] === 'currentValue';

      if (!isOnlyCurrentValue) {
        const { workspaceMode, cloudConfig, environments } = get();
        const env = environments.find((e) => e.id === envId);
        if (env && workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role) ||
            !canModifyEnvironment(env.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
            console.warn('User lacks permission to modify environments in this scope');
            return;
          }
        }
      }

      const pendingPatch = !isOnlyCurrentValue && isCloudEnvSyncActive(get()) ? ({ _syncStatus: 'pending' as const }) : {};
      set((state) => ({
        environments: state.environments.map((e) => {
          if (e.id !== envId) return e;
          if (!isOnlyCurrentValue && e._pendingCreate) pendingEnvEditedWhileCreating.add(e.id);
          return {
            ...e,
            ...pendingPatch,
            variables: e.variables.map((v) => {
              if (v.id !== varId) return v;
              const next = { ...v, ...updates };
              if (updates.initialValue !== undefined) {
                next.value = updates.initialValue;
              }
              return next;
            }),
            updatedAt: Date.now(),
          };
        }),
      }));

      if (!isOnlyCurrentValue) {
        scheduleEnvironmentCloudSync(envId, get, set);
      }
    },

    removeEnvironmentVariable: (envId, varId) => {
      const { workspaceMode, cloudConfig, environments } = get();
      const env = environments.find((e) => e.id === envId);
      if (env && workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
        if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role) ||
          !canModifyEnvironment(env.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          console.warn('User lacks permission to modify environments in this scope');
          return;
        }
      }

      const pendingPatch = isCloudEnvSyncActive(get()) ? ({ _syncStatus: 'pending' as const }) : {};
      set((state) => ({
        environments: state.environments.map((e) => {
          if (e.id !== envId) return e;
          if (e._pendingCreate) pendingEnvEditedWhileCreating.add(e.id);
          return {
            ...e,
            ...pendingPatch,
            variables: e.variables.filter((v) => v.id !== varId),
            updatedAt: Date.now(),
          };
        }),
      }));

      scheduleEnvironmentCloudSync(envId, get, set);
    },

    resetEnvironmentCurrentValues: (envId) => {
      set((state) => ({
        environments: state.environments.map((e) => {
          if (e.id !== envId) return e;
          return {
            ...e,
            variables: e.variables.map((v) => ({
              ...v,
              currentValue: v.initialValue ?? v.value ?? '',
            })),
            updatedAt: Date.now(),
          };
        }),
      }));
    },

    persistEnvironmentCurrentValues: (envId) => {
      const { workspaceMode, cloudConfig, environments } = get();
      const env = environments.find((e) => e.id === envId);
      if (env && workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
        if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role) ||
          !canModifyEnvironment(env.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          console.warn('User lacks permission to modify environments in this scope');
          return;
        }
      }

      const pendingPatch = isCloudEnvSyncActive(get()) ? ({ _syncStatus: 'pending' as const }) : {};
      set((state) => ({
        environments: state.environments.map((e) => {
          if (e.id !== envId) return e;
          if (e._pendingCreate) pendingEnvEditedWhileCreating.add(e.id);
          return {
            ...e,
            ...pendingPatch,
            variables: e.variables.map((v) => {
              const effective = v.currentValue ?? v.initialValue ?? v.value ?? '';
              return {
                ...v,
                initialValue: effective,
                value: effective,
              };
            }),
            updatedAt: Date.now(),
          };
        }),
      }));

      scheduleEnvironmentCloudSync(envId, get, set);
    },

    addEnvironment: async (env: Environment, options?: { target?: ImportTargetBinding; isRetry?: boolean }) => {
      if (options?.target && !matchesImportTarget(get(), options.target, refs.cloudSessionGeneration)) {
        throw new Error('Workspace changed before environment import could be applied.');
      }

      const { workspaceMode, cloudConfig } = get();
      if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
        if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role)) {
          console.warn('User lacks permission to add environment in this scope');
          throw new Error('Insufficient permission to add environments in this scope (requires env:write).');
        }
      }

      const isCloud = workspaceMode === 'cloud';
      const taggedEnv: Environment = {
        ...env,
        _syncStatus: isCloud ? 'pending' : 'synced',
        ...(isCloud ? { _pendingCreate: true } : {}),
      };

      set((state) => {
        const exists = state.environments.some((e) => e.id === taggedEnv.id);
        const nextEnvironments = exists
          ? state.environments.map((e) => (e.id === taggedEnv.id ? taggedEnv : e))
          : [...state.environments, taggedEnv];
        const localId = state.activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID;
        const nextOfflineCache =
          state.workspaceMode === 'offline'
            ? {
              ...(state.offlineScopeCache || {}),
              [localId]: {
                collections: state.collections,
                tabs: state.tabs,
                activeTabId: state.activeTabId,
                history: state.history,
                ...(state.offlineScopeCache?.[localId] || {}),
                environments: nextEnvironments,
                activeEnvironmentId: taggedEnv.id,
              },
            }
            : state.offlineScopeCache;
        return {
          environments: nextEnvironments,
          activeEnvironmentId: taggedEnv.id,
          offlineScopeCache: nextOfflineCache,
        };
      });

      if (!isOfflineOnly && isCloud && isCloudSessionActive(cloudConfig) && cloudConfig.activeScope) {
        const operation = beginAsyncOperation();
        const targetScope = cloudConfig.activeScope;
        const capturedSessionGen = refs.cloudSessionGeneration;
        const isSameTargetScope = () => {
          const live = get();
          return (
            !refs.isStoreDisposed &&
            refs.cloudSessionGeneration === capturedSessionGen &&
            live.workspaceMode === 'cloud' &&
            live.cloudConfig.activeScope?.id === targetScope.id &&
            live.cloudConfig.activeScope?.type === targetScope.type
          );
        };
        const reconcileEnvToTargetScope = (remoteId: string, remoteVersion: number) => {
          if (refs.isStoreDisposed || refs.cloudSessionGeneration !== capturedSessionGen) return;
          envIdAliasMap.set(taggedEnv.id, remoteId);
          if (isSameTargetScope()) {
            set((state) => ({
              environments: state.environments.map((e) =>
                e.id === taggedEnv.id
                  ? { ...e, id: remoteId, version: remoteVersion, _syncStatus: 'synced', _pendingCreate: undefined }
                  : e
              ),
              activeEnvironmentId: state.activeEnvironmentId === taggedEnv.id ? remoteId : state.activeEnvironmentId,
            }));
            return;
          }
          const targetKey = getScopeCacheKey(targetScope);
          set((state) => {
            const cached = state.scopeCache?.[targetKey];
            if (!cached) return {};
            return {
              scopeCache: {
                ...state.scopeCache,
                [targetKey]: {
                  ...cached,
                  environments: (cached.environments || []).map((e) =>
                    e.id === taggedEnv.id
                      ? { ...e, id: remoteId, version: remoteVersion, _syncStatus: 'synced', _pendingCreate: undefined }
                      : e
                  ),
                  activeEnvironmentId: cached.activeEnvironmentId === taggedEnv.id ? remoteId : cached.activeEnvironmentId,
                },
              },
            };
          });
        };
        try {
          if (options?.isRetry) {
            const liveCloudRetry = get().cloudConfig;
            const remoteEnvs = await fetchScopeEnvironmentsForRuntime(
              liveCloudRetry.apiUrl,
              liveCloudRetry.token,
              targetScope,
              liveCloudRetry.refreshToken,
              operation.controller.signal
            );
            if (refs.isStoreDisposed || refs.cloudSessionGeneration !== capturedSessionGen) return taggedEnv.id;
            const normalizedName = String(taggedEnv.name ?? '').trim().toLowerCase();
            const matchedRemote = (remoteEnvs || []).find(
              (re) => String(re?.name ?? '').trim().toLowerCase() === normalizedName
            );
            if (matchedRemote?.id) {
              const localPayload = JSON.stringify(sanitizeVariablesForUpstream(taggedEnv.variables));
              const remotePayload = JSON.stringify(sanitizeVariablesForUpstream(matchedRemote.variables || []));
              if (localPayload !== remotePayload) {
                throw new Error(
                  `An environment named "${taggedEnv.name}" already exists on the server with different variables.`
                );
              }
              reconcileEnvToTargetScope(matchedRemote.id, matchedRemote.version || 1);
              if (isSameTargetScope() && isAsyncOperationCurrent(operation)) {
                await flushStorePersistence();
              }
              return matchedRemote.id;
            }
            if (!isAsyncOperationCurrent(operation) || operation.controller.signal.aborted) {
              if (isSameTargetScope()) {
                throw new Error('Import operation was cancelled before completion.');
              }
              return taggedEnv.id;
            }
          }

          const liveCloudCreate = get().cloudConfig;
          const created = await createScopeEnvironment(
            liveCloudCreate.apiUrl,
            liveCloudCreate.token,
            targetScope,
            {
              name: taggedEnv.name,
              variables: sanitizeVariablesForUpstream(taggedEnv.variables),
              min_role: taggedEnv.minRole || 'reader',
            },
            liveCloudCreate.refreshToken,
            operation.controller.signal
          );
          if (refs.isStoreDisposed || refs.cloudSessionGeneration !== capturedSessionGen) return taggedEnv.id;
          if (created && created.id) {
            reconcileEnvToTargetScope(created.id, created.version || 1);
            if (isSameTargetScope() && isAsyncOperationCurrent(operation)) {
              await flushStorePersistence();
            }
            return created.id;
          }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
          if (!isAsyncOperationCurrent(operation) || operation.controller.signal.aborted) {
            if (isSameTargetScope()) {
              throw new Error('Import operation was cancelled before completion.');
            }
            return taggedEnv.id;
          }
          if (!isSameTargetScope()) return taggedEnv.id;
          console.error('Failed to sync environment to cloud:', err);
          set((state) => ({
            environments: state.environments.map((e) =>
              e.id === taggedEnv.id ? { ...e, _syncStatus: 'pending', _pendingCreate: true } : e
            ),
            syncStatus: 'error',
            syncError: err.message || 'Failed to sync environment to cloud',
          }));
          throw err;
        } finally {
          completeAsyncOperation(operation);
        }
      }
      await flushStorePersistence();
      return taggedEnv.id;
    },

    replaceEnvironment: async (existingId: string, incomingEnv: Environment, options?: { target?: ImportTargetBinding }) => {
      if (options?.target && !matchesImportTarget(get(), options.target, refs.cloudSessionGeneration)) {
        throw new Error('Workspace changed before environment replacement could be applied.');
      }

      const { workspaceMode, cloudConfig } = get();
      const state = get();
      const existingEnv = state.environments.find((e) => e.id === existingId);
      if (!existingEnv) {
        throw new Error('Existing environment not found');
      }

      if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
        if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role) ||
          !canModifyEnvironment(existingEnv.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          throw new Error('Insufficient permission to modify environments in this scope (requires env:write and adequate role)');
        }
      }

      if (envSyncDebounceTimers[existingId]) {
        clearTimeout(envSyncDebounceTimers[existingId]);
        delete envSyncDebounceTimers[existingId];
      }

      const alignedVars = alignEnvironmentVariableIds(existingEnv.variables || [], incomingEnv.variables || []);

      let effectiveMinRole = incomingEnv.minRole || existingEnv.minRole;
      if (incomingEnv.minRole && incomingEnv.minRole !== existingEnv.minRole && workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
        if (!canModifyEnvironment(incomingEnv.minRole, cloudConfig.activeScope, workspaceMode, cloudConfig.user?.role)) {
          effectiveMinRole = existingEnv.minRole;
        }
      }

      const wasPendingLocalCreate = Boolean(existingEnv._pendingCreate);
      const isCloud = workspaceMode === 'cloud';
      const replacedEnv: Environment = {
        ...incomingEnv,
        id: existingId,
        name: incomingEnv.name,
        variables: alignedVars,
        minRole: effectiveMinRole,
        version: existingEnv.version || 1,
        _syncStatus: isCloud ? 'pending' : 'synced',
        _pendingCreate: isCloud && wasPendingLocalCreate ? true : undefined,
        updatedAt: Date.now(),
      };

      set((s) => {
        const nextEnvironments = s.environments.map((e) => (e.id === existingId ? replacedEnv : e));
        const localId = s.activeOfflineWorkspaceId || DEFAULT_OFFLINE_WORKSPACE_ID;
        const nextOfflineCache =
          s.workspaceMode === 'offline'
            ? {
              ...(s.offlineScopeCache || {}),
              [localId]: {
                collections: s.collections,
                tabs: s.tabs,
                activeTabId: s.activeTabId,
                history: s.history,
                ...(s.offlineScopeCache?.[localId] || {}),
                environments: nextEnvironments,
                activeEnvironmentId: existingId,
              },
            }
            : s.offlineScopeCache;
        return {
          environments: nextEnvironments,
          activeEnvironmentId: existingId,
          offlineScopeCache: nextOfflineCache,
        };
      });

      if (!isOfflineOnly && isCloud && isCloudSessionActive(cloudConfig) && cloudConfig.activeScope) {
        const operation = beginAsyncOperation();
        const targetScope = cloudConfig.activeScope;
        const capturedSessionGen = refs.cloudSessionGeneration;
        const isSameTargetScope = () => {
          const live = get();
          return (
            !refs.isStoreDisposed &&
            refs.cloudSessionGeneration === capturedSessionGen &&
            live.workspaceMode === 'cloud' &&
            live.cloudConfig.activeScope?.id === targetScope.id &&
            live.cloudConfig.activeScope?.type === targetScope.type
          );
        };
        const reconcileReplacedEnv = (remoteId: string, remoteVersion: number) => {
          if (refs.isStoreDisposed || refs.cloudSessionGeneration !== capturedSessionGen) return;
          if (isSameTargetScope()) {
            set((s) => ({
              environments: s.environments.map((e) =>
                e.id === existingId ? { ...e, id: remoteId, version: remoteVersion, _syncStatus: 'synced', _pendingCreate: undefined } : e
              ),
              activeEnvironmentId: s.activeEnvironmentId === existingId ? remoteId : s.activeEnvironmentId,
            }));
          } else {
            const targetKey = getScopeCacheKey(targetScope);
            set((s) => {
              const cached = s.scopeCache?.[targetKey];
              if (!cached) return {};
              return {
                scopeCache: {
                  ...s.scopeCache,
                  [targetKey]: {
                    ...cached,
                    environments: (cached.environments || []).map((e) =>
                      e.id === existingId ? { ...e, id: remoteId, version: remoteVersion, _syncStatus: 'synced', _pendingCreate: undefined } : e
                    ),
                    activeEnvironmentId: cached.activeEnvironmentId === existingId ? remoteId : cached.activeEnvironmentId,
                  },
                },
              };
            });
          }
        };
        try {
          if (wasPendingLocalCreate) {
            const created = await createScopeEnvironment(
              cloudConfig.apiUrl,
              cloudConfig.token,
              targetScope,
              {
                name: replacedEnv.name,
                variables: sanitizeVariablesForUpstream(replacedEnv.variables),
                min_role: replacedEnv.minRole || 'reader',
              },
              cloudConfig.refreshToken,
              operation.controller.signal
            );
            if (refs.isStoreDisposed || refs.cloudSessionGeneration !== capturedSessionGen) return;
            if (created && created.id) {
              reconcileReplacedEnv(created.id, created.version || 1);
            }
            if (!isSameTargetScope() || !isAsyncOperationCurrent(operation)) return;
          } else {
            const res = await updateScopeEnvironment(
              cloudConfig.apiUrl,
              cloudConfig.token,
              existingId,
              {
                name: replacedEnv.name,
                variables: sanitizeVariablesForUpstream(replacedEnv.variables),
                min_role: replacedEnv.minRole,
                base_version: replacedEnv.version || 1,
              },
              cloudConfig.refreshToken,
              operation.controller.signal
            );
            if (refs.isStoreDisposed || refs.cloudSessionGeneration !== capturedSessionGen) return;
            const nextVersion = res && typeof res.version === 'number' ? res.version : (replacedEnv.version || 1);
            reconcileReplacedEnv(existingId, nextVersion);
            if (!isSameTargetScope() || !isAsyncOperationCurrent(operation)) return;
          }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
          if (!isAsyncOperationCurrent(operation) || operation.controller.signal.aborted) {
            if (isSameTargetScope()) {
              throw new Error('Import operation was cancelled before completion.');
            }
            return;
          }
          if (!isSameTargetScope()) return;
          if (err?.status === 409) {
            const remote = getRemoteEnvironment(err.data);
            set((_state) => {
              if (!isAsyncOperationCurrent(operation) || !isSameTargetScope()) return {};
              return {
                syncStatus: 'error',
                syncError: 'Environment changes conflict with a newer server version. Review the conflict before saving again.',
                environmentOccConflict: remote ? { local: replacedEnv, remote } : null,
              };
            });
          }
          console.error('Failed to sync replaced environment to cloud:', err);
          throw err;
        } finally {
          completeAsyncOperation(operation);
        }
      }
      await flushStorePersistence();
    },

    importEnvironmentFromJson: (jsonStr) => {
      try {
        const { workspaceMode, cloudConfig } = get();
        if (workspaceMode === 'cloud' && cloudConfig.activeScope?.type === 'project') {
          if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role)) {
            return { success: false, error: 'Insufficient permission to import environments into this scope (requires env:write)' };
          }
        }

        const baseImported = importPostmanEnvironment(jsonStr);
        const isCloudCreate = workspaceMode === 'cloud' && isCloudSessionActive(cloudConfig) && Boolean(cloudConfig.activeScope);
        const initialStamp = Date.now();
        const imported: Environment = isCloudCreate
          ? {
              ...baseImported,
              updatedAt: initialStamp,
              _syncStatus: 'pending' as const,
              _pendingCreate: true,
            }
          : baseImported;
        set((state) => ({
          environments: [...state.environments, imported],
          activeEnvironmentId: imported.id,
        }));

        if (isCloudCreate) {
          dispatchCloudEnvironmentCreate(imported, cloudConfig.activeScope!, initialStamp, get, set);
        }

        return { success: true, environment: imported };
      } catch (err: unknown) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to parse Postman environment',
        };
      }
    },

    discardEnvironmentOccConflict: () => {
      const conflict = get().environmentOccConflict;
      if (!conflict) return;
      const resolved = preserveCurrentValues(conflict.remote, conflict.local);
      set((state) => ({
        environments: state.environments.map((environment) => environment.id === resolved.id ? resolved : environment),
        environmentOccConflict: null,
        syncStatus: 'idle',
        syncError: null,
      }));
    },

    overwriteEnvironmentOccConflict: async () => {
      const state = get();
      const conflict = state.environmentOccConflict;
      const { cloudConfig, workspaceMode } = state;
      if (!conflict || workspaceMode !== 'cloud' || !isCloudSessionActive(cloudConfig) || !cloudConfig.activeScope) return;
      if (!hasScopePermission(cloudConfig.activeScope, 'env:write', workspaceMode, cloudConfig.user?.role)) {
        set({ syncStatus: 'error', syncError: 'You no longer have permission to update this environment.' });
        return;
      }
      const operation = beginAsyncOperation();
      try {
        const response = await updateScopeEnvironment(
          cloudConfig.apiUrl,
          cloudConfig.token,
          conflict.local.id,
          {
            name: conflict.local.name,
            variables: sanitizeVariablesForUpstream(conflict.local.variables),
            min_role: conflict.local.minRole,
            base_version: conflict.remote.version || 1,
          },
          cloudConfig.refreshToken,
          operation.controller.signal
        );
        if (!isAsyncOperationCurrent(operation)) return;
        set((current) => {
          if (!isAsyncOperationCurrent(operation)) return {};
          return {
            environments: current.environments.map((environment) => environment.id === conflict.local.id
              ? { ...environment, version: response.version || conflict.remote.version, _syncStatus: 'synced', _pendingCreate: undefined }
              : environment),
            environmentOccConflict: null,
            syncStatus: 'synced',
            syncError: null,
          };
        });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        if (!isAsyncOperationCurrent(operation)) return;
        const remote = err?.status === 409 ? getRemoteEnvironment(err.data) : null;
        set((current) => {
          if (!isAsyncOperationCurrent(operation)) return {};
          return {
            environmentOccConflict: remote ? { local: conflict.local, remote } : current.environmentOccConflict,
            syncStatus: 'error',
            syncError: err?.status === 409
              ? 'The server changed again. Review the latest version before saving.'
              : err?.message || 'Failed to update environment.',
          };
        });
      } finally {
        completeAsyncOperation(operation);
      }
    },

    applyEnvironmentVariableUpdates: (updates, unsetKeys = [], targetEnvId) => {
      const activeEnvId = targetEnvId ?? get().activeEnvironmentId;
      if (!activeEnvId) return [];
      const unsetSet = new Set(unsetKeys);
      const changedKeys: string[] = [];

      set((state) => ({
        environments: state.environments.map((env) => {
          if (env.id !== activeEnvId) return env;
          let updatedVariables = env.variables.filter((v) => {
            const k = v.key.trim();
            if (unsetSet.has(k)) {
              changedKeys.push(k);
              return false;
            }
            return true;
          });

          Object.entries(updates).forEach(([key, val]) => {
            const idx = updatedVariables.findIndex((v) => v.key.trim() === key);
            if (idx >= 0) {
              if (updatedVariables[idx].currentValue !== val) {
                changedKeys.push(key);
              }
              updatedVariables[idx] = {
                ...updatedVariables[idx],
                currentValue: val,
              };
            } else {
              changedKeys.push(key);
              updatedVariables = [
                ...updatedVariables,
                {
                  id: generateId(),
                  key,
                  value: '',
                  initialValue: '',
                  currentValue: val,
                  enabled: true,
                },
              ];
            }
          });

          return {
            ...env,
            variables: updatedVariables,
            updatedAt: Date.now(),
          };
        }),
      }));

      return changedKeys;
    },
  };
}
