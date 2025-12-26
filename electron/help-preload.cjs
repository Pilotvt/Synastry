const { contextBridge } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const readJsonSafe = (filePath) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const readTextSafe = (filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
};

const resolveAppMeta = () => {
  const pkgPath = path.join(__dirname, '../package.json');
  const pkg = readJsonSafe(pkgPath);
  const version = typeof pkg?.version === 'string' ? pkg.version : '';
  const name = typeof pkg?.build?.productName === 'string' ? pkg.build.productName : (typeof pkg?.name === 'string' ? pkg.name : 'Synastry');
  return { appName: name || 'Synastry', version: version || '' };
};

const readCalculationsContent = () => {
  const htmlPath = path.join(__dirname, 'help-calculations.html');
  const html = readTextSafe(htmlPath);
  const match = html.match(/<script\s+id="embedded-calculations"[^>]*>([\s\S]*?)<\/script>/i);
  const text = match ? String(match[1] ?? '') : '';
  const normalized = text.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
  const lines = normalized.split(/\\n/);
  return { text: normalized, lines };
};

contextBridge.exposeInMainWorld('helpAPI', {
  getCalculations: async () => {
    const meta = resolveAppMeta();
    const { lines } = readCalculationsContent();
    return {
      ...meta,
      title: 'Помощь',
      lines,
    };
  },
});
