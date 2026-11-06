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
  return productPolicies[edition];
}
