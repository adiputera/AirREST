import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Sidebar component has updated search placeholder and clear button', () => {
  for (const filePath of [
    'packages/common/src/components/Sidebar.tsx',
    'extension/src/components/Sidebar.tsx',
  ]) {
    const content = fs.readFileSync(new URL(`../${filePath}`, import.meta.url), 'utf8');

    // Verify placeholder supports both collections and requests
    assert.match(
      content,
      /sidebarTab === 'collections' \? 'Search collections or requests\.\.\.' : 'Filter history\.\.\.'/,
      `${filePath} must have updated placeholder for collections and requests`
    );

    // Verify clear button with X icon is present
    assert.match(
      content,
      /aria-label="Clear search"/,
      `${filePath} must include clear button for search input`
    );

    // Verify multi-token search splitting
    assert.match(
      content,
      /query\.toLowerCase\(\)\.split\(\/\\s\+\/\)\.filter\(Boolean\)/,
      `${filePath} must tokenize search query`
    );

    // Verify request search inspects name, method, and url
    assert.match(
      content,
      /fullText = `\$\{item\.name \|\| ''\} \$\{item\.request\?\.method \|\| ''\} \$\{item\.request\?\.url \|\| ''\}`\.toLowerCase\(\)/,
      `${filePath} must search name, method, and url for requests`
    );

    // Verify collection item matching priority: matched items > col.items
    assert.match(
      content,
      /items: matchedItems\.length > 0 \? matchedItems : col\.items/,
      `${filePath} must prioritize matched items when requests match inside collection`
    );
  }
});

