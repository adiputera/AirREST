import fs from 'node:fs';
import path from 'node:path';

const changelogPath = path.resolve(process.cwd(), 'CHANGELOG.md');

export function extractReleaseNotes(targetVersion = '', changelogFile = changelogPath) {
  if (!fs.existsSync(changelogFile)) {
    return 'Download the AirREST installer for your platform below.';
  }

  const content = fs.readFileSync(changelogFile, 'utf8');
  const lines = content.split('\n');

  // Strip prefixes like "desktop-v", "android-v", "v"
  const cleanTarget = targetVersion.replace(/^(desktop-|android-)?v?/, '').trim();

  let capturing = false;
  let captured = [];

  // Pass 1: Try exact match or inclusion with cleanTarget
  if (cleanTarget) {
    for (const line of lines) {
      const headerMatch = line.match(/^##\s+\[(.*?)\]/);
      if (headerMatch) {
        const secVer = headerMatch[1].trim();
        if (secVer === cleanTarget || secVer.includes(cleanTarget)) {
          capturing = true;
          continue;
        } else if (capturing) {
          break;
        }
      }
      if (capturing) {
        captured.push(line);
      }
    }
  }

  // Pass 2: If target is not found (e.g. Unreleased or desktop version doesn't match root changelog),
  // extract the first non-empty section (Unreleased if it has content, otherwise latest released version)
  if (captured.join('').trim().length === 0) {
    let unreleasedLines = [];
    let capturingUnreleased = false;
    let latestReleasedLines = [];
    let capturingLatest = false;

    for (const line of lines) {
      const headerMatch = line.match(/^##\s+\[(.*?)\]/);
      if (headerMatch) {
        const secVer = headerMatch[1].trim().toLowerCase();
        if (secVer === 'unreleased') {
          capturingUnreleased = true;
          capturingLatest = false;
          continue;
        } else {
          // First released version section found
          if (!capturingLatest && latestReleasedLines.length === 0) {
            capturingUnreleased = false;
            capturingLatest = true;
            continue;
          } else if (capturingLatest) {
            break;
          }
        }
      }
      if (capturingUnreleased) unreleasedLines.push(line);
      if (capturingLatest) latestReleasedLines.push(line);
    }

    if (unreleasedLines.join('').trim().length > 0) {
      captured = unreleasedLines;
    } else if (latestReleasedLines.join('').trim().length > 0) {
      captured = latestReleasedLines;
    }
  }

  const result = captured.join('\n').trim();
  return result || 'Download the AirREST installer for your platform below.';
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const versionArg = process.argv[2] || process.env.GITHUB_REF_NAME || '';
  const notes = extractReleaseNotes(versionArg);

  if (process.env.GITHUB_OUTPUT) {
    const delimiter = `EOF_${Date.now()}`;
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `release_notes<<${delimiter}\n${notes}\n${delimiter}\n`
    );
  }
  console.log(notes);
}

