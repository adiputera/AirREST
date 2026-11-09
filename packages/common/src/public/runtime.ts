/** Stable composition API for product variants and application entry points. */
export {
  createAirrestRuntime,
  type AirrestRuntime,
  type AirrestRuntimeConfig,
} from '../runtime';
export {
  AirrestProvider,
  useAirrestRuntime,
  useAuthProvider,
  usePlatformAdapter,
  useProductPolicy,
  type AirrestProviderProps,
} from '../context';
export {
  createProductPolicy,
  validateProductPolicy,
  isProductEdition,
  parseProductEdition,
  PRODUCT_EDITIONS,
  type ProductEdition,
  type ProductPolicy,
} from '../productPolicy';
export type { AuthProvider, AuthProviderCapabilities, AuthSession, AuthSignInRequest, AuthSignOutRequest } from '../auth';
export type { CloudRequestAuthorizer } from '../lib/cloudApi';
export { isCloudSessionActive } from '../workspace/cloudSession';
export { createApiStore, type ApiStore, type ApiStoreState, type CreateApiStoreOptions } from '../store/useApiStore';
