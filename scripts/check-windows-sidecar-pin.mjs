// Checks that the iroh sidecar pin is identical in all three places:
//   1. src/iroh-component.ts            IROH_COMPONENT_RELEASES['win32-x64']
//   2. apps/windows/DshMobile.Win/SidecarProvisioner.cs   (hardcoded constants)
//   3. apps/windows/DshMobile.Win/sidecar/manifest.json   (mirror)
// Upgrading the upstream pin requires touching all three; this gate fails
// loudly when one drifts. Run: node scripts/check-windows-sidecar-pin.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

function fail(message) {
  console.error(`windows sidecar pin mismatch: ${message}`);
  process.exitCode = 1;
}

// 1. Plugin source of truth.
const component = read('src/iroh-component.ts');
const versionConst = component.match(/export const IROH_VERSION = '([^']+)'/)?.[1];
const block = component.match(/'win32-x64': Object\.freeze\(\{([\s\S]*?)\}\),?\s*\}\)/)?.[1];
if (versionConst === undefined || block === undefined) {
  fail('cannot locate IROH_VERSION or the win32-x64 release block in src/iroh-component.ts');
  process.exit(1);
}
const pick = (re, name) => {
  const value = block.match(re)?.[1] ?? (name === 'version' && block.includes('version: IROH_VERSION') ? versionConst : undefined);
  if (value === undefined) fail(`src/iroh-component.ts win32-x64 is missing ${name}`);
  return value;
};
const fromTs = {
  version: pick(null, 'version'),
  url: pick(/downloadUrl: '([^']+)'/, 'downloadUrl'),
  bytes: Number(pick(/downloadBytes: (\d+)/, 'downloadBytes')),
  sha256: pick(/downloadSha256: '([^']+)'/, 'downloadSha256'),
  file: pick(/executableName: '([^']+)'/, 'executableName'),
};

// 2. Windows client hardcode. DownloadUrl is composed from Version + FileName,
// so reconstruct it the same way instead of parsing a split string literal.
const provisioner = read('apps/windows/DshMobile.Win/SidecarProvisioner.cs');
const cs = (re, name) => {
  const value = provisioner.match(re)?.[1];
  if (value === undefined) fail(`SidecarProvisioner.cs is missing ${name}`);
  return value;
};
const csVersion = cs(/internal const string Version = "([^"]+)";/, 'Version');
const csFile = cs(/internal const string FileName = "([^"]+)";/, 'FileName');
const fromCs = {
  version: csVersion,
  url: `https://unpkg.com/dsh-mobile-iroh@${csVersion}/native/${csFile}`,
  bytes: Number(cs(/internal const long ExpectedBytes = (\d+);/, 'ExpectedBytes')),
  sha256: (cs(/internal const string ExpectedSha256 =\s*"([^"]+)"\s*;/, 'ExpectedSha256') ?? '').replace(/\s+/g, ''),
  file: csFile,
};

// 3. Manifest mirror.
let manifest;
try {
  manifest = JSON.parse(read('apps/windows/DshMobile.Win/sidecar/manifest.json'));
} catch (error) {
  fail(`sidecar/manifest.json is not valid JSON: ${error.message}`);
  process.exit(1);
}
const artifact = manifest?.artifacts?.['win32-x64'];
const fromManifest = artifact === null || typeof artifact !== 'object' ? undefined : {
  version: manifest.packageVersion,
  url: artifact.downloadUrl,
  bytes: artifact.bytes,
  sha256: artifact.sha256,
  file: artifact.file,
};
if (fromManifest === undefined) fail('sidecar/manifest.json has no artifacts.win32-x64 object');

let ok = true;
for (const key of ['version', 'url', 'bytes', 'file', 'sha256']) {
  const values = new Set([fromTs[key], fromCs[key], fromManifest?.[key]].map(String));
  if (values.size !== 1) {
    ok = false;
    fail(`${key}: plugin=${fromTs[key]} windows-client=${fromCs[key]} manifest=${fromManifest?.[key]}`);
  }
}
if (fromTs.bytes !== Math.trunc(fromTs.bytes) || !(fromTs.bytes > 0)) {
  ok = false;
  fail(`bytes is not a positive integer: ${fromTs.bytes}`);
}
if (!/^[a-f0-9]{64}$/.test(fromTs.sha256 ?? '')) {
  ok = false;
  fail(`sha256 is not 64 lowercase hex: ${fromTs.sha256}`);
}
if (ok) console.log(`windows sidecar pin ok: ${fromTs.version} ${fromTs.bytes} bytes sha256:${String(fromTs.sha256).slice(0, 12)}…`);
process.exit(process.exitCode ?? 0);
