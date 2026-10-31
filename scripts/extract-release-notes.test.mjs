import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractReleaseNotes } from './extract-release-notes.mjs';

test('extractReleaseNotes extracts matching version section', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-test-'));
  const changelogFile = path.join(tmpDir, 'CHANGELOG.md');

  const content = `# Changelog
## [Unreleased]

## [1.2.0] - 2026-11-01
### Added
- Feature A

## [1.1.0] - 2026-10-30
### Fixed
- Bug B
`;
  fs.writeFileSync(changelogFile, content, 'utf8');

  try {
    const notes = extractReleaseNotes('v1.2.0', changelogFile);
    assert.match(notes, /Feature A/);
    assert.doesNotMatch(notes, /Bug B/);

    const notesWithPrefix = extractReleaseNotes('desktop-v1.2.0', changelogFile);
    assert.match(notesWithPrefix, /Feature A/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('extractReleaseNotes falls back to latest version when unreleased is empty', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-test-'));
  const changelogFile = path.join(tmpDir, 'CHANGELOG.md');

  const content = `# Changelog
## [Unreleased]

## [1.2.0] - 2026-11-01
### Added
- Latest feature
`;
  fs.writeFileSync(changelogFile, content, 'utf8');

  try {
    const notes = extractReleaseNotes('v9.9.9', changelogFile);
    assert.match(notes, /Latest feature/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

