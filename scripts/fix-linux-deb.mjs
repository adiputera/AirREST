#!/usr/bin/env node
/**
 * Normalizes Debian (.deb) ar archive headers after local Tauri builds on Linux hosts
 * where the user's UID/GID exceeds the 6-digit ASCII limit (999999) of standard Unix ar headers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') {
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const debDir = path.resolve(__dirname, '../apps/native/src-tauri/target/release/bundle/deb');

if (!fs.existsSync(debDir)) {
  process.exit(0);
}

for (const entry of fs.readdirSync(debDir)) {
  if (!entry.endsWith('.deb')) continue;
  const debPath = path.join(debDir, entry);
  const stagingDir = path.join(debDir, entry.slice(0, -4));
  const debianBinary = path.join(stagingDir, 'debian-binary');
  const controlTar = path.join(stagingDir, 'control.tar.gz');
  const dataTar = path.join(stagingDir, 'data.tar.gz');

  if (fs.existsSync(debianBinary) && fs.existsSync(controlTar) && fs.existsSync(dataTar)) {
    fs.unlinkSync(debPath);
    execFileSync('ar', ['rcsD', debPath, debianBinary, controlTar, dataTar], { stdio: 'inherit' });
    console.log(`✓ Normalized deterministic ar header (UID/GID 0) for ${entry}`);
  }
}

