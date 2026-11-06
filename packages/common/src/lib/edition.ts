import {
  createProductPolicy,
  parseProductEdition,
  type ProductEdition,
  type ProductPolicy,
} from '../productPolicy';

/**
 * Build-time compatibility helper. New runtime code should receive a ProductPolicy
 * from the application composition root instead of importing this module directly.
 */
export const APP_EDITION: ProductEdition = parseProductEdition(import.meta.env.VITE_APP_EDITION || 'full');
export const defaultProductPolicy: ProductPolicy = createProductPolicy(APP_EDITION);

/** @deprecated Inject ProductPolicy through createAirrestRuntime instead. */
export const isOfflineOnly = !defaultProductPolicy.workspace.cloud;
