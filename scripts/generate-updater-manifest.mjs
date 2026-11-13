import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Match the signed bundles produced by the desktop release matrix.
export function selectUpdaterAssets(assets, version) {
  const bundles = [
    ['darwin-aarch64', 'app', 'AirREST_aarch64.app.tar.gz', true],
    ['darwin-x86_64', 'app', 'AirREST_x64.app.tar.gz', true],
    ['linux-x86_64', 'appimage', `AirREST_${version}_amd64.AppImage`, true],
    ['windows-x86_64', 'nsis', `AirREST_${version}_x64-setup.exe`, true],
    ['windows-x86_64', 'msi', `AirREST_${version}_x64_en-US.msi`, false],
    ['linux-x86_64', 'deb', `AirREST_${version}_amd64.deb`, false],
    ['linux-x86_64', 'rpm', `AirREST-${version}-1.x86_64.rpm`, false],
  ];
  return bundles.flatMap(([platform, installer, name, required]) => {
    const find = (assetName) => {
      const matches = assets.filter(a => a.name === assetName);
      if (matches.length > 1) throw new Error(`Duplicate release asset: ${assetName}`);
      return matches[0];
    };
    const binary = find(name);
    const signature = find(`${name}.sig`);
    if (!required && !binary && !signature) return [];
    for (const [asset, expectedName] of [[binary, name], [signature, `${name}.sig`]]) {
      if (!asset || asset.state !== 'uploaded' || asset.size <= 0) {
        throw new Error(`Missing or incomplete updater asset: ${expectedName}`);
      }
    }
    return [{ platform, installer, binary, signature }];
  });
}

export function buildUpdaterManifest({ version, notes, pubDate, repo, tag, bundles, signatures }) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) {
    throw new Error('Invalid updater version');
  }
  if (!Number.isFinite(Date.parse(pubDate))) throw new Error('Invalid release date');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !tag) throw new Error('Invalid release repository or tag');
  const platforms = {};
  for (const bundle of bundles) {
    const signature = signatures[bundle.signature.name]?.trim();
    const decoded = signature && Buffer.from(signature, 'base64').toString('utf8');
    if (!signature || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature) ||
        !decoded.startsWith('untrusted comment: ') || !decoded.includes('\ntrusted comment: ')) {
      throw new Error(`Invalid updater signature: ${bundle.signature.name}`);
    }
    const entry = {
      signature,
      url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(bundle.binary.name)}`,
    };
    platforms[bundle.platform] ??= entry;
    platforms[`${bundle.platform}-${bundle.installer}`] = entry;
  }
  for (const target of ['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'windows-x86_64']) {
    if (!platforms[target]) throw new Error(`Missing updater target: ${target}`);
  }
  return {
    version,
    notes,
    pub_date: pubDate,
    release_tag: tag,
    release_url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
    platforms,
  };
}

export async function generateUpdaterManifest({ repo, tag, version, token, fetchImpl = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !tag) throw new Error('Repository and tag are required');
  const base = `https://api.github.com/repos/${repo}`;
  async function request(url, accept = 'application/vnd.github+json') {
    const response = await fetchImpl(url, {
      headers: {
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub request failed (${response.status}): ${url}`);
    return response;
  }
  const release = await (await request(`${base}/releases/tags/${encodeURIComponent(tag)}`)).json();
  const assets = [];
  for (let page = 1; ; page++) {
    const batch = await (await request(`${base}/releases/${release.id}/assets?per_page=100&page=${page}`)).json();
    assets.push(...batch);
    if (batch.length < 100) break;
  }
  const bundles = selectUpdaterAssets(assets, version);
  const signatures = {};
  for (const bundle of bundles) {
    signatures[bundle.signature.name] = await (await request(
      `${base}/releases/assets/${bundle.signature.id}`, 'application/octet-stream',
    )).text();
  }
  return buildUpdaterManifest({
    version, notes: release.body ?? '', pubDate: release.published_at ?? release.created_at,
    repo, tag, bundles, signatures,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const { values } = parseArgs({ options: {
      repo: { type: 'string' }, tag: { type: 'string' }, version: { type: 'string' },
      output: { type: 'string', default: 'latest.json' },
    } });
    const manifest = await generateUpdaterManifest({
      ...values, token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
      version: values.version ?? values.tag?.replace(/^(?:desktop-|android-)?v/, ''),
    });
    fs.writeFileSync(values.output, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`Generated ${values.output}: ${Object.keys(manifest.platforms).join(', ')}`);
  } catch (error) {
    console.error(`Updater manifest generation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
