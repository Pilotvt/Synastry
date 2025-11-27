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
  `#define MyAppOutputBase "Synastry ${friendlyVersion}"`,
].join('\n');

const buildDir = path.join(projectRoot, 'build');
mkdirSync(buildDir, { recursive: true });
const targetPath = path.join(buildDir, 'version.iss');
writeFileSync(targetPath, `${issContent}\n`, 'utf8');

console.log(`[sync-version] build/version.iss обновлён до ${version}`);
