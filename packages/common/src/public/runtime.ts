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
  useProductPolicy,
  type AirrestProviderProps,
} from '../context';
export {
  createProductPolicy,
  isProductEdition,
  parseProductEdition,
  PRODUCT_EDITIONS,
  type ProductEdition,
  type ProductPolicy,
} from '../productPolicy';
export type { AuthProvider, AuthProviderCapabilities, AuthSession } from '../auth';
