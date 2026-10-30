#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const targetVersion = process.argv[2]?.trim().replace(/^v/, '');

if (!targetVersion || !/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(targetVersion)) {
  console.error('Usage: npm run version:desktop -- <version>');
  console.error('Example: npm run version:desktop -- 0.1.2');
  process.exit(1);
}

const desktopPkgPath = path.join(rootDir, 'apps/desktop/package.json');
const tauriConfPath = path.join(rootDir, 'apps/desktop/src-tauri/tauri.conf.json');
const cargoTomlPath = path.join(rootDir, 'apps/desktop/src-tauri/Cargo.toml');

// 1. apps/desktop/package.json
const desktopPkg = JSON.parse(fs.readFileSync(desktopPkgPath, 'utf8'));
const oldVersion = desktopPkg.version;
desktopPkg.version = targetVersion;
fs.writeFileSync(desktopPkgPath, JSON.stringify(desktopPkg, null, 2) + '\n');
console.log(`✓ Updated apps/desktop/package.json: ${oldVersion} -> ${targetVersion}`);

// 2. apps/desktop/src-tauri/tauri.conf.json
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
tauriConf.version = targetVersion;
fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');
console.log(`✓ Updated apps/desktop/src-tauri/tauri.conf.json: ${oldVersion} -> ${targetVersion}`);

// 3. apps/desktop/src-tauri/Cargo.toml
let cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
cargoToml = cargoToml.replace(/^version = "[^"]+"/m, `version = "${targetVersion}"`);
fs.writeFileSync(cargoTomlPath, cargoToml);
console.log(`✓ Updated apps/desktop/src-tauri/Cargo.toml: ${oldVersion} -> ${targetVersion}`);

console.log('\nReady to commit and tag:');
console.log(`  git add apps/desktop/`);
console.log(`  git commit -m "chore(desktop): release v${targetVersion}"`);
console.log(`  git tag desktop-v${targetVersion}`);
console.log(`  git push origin main --tags`);

