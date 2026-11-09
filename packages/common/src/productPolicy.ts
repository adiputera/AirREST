export const PRODUCT_EDITIONS = ['offline', 'full', 'cloud'] as const;

export type ProductEdition = typeof PRODUCT_EDITIONS[number];

export interface ProductPolicy {
  readonly edition: ProductEdition;
  readonly workspace: Readonly<{
    offline: boolean;
    cloud: boolean;
  }>;
}

const productPolicies: Readonly<Record<ProductEdition, ProductPolicy>> = Object.freeze({
  offline: Object.freeze({
    edition: 'offline',
    workspace: Object.freeze({ offline: true, cloud: false }),
  }),
  full: Object.freeze({
    edition: 'full',
    workspace: Object.freeze({ offline: true, cloud: true }),
  }),
  cloud: Object.freeze({
    edition: 'cloud',
    workspace: Object.freeze({ offline: false, cloud: true }),
  }),
});

export function isProductEdition(value: string): value is ProductEdition {
  return PRODUCT_EDITIONS.some((edition) => edition === value);
}

export function parseProductEdition(value: string): ProductEdition {
  if (isProductEdition(value)) {
    return value;
  }
  throw new Error(`Unsupported product edition: ${value}`);
}

export function createProductPolicy(edition: ProductEdition): ProductPolicy {
  if (!isProductEdition(edition)) throw new Error(`Unsupported product edition: ${edition}`);
  return productPolicies[edition];
}

/** Validate injected configuration and return the immutable canonical preset. */
export function validateProductPolicy(policy: ProductPolicy): ProductPolicy {
  if (!policy || typeof policy !== 'object' || typeof policy.edition !== 'string' || !isProductEdition(policy.edition)) {
    throw new Error('Invalid product policy edition.');
  }
  const expected = createProductPolicy(policy.edition);
  if (!policy.workspace || policy.workspace.offline !== expected.workspace.offline || policy.workspace.cloud !== expected.workspace.cloud) {
    throw new Error(`Invalid workspace policy for edition: ${policy.edition}`);
  }
  return expected;
}
