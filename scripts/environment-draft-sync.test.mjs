import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Environment Modal: Draft state management and inline save/cancel controls', () => {
  const envModalPath = path.resolve(__dirname, '../packages/common/src/components/EnvironmentModal.tsx');
  assert.ok(fs.existsSync(envModalPath), `EnvironmentModal exists at ${envModalPath}`);
  const content = fs.readFileSync(envModalPath, 'utf-8');

  // 1. Must import AlertTriangle, useMemo, and useEffect
  assert.ok(content.includes('AlertTriangle'), 'EnvironmentModal imports AlertTriangle');
  assert.ok(content.includes('useMemo'), 'EnvironmentModal imports useMemo');
  assert.ok(content.includes('useEffect'), 'EnvironmentModal imports useEffect');

  // 2. Must define draftKeys, draftInitialValues, and pendingExitAction states
  assert.ok(content.includes('draftKeys'), 'Defines draftKeys state');
  assert.ok(content.includes('draftInitialValues'), 'Defines draftInitialValues state');
  assert.ok(content.includes('pendingExitAction'), 'Defines pendingExitAction state');

  // 3. Must compute hasUnsavedDrafts
  assert.ok(content.includes('hasUnsavedDrafts'), 'Computes hasUnsavedDrafts');

  // 4. Must define individual and batch save/discard handlers
  assert.ok(content.includes('handleSaveRow'), 'Defines handleSaveRow');
  assert.ok(content.includes('handleDiscardRow'), 'Defines handleDiscardRow');
  assert.ok(content.includes('handleRequestClose'), 'Defines handleRequestClose');
  assert.ok(content.includes('handleSelectEnv'), 'Defines handleSelectEnv');
  assert.ok(content.includes('handleSaveAllDraftsAndProceed'), 'Defines handleSaveAllDraftsAndProceed');
  assert.ok(content.includes('handleDiscardAllDraftsAndProceed'), 'Defines handleDiscardAllDraftsAndProceed');

  // 5. Must render inline Check and X buttons when isRowDirty
  assert.ok(content.includes('handleSaveRow(v.id)'), 'Binds save button to handleSaveRow');
  assert.ok(content.includes('handleDiscardRow(v.id)'), 'Binds discard button to handleDiscardRow');
  assert.ok(content.includes('aria-label="Save variable"'), 'Provides accessible label for save button');
  assert.ok(content.includes('aria-label="Cancel changes"'), 'Provides accessible label for discard button');

  // 6. Must support Enter and Escape keydown shortcuts in inputs
  assert.ok(content.includes("e.key === 'Enter'"), 'Handles Enter key to save draft');
  assert.ok(content.includes("e.key === 'Escape'"), 'Handles Escape key to discard draft');

  // 7. Must render Unsaved Variable Changes dialog
  assert.ok(content.includes('Unsaved Variable Changes'), 'Renders dialog header');
  assert.ok(content.includes('handleCancelExit'), 'Provides Cancel option in unsaved dialog');
  assert.ok(content.includes('handleDiscardAllDraftsAndProceed'), 'Provides Discard option in unsaved dialog');
  assert.ok(content.includes('handleSaveAllDraftsAndProceed'), 'Provides Save Changes option in unsaved dialog');

  // 8. Intercepts close button, Done button, and sidebar env switching
  assert.ok(content.includes('onClick={handleRequestClose}'), 'Close and Done buttons call handleRequestClose');
  assert.ok(content.includes('handleSelectEnv(env.id)'), 'Sidebar environment selection calls handleSelectEnv');
});

test('useApiStore: scheduleEnvironmentCloudSync debounce and in-flight concurrency protection', () => {
  const storePath = path.resolve(__dirname, '../packages/common/src/store/useApiStore.ts');
  assert.ok(fs.existsSync(storePath), `useApiStore exists at ${storePath}`);
  const content = fs.readFileSync(storePath, 'utf-8');

  // 1. Must define in-flight and queued tracking dictionaries
  assert.ok(content.includes('envSyncInFlight'), 'Defines envSyncInFlight tracking');
  assert.ok(content.includes('envSyncQueued'), 'Defines envSyncQueued tracking');

  // 2. Debounce time must be increased beyond the problematic 300ms (configured to 1200ms)
  assert.ok(
    /scheduleEnvironmentCloudSync[\s\S]*?},\s*1200\);/.test(content),
    'scheduleEnvironmentCloudSync uses 1200ms debounce'
  );

  // 3. Must queue sync if an in-flight request is already active
  assert.ok(
    content.includes('envSyncInFlight[envId]') && content.includes('envSyncQueued[envId] = true'),
    'Queues sync request when another request is in-flight'
  );

  // 4. Must execute queued sync upon in-flight completion
  assert.ok(
    content.includes('if (envSyncQueued[envId])') && content.includes('executeSync()'),
    'Sequentially executes queued sync after in-flight request completes'
  );
});
