import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('RequestEditor collapse/expand configuration verification', () => {
  const commonPath = path.resolve(__dirname, '../packages/common/src/components/RequestEditor.tsx');
  const extensionPath = path.resolve(__dirname, '../extension/src/components/RequestEditor.tsx');

  for (const filePath of [commonPath, extensionPath]) {
    assert.ok(fs.existsSync(filePath), `File exists: ${filePath}`);
    const content = fs.readFileSync(filePath, 'utf-8');

    // 1. Must import ChevronDown and ChevronUp from lucide-react
    assert.ok(content.includes('ChevronDown'), `${filePath} imports ChevronDown`);
    assert.ok(content.includes('ChevronUp'), `${filePath} imports ChevronUp`);

    // 2. Must manage isConfigCollapsed state with localStorage persistence
    assert.ok(content.includes('isConfigCollapsed'), `${filePath} defines isConfigCollapsed state`);
    assert.ok(
      content.includes('airrest:request_config_collapsed'),
      `${filePath} persists collapse preference to airrest:request_config_collapsed`
    );

    // 3. Must implement handleTabClick and toggleCollapse
    assert.ok(content.includes('handleTabClick'), `${filePath} defines handleTabClick handler`);
    assert.ok(content.includes('toggleCollapse'), `${filePath} defines toggleCollapse handler`);

    // 4. Must render Collapse / Expand button in the subtabs header
    assert.ok(content.includes("isConfigCollapsed ? 'Expand' : 'Collapse'"), `${filePath} renders Expand/Collapse label`);
    assert.ok(content.includes('isConfigCollapsed ? ('), `${filePath} conditionally renders ChevronDown / ChevronUp`);

    // 5. Must conditionally render subtab panels {!isConfigCollapsed && (
    assert.ok(content.includes('{!isConfigCollapsed && ('), `${filePath} wraps subtab panels with {!isConfigCollapsed && (`);
  }
});

