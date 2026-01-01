import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
const pkgPath = path.join(projectRoot, 'package.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const version = pkg.version;
if (typeof version !== 'string' || !version.trim()) {
  throw new Error('package.json не содержит корректного поля "version".');
}

const friendlyVersion = version.replace(/-/g, ' ');
const issContent = [
  `#define MyAppVersion "${version}"`,
  `#define MyAppOutputBase "Synastry ${friendlyVersion}-setup"`,
].join('\n');

const buildDir = path.join(projectRoot, 'build');
mkdirSync(buildDir, { recursive: true });
const targetPath = path.join(buildDir, 'version.iss');
writeFileSync(targetPath, `${issContent}\n`, 'utf8');

function patchFileIfExists(relativePath, patchFn) {
  const fullPath = path.join(projectRoot, relativePath);
  let current;
  try {
    current = readFileSync(fullPath, 'utf8');
  } catch {
    return false;
  }
  const next = patchFn(String(current));
  if (next !== current) {
    writeFileSync(fullPath, next, 'utf8');
    return true;
  }
  return false;
}

const patchedSetup = patchFileIfExists('setup.iss', (text) => {
  // Update fallback values used when build/version.iss is missing.
  let next = text.replace(
    /(#ifndef\s+MyAppVersion\s*\r?\n\s*#define\s+MyAppVersion\s+")[^"]*("\s*\r?\n\s*#endif)/m,
    `$1${version}$2`,
  );
  next = next.replace(
    /(#ifndef\s+MyAppOutputBase\s*\r?\n\s*#define\s+MyAppOutputBase\s+")[^"]*("\s*\r?\n\s*#endif)/m,
    `$1Synastry ${friendlyVersion}-setup$2`,
  );
  return next;
});

const patchedLock = patchFileIfExists('package-lock.json', (text) => {
  // Patch only the root project version fields, keep the rest intact.
  let next = text.replace(
    /("name"\s*:\s*"synastry"\s*,\s*\r?\n\s*"version"\s*:\s*")[^"]*(")/m,
    `$1${version}$2`,
  );
  next = next.replace(
    /("packages"\s*:\s*\{\s*\r?\n\s*""\s*:\s*\{\s*\r?\n\s*"name"\s*:\s*"synastry"\s*,\s*\r?\n\s*"version"\s*:\s*")[^"]*(")/m,
    `$1${version}$2`,
  );
  return next;
});

console.log(`[sync-version] build/version.iss обновлён до ${version}`);
if (patchedSetup) console.log(`[sync-version] setup.iss fallback-версия обновлена до ${version}`);
if (patchedLock) console.log(`[sync-version] package-lock.json версия проекта обновлена до ${version}`);
