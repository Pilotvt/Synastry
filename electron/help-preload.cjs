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
  const contentPath = path.join(__dirname, 'help-calculations-content.txt');
  const text = readTextSafe(contentPath);
  const lines = text.split(/\r?\n/);
  return { text, lines };
};

contextBridge.exposeInMainWorld('helpAPI', {
  getCalculations: async () => {
    const meta = resolveAppMeta();
    const { lines } = readCalculationsContent();
    return {
      ...meta,
      title: 'О расчётах',
      lines,
    };
  },
});
