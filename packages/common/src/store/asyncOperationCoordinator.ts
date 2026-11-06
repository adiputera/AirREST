export interface AsyncOperation {
  controller: AbortController;
  sessionGeneration: number;
  scopeGeneration: number;
}

export interface AsyncOperationCoordinatorConfig {
  isDisposed: () => boolean;
}

/** Owns cancellation and stale-result guards for one store/runtime instance. */
export function createAsyncOperationCoordinator(config: AsyncOperationCoordinatorConfig) {
  let sessionGeneration = 0;
  let scopeGeneration = 0;
  const controllers = new Set<AbortController>();

  const begin = (): AsyncOperation => {
    const controller = new AbortController();
    if (config.isDisposed()) controller.abort();
    controllers.add(controller);
    return { controller, sessionGeneration, scopeGeneration };
  };

  const complete = (operation: AsyncOperation): void => {
    controllers.delete(operation.controller);
  };

  const isCurrent = (operation: AsyncOperation): boolean =>
    !config.isDisposed() &&
    !operation.controller.signal.aborted &&
    operation.sessionGeneration === sessionGeneration &&
    operation.scopeGeneration === scopeGeneration;

  const invalidate = ({ session = false }: { session?: boolean } = {}): void => {
    if (session) sessionGeneration += 1;
    scopeGeneration += 1;
    for (const controller of controllers) {
      try {
        controller.abort();
      } catch {
        // Ignore idempotent abort errors.
      }
    }
    controllers.clear();
  };

  return Object.freeze({ begin, complete, isCurrent, invalidate });
}
