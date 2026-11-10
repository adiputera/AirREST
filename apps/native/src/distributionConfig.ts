import { createApplicationDistributionConfig } from '@airrest/common/configuration';

/** Build-time values for the native product variant; signing material stays in CI/native tooling. */
export const nativeDistributionConfig = createApplicationDistributionConfig({
  backend: { allowCustomUrl: true },
  auth: { providerId: 'password' },
  workspace: { edition: 'full' },
  updates: { androidReleaseRepository: __AIRREST_ANDROID_RELEASE_REPOSITORY__ },
});
