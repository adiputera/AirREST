import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Responsive Header and Sidebar layout parity (Mobile vs Desktop)', () => {
  const targetFiles = [
    {
      scopeSwitcher: 'packages/common/src/components/ScopeSwitcher.tsx',
      header: 'packages/common/src/components/Header.tsx',
      sidebar: 'packages/common/src/components/Sidebar.tsx',
    },
    {
      scopeSwitcher: 'apps/extension/src/components/ScopeSwitcher.tsx',
      header: 'apps/extension/src/components/Header.tsx',
      sidebar: 'apps/extension/src/components/Sidebar.tsx',
    },
  ];

  for (const { scopeSwitcher, header, sidebar } of targetFiles) {
    const scopeContent = fs.readFileSync(new URL(`../${scopeSwitcher}`, import.meta.url), 'utf8');
    const headerContent = fs.readFileSync(new URL(`../${header}`, import.meta.url), 'utf8');
    const sidebarContent = fs.readFileSync(new URL(`../${sidebar}`, import.meta.url), 'utf8');

    // 1. Verify Header is fixed single-line (h-14, no flex-wrap)
    assert.match(
      headerContent,
      /<header className="[^"]*flex h-14 w-full items-center justify-between[^"]*">/,
      `${header} must use single-line fixed h-14 header without flex-wrap`
    );

    // 2. Verify Mobile Environment Switcher sits directly after logo and expands with flex-1 min-w-0 md:hidden
    assert.match(
      headerContent,
      /Mobile Environment Switcher \(Directly after logo/,
      `${header} must place mobile environment switcher directly after logo`
    );
    assert.match(
      headerContent,
      /className="flex flex-1 min-w-0 items-center gap-1\.5 rounded-lg border border-zinc-800 bg-zinc-900\/90 px-2\.5 py-1 md:hidden"/,
      `${header} mobile environment switcher must expand with flex-1 min-w-0 and be md:hidden`
    );

    // 3. Verify Desktop Header preserves ScopeSwitcher, Environment Selector, Import button, and UserMenu
    assert.match(
      headerContent,
      /hidden md:block[^>]*>\s*<ScopeSwitcher/,
      `${header} must preserve ScopeSwitcher in desktop header`
    );
    assert.match(
      headerContent,
      /className="hidden md:flex items-center gap-[^"]*shrink-0"/,
      `${header} must preserve desktop global actions container`
    );
    assert.match(
      headerContent,
      /<span[^>]*>Import<\/span>/,
      `${header} must preserve Import button in desktop header`
    );
    assert.match(
      headerContent,
      /<UserMenu onOpenLogin=/,
      `${header} must preserve UserMenu in desktop header`
    );

    // 4. Verify Sidebar top Workspace & Account section is strictly mobile-only (md:hidden)
    assert.match(
      sidebarContent,
      /<div className="md:hidden border-b border-zinc-800[^"]*bg-zinc-900\/40">/,
      `${sidebar} top workspace & account section must be md:hidden so desktop sidebar is untouched`
    );
    assert.match(
      sidebarContent,
      /<ScopeSwitcher/,
      `${sidebar} must host ScopeSwitcher in mobile drawer`
    );
    assert.match(
      sidebarContent,
      /<UserMenu/,
      `${sidebar} must host UserMenu in mobile drawer`
    );

    // 5. Verify Sidebar already contains Import action button
    assert.match(
      sidebarContent,
      /<span>Import<\/span>/,
      `${sidebar} must provide Import button`
    );

    // 6. Verify ScopeSwitcher has relative container and bounded dropdown
    assert.match(
      scopeContent,
      /<div className="relative z-30 w-full" ref={dropdownRef}>/,
      `${scopeSwitcher} root ref container must use relative z-30 w-full`
    );
    assert.match(
      scopeContent,
      /absolute left-0 top-full mt-2 w-72 sm:w-80 max-w-\[calc\(100vw-1\.5rem\)\]/,
      `${scopeSwitcher} dropdown must use responsive bounded width anchored to left-0`
    );

    // 7. Verify touchstart is registered for mobile outside clicks
    assert.match(
      scopeContent,
      /document\.addEventListener\('touchstart', handleClickOutside\)/,
      `${scopeSwitcher} must listen to touchstart for responsive outside dismiss on mobile`
    );
  }
});
