import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

test('Sidebar component implements smart upward/downward dropdown detection', () => {
  for (const filePath of [
    'packages/common/src/components/Sidebar.tsx',
    'extension/src/components/Sidebar.tsx',
  ]) {
    const content = fs.readFileSync(new URL(`../${filePath}`, import.meta.url), 'utf8');

    // Verify calculateOpenUpward function definition
    assert.match(
      content,
      /export function calculateOpenUpward\(/,
      `${filePath} must export calculateOpenUpward function`
    );

    // Verify detection compares spaceBelow vs menuHeight and spaceAbove > spaceBelow
    assert.match(
      content,
      /spaceBelow < menuHeight && spaceAbove > spaceBelow/,
      `${filePath} must check if downward space is insufficient and upward space is greater`
    );

    // Verify request menu uses dynamic openUpward styling
    assert.match(
      content,
      /openUpward \? 'bottom-full mb-1 origin-bottom-right' : 'top-full mt-1 origin-top-right'/,
      `${filePath} must conditionally apply upward or downward positioning to request menu`
    );

    // Verify collection menu uses dynamic colMenuOpenUpward styling
    assert.match(
      content,
      /colMenuOpenUpward \? 'bottom-full mb-1 origin-bottom-right' : 'top-full mt-1 origin-top-right'/,
      `${filePath} must conditionally apply upward or downward positioning to collection menu`
    );
  }
});

test('calculateOpenUpward logic correctly detects boundary collision and flips direction', () => {
  const content = fs.readFileSync(new URL('../packages/common/src/components/Sidebar.tsx', import.meta.url), 'utf8');

  // Extract calculateOpenUpward function from source
  const fnMatch = content.match(/export function calculateOpenUpward\([\s\S]*?\n\}/);
  assert.ok(fnMatch, 'calculateOpenUpward function must be present');

  const transpiled = ts.transpileModule(fnMatch[0], {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const sandbox = {
    exports: {},
    window: {
      innerHeight: 600,
      getComputedStyle: (el) => el._computedStyle || {},
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(transpiled, sandbox);

  const { calculateOpenUpward } = sandbox.exports;
  assert.equal(typeof calculateOpenUpward, 'function', 'calculateOpenUpward must be exported as a function');

  // Case 1: Item near bottom of window (only 40px space below, plenty above)
  const bottomElement = {
    parentElement: null,
    getBoundingClientRect: () => ({
      top: 540,
      bottom: 560,
      left: 200,
      right: 220,
      width: 20,
      height: 20,
    }),
  };

  assert.equal(
    calculateOpenUpward(bottomElement, 140),
    true,
    'Should open upward when bottom space is 40px (< 140px menu) and space above is 540px'
  );

  // Case 2: Item near top of window (plenty of space below, only 20px above)
  const topElement = {
    parentElement: null,
    getBoundingClientRect: () => ({
      top: 20,
      bottom: 40,
      left: 200,
      right: 220,
      width: 20,
      height: 20,
    }),
  };

  assert.equal(
    calculateOpenUpward(topElement, 140),
    false,
    'Should open downward when bottom space is plenty (> 500px)'
  );

  // Case 3: Item inside a scroll container near the scroll container bottom
  const scrollContainer = {
    parentElement: null,
    _computedStyle: { overflowY: 'auto' },
    getBoundingClientRect: () => ({
      top: 100,
      bottom: 500,
      left: 0,
      right: 300,
      width: 300,
      height: 400,
    }),
  };

  const itemInScrollContainerNearBottom = {
    parentElement: scrollContainer,
    getBoundingClientRect: () => ({
      top: 460,
      bottom: 480,
      left: 200,
      right: 220,
      width: 20,
      height: 20,
    }),
  };

  assert.equal(
    calculateOpenUpward(itemInScrollContainerNearBottom, 140),
    true,
    'Should respect scroll container boundary and open upward when near scroll container bottom'
  );

  // Case 4: Item inside a scroll container near the top of the container
  const itemInScrollContainerNearTop = {
    parentElement: scrollContainer,
    getBoundingClientRect: () => ({
      top: 110,
      bottom: 130,
      left: 200,
      right: 220,
      width: 20,
      height: 20,
    }),
  };

  assert.equal(
    calculateOpenUpward(itemInScrollContainerNearTop, 140),
    false,
    'Should open downward when near top of scroll container'
  );
});
