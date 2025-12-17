// Overwrite baseline-browser-mapping with a no-op stub to silence "old data" warnings during build.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const stubPath = path.join(__dirname, 'baseline-browser-mapping-stub.js');
const moduleDir = path.join(__dirname, '..', 'node_modules', 'baseline-browser-mapping');
const viteCache = path.join(__dirname, '..', 'node_modules', '.vite');

function copyStub(targetFile) {
  try {
    fs.copyFileSync(stubPath, targetFile);
  } catch (err) {
    console.warn(`[patch-baseline] Failed to patch ${targetFile}:`, err?.message || err);
  }
}

if (fs.existsSync(moduleDir)) {
  const targets = [
    path.join(moduleDir, 'index.js'),
    path.join(moduleDir, 'index.cjs'),
    path.join(moduleDir, 'index.mjs'),
  ];
  targets.forEach(copyStub);

  // Переписываем package.json модуля на stub
  const pkgPath = path.join(moduleDir, 'package.json');
  try {
    const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : {};
    pkg.name = 'baseline-browser-mapping';
    pkg.main = './index.js';
    pkg.module = './index.mjs';
    pkg.exports = {
      '.': './index.js',
      './dist': './index.js',
      './dist/index.js': './index.js',
      './dist/index.mjs': './index.mjs',
    };
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  } catch (err) {
    console.warn('[patch-baseline] Failed to rewrite package.json:', err?.message || err);
  }
} else {
  console.warn('[patch-baseline] baseline-browser-mapping not found; skip patch.');
}

// Чистим кеш vite, чтобы не тянуть старую копию
try {
  if (fs.existsSync(viteCache)) {
    fs.rmSync(viteCache, { recursive: true, force: true });
  }
} catch (err) {
  console.warn('[patch-baseline] Failed to clear node_modules/.vite cache:', err?.message || err);
}
