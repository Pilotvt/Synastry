import electron from 'electron';
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, screen } = electron;
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import log from 'electron-log';
import updaterPkg from 'electron-updater';
import { verifyLicenseKey } from './license.js';

const { autoUpdater } = updaterPkg;

const fsPromises = fs.promises;

try {
  if (typeof log?.initialize === 'function') {
    log.initialize({ preload: true });
  }
  log.transports.file.level = 'info';
      } catch (error) {
        console.warn('Failed to initialize electron-log', error);
      }

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEVTOOLS_FLAG = '--devtools';
const DEVTOOLS_ENABLED = !app.isPackaged || process.argv.includes(DEVTOOLS_FLAG) || process.env.SYN_DEVTOOLS === '1';

function resolveAppVersion() {
  const versionFromElectron = String(process.versions?.electron ?? '');
  const fromApp = String(app.getVersion?.() ?? '');
  if (fromApp && (!versionFromElectron || fromApp !== versionFromElectron)) {
    return fromApp;
  }
  try {
    const pkgPath = path.join(__dirname, '../package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.version === 'string' && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // ignore version fallback errors
  }
  return fromApp || versionFromElectron || '0.0.0';
}

const CACHE_VERSION = 'v1';
let cacheRootDir = '';
let cacheImagesDir = '';

let backendProcess = null;
let currentOnlineStatus = true;
let backendLaunchConfig = null;
let isQuitting = false;
const PYTHON_ENV_VAR = 'SYN_PYTHON_PATH';
const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = process.env.SYN_BACKEND_PORT || '8000';
// Use piped IO by default to avoid terminal escape codes polluting logs; can override via ENV if needed.
const BACKEND_STDIO = process.env.ELECTRON_BACKEND_STDIO || 'pipe';
const BACKEND_COMPAT_FLAGS_FILE = 'backend-compat.json';
let backendCompatFlags = null;
let backendRestartAttempted = false;

function normalizeQuotedPath(value) {
  if (typeof value !== 'string') return '';
  let trimmed = value.trim();
  if (!trimmed) return '';
  // strip repeated wrapping quotes (common when env vars/registry store `"C:\Path\python.exe"`)
  for (let i = 0; i < 3; i += 1) {
    const next = trimmed.replace(/^['"](.+)['"]$/, '$1').trim();
    if (next === trimmed) break;
    trimmed = next;
  }
  return trimmed;
}

function resolveElectronLogFilePath() {
  try {
    const file = log?.transports?.file?.getFile?.();
    if (file?.path) return String(file.path);
  } catch {}
  return '';
}

function quoteCmdArg(value) {
  const s = String(value ?? '');
  if (!s) return '""';
  if (s.includes(' ') || s.includes('\t')) return `"${s}"`;
  return s;
}

function formatWindowsExitCode(code) {
  if (code == null) return '';
  const n = Number(code);
  if (!Number.isFinite(n)) return '';
  // Convert to unsigned 32-bit hex (Windows NTSTATUS-style exit codes).
  const hex = (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
  return `0x${hex}`;
}

function isWindowsAccessViolationExitCode(code) {
  if (code == null) return false;
  const n = Number(code);
  // 0xC0000005 / STATUS_ACCESS_VIOLATION
  return n === -1073741819 || n === 3221225477;
}

function isWindowsMissingDllExitCode(code) {
  if (code == null) return false;
  const n = Number(code);
  // 0xC0000135 / STATUS_DLL_NOT_FOUND (often means missing UCRT/VC++ runtime)
  return n === -1073741515 || n === 3221225781;
}

function loadBackendCompatFlags() {
  if (backendCompatFlags) return backendCompatFlags;
  try {
    const filePath = path.join(app.getPath('userData'), BACKEND_COMPAT_FLAGS_FILE);
    if (!fs.existsSync(filePath)) {
      backendCompatFlags = {};
      return backendCompatFlags;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    backendCompatFlags = parsed && typeof parsed === 'object' ? parsed : {};
    return backendCompatFlags;
  } catch {
    backendCompatFlags = {};
    return backendCompatFlags;
  }
}

function saveBackendCompatFlags(next) {
  backendCompatFlags = next && typeof next === 'object' ? next : {};
  try {
    const filePath = path.join(app.getPath('userData'), BACKEND_COMPAT_FLAGS_FILE);
    fs.writeFileSync(filePath, JSON.stringify(backendCompatFlags, null, 2), 'utf8');
  } catch {}
  return backendCompatFlags;
}

function disableEmbeddedAsyncioPyd(embedDir, reason) {
  try {
    const src = path.join(embedDir, '_asyncio.pyd');
    if (!fs.existsSync(src)) return { changed: false, path: src };
    const disabledPath = `${src}.disabled`;
    if (!fs.existsSync(disabledPath)) {
      fs.renameSync(src, disabledPath);
      return { changed: true, path: disabledPath };
    }
    return { changed: false, path: disabledPath };
  } catch (err) {
    return { changed: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (reason) {
      const flags = loadBackendCompatFlags();
      if (!flags.disableAsyncioPyd) {
        saveBackendCompatFlags({
          ...flags,
          disableAsyncioPyd: true,
          disableAsyncioPydReason: reason,
          disableAsyncioPydAt: new Date().toISOString(),
        });
      }
    }
  }
}

function sanitizeEmbeddedSitecustomize(embedDir) {
  try {
    if (process.platform !== 'win32') return { changed: false };
    const filePath = path.join(embedDir, 'Lib', 'site-packages', 'sitecustomize.py');
    if (!fs.existsSync(filePath)) return { changed: false };
    const raw = fs.readFileSync(filePath, 'utf8');
    // Older builds shipped a heavy asyncio monkeypatch that can break AnyIO/Uvicorn with:
    // "Future attached to a different loop" => results in 500 on /api/chart, /api/tithi, etc.
    if (!raw.includes('_force_asyncio_pure_python')) return { changed: false };

    const fixed = [
      'import os',
      '',
      '',
      'def _fallback_walk_symlinks_as_files(top, onerror=None, followlinks=False):',
      '    return os.walk(top, topdown=True, onerror=onerror, followlinks=followlinks)',
      '',
      '',
      'if not hasattr(os, \"_walk_symlinks_as_files\"):',
      '    os._walk_symlinks_as_files = _fallback_walk_symlinks_as_files  # type: ignore[attr-defined]',
      '',
    ].join('\\n');

    fs.writeFileSync(filePath, fixed, 'utf8');
    return { changed: true, path: filePath };
  } catch (err) {
    return { changed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function resolveEmbeddedPythonExePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'python-embed', 'python.exe')
    : path.join(__dirname, 'resources', 'python-embed', 'python.exe');
}

function getEmbeddedPythonDirForExec(pythonExecutable) {
  try {
    const embedExe = resolveEmbeddedPythonExePath();
    const normalizedExec = normalizeQuotedPath(pythonExecutable);
    if (!normalizedExec) return null;
    if (path.normalize(normalizedExec) !== path.normalize(embedExe)) return null;
    return path.dirname(embedExe);
  } catch {
    return null;
  }
}

function startBackendProcess(launchConfig) {
  backendLaunchConfig = launchConfig;
  try {
    backendProcess = spawn(launchConfig.command, launchConfig.args, {
      ...launchConfig.options,
      shell: false,
    });
    attachBackendProcessLogging(backendProcess, {
      onExit: (code, signal) => {
        if (isQuitting) return;
        if (signal) return;
        if (!isWindowsAccessViolationExitCode(code)) return;
        if (backendRestartAttempted) return;
        backendRestartAttempted = true;

        const embedDir = getEmbeddedPythonDirForExec(launchConfig.command);
        if (!embedDir) return;

        const hex = formatWindowsExitCode(code);
        const res = disableEmbeddedAsyncioPyd(embedDir, `crash-${hex || code}`);
        if (res?.error) {
          log.error('[backend] failed to disable _asyncio.pyd after crash', res.error);
          return;
        }
        if (res?.path) {
          log.warn(`[backend] crash detected (${hex || code}); disabled _asyncio and restarting: ${res.path}`);
        }

        setTimeout(() => {
          try {
            if (isQuitting) return;
            if (backendProcess) return;
            backendProcess = spawn(launchConfig.command, launchConfig.args, {
              ...launchConfig.options,
              shell: false,
            });
            attachBackendProcessLogging(backendProcess);
          } catch (err) {
            log.error('[backend] failed to restart after disabling _asyncio.pyd', err);
          }
        }, 350);
      },
    });

    backendProcess.on('error', (error) => {
      console.error('Failed to launch backend process:', error);
      const embedPath = resolveEmbeddedPythonExePath();
      const logPath = resolveElectronLogFilePath();
      dialog.showErrorBox(
        'Ошибка запуска бэкенда',
        `Не удалось запустить Python по пути:\n${launchConfig.command}\n\n` +
          `Embedded (ожидается):\n${embedPath}\n\n` +
          `Можно указать Python вручную через переменную окружения:\n${PYTHON_ENV_VAR}="C:\\\\Path\\\\to\\\\python.exe"\n\n` +
          'Если ошибка связана с DLL (VC++ Runtime), установите Microsoft Visual C++ Redistributable 2015-2022 (x64):\n' +
          'https://aka.ms/vs/17/release/vc_redist.x64.exe\n\n' +
          (logPath ? `Логи: ${logPath}\n\n` : '') +
          `Текст ошибки:\n${error instanceof Error ? error.message : String(error)}`
      );
    });
  } catch (error) {
    console.error('Unexpected error while spawning backend process:', error);
    dialog.showErrorBox(
      'Ошибка запуска бэкенда',
      `Не удалось запустить Python.\n\n${error instanceof Error ? error.message : String(error)}`
    );
  }
}

  function httpGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    try {
      const req = https.request(
        url,
        {
          method: 'GET',
          headers: {
            'User-Agent': `${APP_DISPLAY_NAME}/${APP_VERSION}`,
            Accept: 'application/vnd.github+json',
            ...headers,
          },
        },
        (res) => {
          const status = Number(res.statusCode || 0);
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            resolve(httpGetJson(res.headers.location, headers));
            return;
          }
          if (status < 200 || status >= 300) {
            const chunks = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => {
              reject(new Error(`HTTP ${status}: ${(Buffer.concat(chunks).toString('utf-8') || '').slice(0, 400)}`));
            });
            return;
          }
          const chunks = [];
          res.on('data', (d) => chunks.push(d));
          res.on('end', () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf-8');
              resolve(JSON.parse(raw));
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on('error', reject);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function downloadToFile(url, destinationPath, onProgress, options = null) {
  const signal = options && typeof options === 'object' ? options.signal : null;
  const shouldCancel = options && typeof options === 'object' ? options.shouldCancel : null;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      return;
    }

    const startedAt = Date.now();
    let lastTickAt = startedAt;
    let lastTransferred = 0;
    let settled = false;
    let activeReq = null;
    let activeOut = null;
    let activeRes = null;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      try {
        signal?.removeEventListener?.('abort', onAbort);
      } catch {}
      fn();
    };

    const abortError = () => Object.assign(new Error('cancelled'), { name: 'AbortError' });

    const onAbort = () => {
      finish(() => {
        const err = abortError();
        try {
          activeReq?.destroy?.(err);
        } catch {}
        try {
          activeRes?.destroy?.(err);
        } catch {}
        try {
          activeOut?.close?.();
        } catch {}
        try {
          fs.unlinkSync(destinationPath);
        } catch {}
        reject(err);
      });
    };

    try {
      signal?.addEventListener?.('abort', onAbort, { once: true });
    } catch {}

    const requestOnce = (targetUrl) => {
      if (typeof shouldCancel === 'function' && shouldCancel()) {
        onAbort();
        return;
      }
      if (signal?.aborted) {
        onAbort();
        return;
      }

      const req = https.request(
        targetUrl,
        {
          method: 'GET',
          headers: {
            'User-Agent': `${APP_DISPLAY_NAME}/${APP_VERSION}`,
            Accept: '*/*',
          },
        },
        (res) => {
          activeRes = res;
          const status = Number(res.statusCode || 0);
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            requestOnce(res.headers.location);
            return;
          }
          if (status < 200 || status >= 300) {
            const chunks = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => {
              finish(() => {
                reject(new Error(`HTTP ${status}: ${(Buffer.concat(chunks).toString('utf-8') || '').slice(0, 400)}`));
              });
            });
            return;
          }

          const total = Number(res.headers['content-length'] || 0) || 0;
          let transferred = 0;
          const out = fs.createWriteStream(destinationPath);
          activeOut = out;

          const cleanupAndReject = (err) => {
            finish(() => {
              try {
                out.close();
              } catch {}
              try {
                fs.unlinkSync(destinationPath);
              } catch {}
              reject(err);
            });
          };

          out.on('error', cleanupAndReject);
          res.on('error', cleanupAndReject);

          res.on('data', (chunk) => {
            if (typeof shouldCancel === 'function' && shouldCancel()) {
              onAbort();
              return;
            }
            if (signal?.aborted) {
              onAbort();
              return;
            }
            transferred += chunk.length;
            const now = Date.now();
            if (typeof onProgress === 'function' && now - lastTickAt >= 250) {
              const dt = Math.max(1, now - lastTickAt);
              const dBytes = transferred - lastTransferred;
              const bytesPerSecond = Math.round((dBytes * 1000) / dt);
              lastTickAt = now;
              lastTransferred = transferred;
              const percent = total > 0 ? (transferred / total) * 100 : 0;
              onProgress({
                percent,
                transferred,
                total,
                bytesPerSecond,
              });
            }
          });

          res.pipe(out);
          out.on('finish', () => {
            finish(() => {
              try {
                out.close();
              } catch {}
              const elapsed = Math.max(1, Date.now() - startedAt);
              const avgBps = Math.round((transferred * 1000) / elapsed);
              if (typeof onProgress === 'function') {
                const percent = total > 0 ? (transferred / total) * 100 : 100;
                onProgress({
                  percent: Math.max(percent, 100),
                  transferred,
                  total: total || transferred,
                  bytesPerSecond: avgBps,
                });
              }
              resolve(destinationPath);
            });
          });
        }
      );
      activeReq = req;
      req.on('error', (err) => {
        finish(() => reject(err));
      });
      req.end();
    };

    requestOnce(url);
  });
}

const APP_DISPLAY_NAME = 'Synastry';
const APP_ICON = path.join(__dirname, '../build/icons/icon.ico');
const APP_VERSION = resolveAppVersion();
// Автообновление включено по умолчанию; можно отключить через SYN_AUTOUPDATE=0 при необходимости.
const ALLOW_AUTO_UPDATE = process.env.SYN_AUTOUPDATE !== '0';
const PREVIEW_UPDATE_DOWNLOAD = process.argv.includes('--preview-update-download');
const TRIAL_DAYS = 10;
const TRIAL_FILE_NAME = 'trial-info.dat';
const LICENSE_FILE_NAME = 'license-info.json';
const IDENTITY_FILE_NAME = 'identity-info.json';
const DAY_MS = 24 * 60 * 60 * 1000;

const LICENSE_CONTACT = {
  email: 'pilot.vt@mail.ru',
  telegram: '@PilotVT',
};
const DIST_INDEX_FILE = path.join(__dirname, '../dist/index.html');
const MIGRATION_STATE_FILE = 'migration-info.json';
const UPDATE_STATUS_CHANNEL = 'updates:status';
const UPDATE_ERROR_CHANNEL = 'updates:error';
const MANUAL_UPDATE_DIALOG_TITLE = 'Проверка обновлений';

let primaryWindow = null;
let autoUpdateListenersBound = false;
let isCheckingForUpdates = false;
let isDownloadingUpdate = false;
let updateDownloadCancelRequestedAt = 0;
let updateDownloadBackgroundNoticeShown = false;
let updateDownloadWindow = null;
let innoDownloadAbortController = null;
let innoDownloadCancelRequested = false;
let lastUpdateStatusPayload = null;
let updateDownloadPreviewTimer = null;
const manualUpdateState = {
  pending: false,
  window: null,
};

const UPDATE_REPO_OWNER = process.env.SYN_UPDATE_OWNER || 'Pilotvt';
const UPDATE_REPO_NAME = process.env.SYN_UPDATE_REPO || 'Synastry';
const UPDATE_MODE = String(process.env.SYN_UPDATE_MODE || 'inno').toLowerCase(); // 'inno' | 'nsis'

let currentLicenseStatus = null;
let licensePromptWindow = null;
let currentLicenseIdentity = {
  email: null,
  userId: null,
};
let calculationsHelpWindow = null;
let licensesWindow = null;
const chatWindows = new Set();
const blocklistWindows = new Set();
const TRIAL_PROMPT_CHANNEL = 'license:show-trial-warning';
// Включено: лицензионная логика и интерфейс активны
const DISABLE_LICENSE_UI = false;
const CUSTOM_PROTOCOL = 'synastry';
const AUTH_CALLBACK_PATH = '/auth-callback';
const AUTH_DEEP_LINK_CHANNEL = 'auth:deep-link';

let pendingAuthDeepLink = null;

function resolveThirdPartyNoticesPath() {
  const candidates = [];
  try {
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'THIRD_PARTY_NOTICES.txt'));
      candidates.push(path.join(process.resourcesPath, 'app.asar', 'THIRD_PARTY_NOTICES.txt'));
    }
  } catch {}

  try {
    const appPath = typeof app.getAppPath === 'function' ? app.getAppPath() : '';
    if (appPath) {
      candidates.push(path.join(appPath, 'THIRD_PARTY_NOTICES.txt'));
    }
  } catch {}

  try {
    const exePath = typeof app.getPath === 'function' ? app.getPath('exe') : '';
    const exeDir = exePath ? path.dirname(exePath) : '';
    if (exeDir) {
      candidates.push(path.join(exeDir, 'THIRD_PARTY_NOTICES.txt'));
    }
  } catch {}

  candidates.push(path.join(__dirname, '../THIRD_PARTY_NOTICES.txt'));
  try {
    if (process.cwd) {
      candidates.push(path.join(process.cwd(), 'THIRD_PARTY_NOTICES.txt'));
    }
  } catch {}

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return candidates[0] || '';
}

function resolveAppPackageVersion() {
  const candidates = [];
  try {
    const appPath = typeof app.getAppPath === 'function' ? app.getAppPath() : '';
    if (appPath) candidates.push(path.join(appPath, 'package.json'));
  } catch {}
  try {
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'app.asar', 'package.json'));
    }
  } catch {}
  candidates.push(path.join(__dirname, '../package.json'));

  for (const filePath of candidates) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const version = typeof parsed?.version === 'string' ? parsed.version.trim() : '';
      if (version && version !== String(process.versions?.electron ?? '').trim()) {
        return version;
      }
    } catch {}
  }
  return '';
}

ipcMain.handle('licenses:get-notices', async () => {
  const appName = APP_DISPLAY_NAME || (typeof app.getName === 'function' ? app.getName() : 'Synastry');
  const version = resolveAppPackageVersion() || APP_VERSION || (typeof app.getVersion === 'function' ? app.getVersion() : '');
  const filePath = resolveThirdPartyNoticesPath();
  let text = '';
  try {
    if (filePath) {
      text = fs.readFileSync(filePath, 'utf-8');
    }
  } catch {
    text = '';
  }
  return { appName, version, filePath, text };
});

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function openChatWindow(encodedPayload, opener) {
  if (typeof encodedPayload !== 'string' || !encodedPayload.trim()) return;
  const chatWindow = new BrowserWindow({
    width: 940,
    height: 720,
    minWidth: 760,
    minHeight: 600,
    title: `${APP_DISPLAY_NAME} - Чат`,
    icon: APP_ICON,
    autoHideMenuBar: true,
    parent: opener && !opener.isDestroyed() ? opener : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      devTools: DEVTOOLS_ENABLED,
    },
  });
  chatWindow.setMenu(null);
  chatWindow.loadFile(DIST_INDEX_FILE, { hash: `/chat-popup?data=${encodedPayload}` });
  chatWindow.on('closed', () => {
    chatWindows.delete(chatWindow);
  });
  chatWindows.add(chatWindow);
}

function openBlocklistWindow(opener) {
  for (const win of blocklistWindows) {
    if (win && !win.isDestroyed()) {
      win.focus();
      return win;
    }
  }

  const popup = new BrowserWindow({
    width: 520,
    height: 640,
    minWidth: 420,
    minHeight: 560,
    title: `${APP_DISPLAY_NAME} - Чёрный список`,
    icon: APP_ICON,
    autoHideMenuBar: true,
    parent: opener && !opener.isDestroyed() ? opener : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      devTools: DEVTOOLS_ENABLED,
    },
  });

  popup.setMenu(null);
  popup.loadFile(DIST_INDEX_FILE, { hash: '/blocklist-popup' });
  popup.on('closed', () => {
    blocklistWindows.delete(popup);
  });
  blocklistWindows.add(popup);
  return popup;
}

async function readIdentityFromDisk() {
  try {
    const filePath = path.join(app.getPath('userData'), IDENTITY_FILE_NAME);
    const raw = await fsPromises.readFile(filePath, 'utf-8');
    const data = JSON.parse(raw);
    const email = typeof data?.email === 'string' && data.email ? data.email : null;
    const userId = typeof data?.userId === 'string' && data.userId ? data.userId : null;
    return { email, userId };
  } catch {
    return { email: null, userId: null };
  }
}

async function writeIdentityToDisk(identity) {
  try {
    const filePath = path.join(app.getPath('userData'), IDENTITY_FILE_NAME);
    const payload = {
      email: typeof identity?.email === 'string' && identity.email ? identity.email : null,
      userId: typeof identity?.userId === 'string' && identity.userId ? identity.userId : null,
    };
    await fsPromises.writeFile(filePath, JSON.stringify(payload), 'utf-8');
  } catch {
    // ignore disk errors for identity
  }
}

function openCalculationsHelpWindow(parent) {
  if (calculationsHelpWindow && !calculationsHelpWindow.isDestroyed()) {
    calculationsHelpWindow.show();
    calculationsHelpWindow.focus();
    return calculationsHelpWindow;
  }

  const popup = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    title: `Справка - Помощь`,
    icon: APP_ICON,
    autoHideMenuBar: true,
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'help-preload.cjs'),
      devTools: DEVTOOLS_ENABLED,
    },
  });

  popup.setMenu(null);
  try {
    popup.webContents.setWindowOpenHandler(({ url }) => {
      try {
        if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
          shell.openExternal(url).catch(() => {});
        }
      } catch {
        // ignore external open errors
      }
      return { action: 'deny' };
    });
    popup.webContents.on('will-navigate', (event, url) => {
      try {
        if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
          event.preventDefault();
          shell.openExternal(url).catch(() => {});
        }
      } catch {
        // ignore external open errors
      }
    });
  } catch {
    // ignore webContents handler errors
  }
  popup.loadFile(path.join(__dirname, 'help-calculations.html'));
  popup.on('closed', () => {
    if (calculationsHelpWindow === popup) {
      calculationsHelpWindow = null;
    }
  });

  calculationsHelpWindow = popup;
  return popup;
}

function showCalculationsDialog(parent) {
  openCalculationsHelpWindow(parent ?? null);
}

function openLicensesWindow(parent) {
  if (licensesWindow && !licensesWindow.isDestroyed()) {
    licensesWindow.show();
    licensesWindow.focus();
    return licensesWindow;
  }

  const popup = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    title: 'Open Source Licenses',
    icon: APP_ICON,
    autoHideMenuBar: true,
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'licenses-preload.cjs'),
      devTools: DEVTOOLS_ENABLED,
    },
  });

  popup.setMenu(null);
  popup.loadFile(path.join(__dirname, 'licenses.html'));
  popup.on('closed', () => {
    if (licensesWindow === popup) {
      licensesWindow = null;
    }
  });

  licensesWindow = popup;
  return popup;
}

function showLicensesDialog(parent) {
  openLicensesWindow(parent ?? null);
}

function normalizeAuthDeepLink(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return null;
  try {
    const urlObj = new URL(rawUrl);
    if (urlObj.protocol !== `${CUSTOM_PROTOCOL}:`) {
      return null;
    }
    const hostname = (urlObj.hostname || '').toLowerCase();
    const pathname = urlObj.pathname || '';
    const sanitized = pathname.replace(/\\/g, '/');
    const normalizedPath = sanitized.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    const isCallbackPath = normalizedPath === AUTH_CALLBACK_PATH;
    // Supabase often redirects to `synastry://auth-callback#...` (host form), where pathname becomes "/" in URL parsing.
    const isCallbackHost = hostname === AUTH_CALLBACK_PATH.replace(/^\//, '') && (normalizedPath === '/' || normalizedPath === '');
    if (!isCallbackPath && !isCallbackHost) {
      return null;
    }
    return {
      rawUrl,
      hash: urlObj.hash || '',
      search: urlObj.search || '',
    };
  } catch (error) {
    console.warn('Failed to parse auth deep link', error);
    return null;
  }
}

function dispatchAuthDeepLink(payload) {
  if (!payload) return;
  pendingAuthDeepLink = payload;
  const targets = BrowserWindow.getAllWindows();
  if (targets.length === 0) {
    return;
  }
  targets.forEach((win) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send(AUTH_DEEP_LINK_CHANNEL, pendingAuthDeepLink);
    }
  });
}

function deliverAuthLinkToWindow(win) {
  if (!pendingAuthDeepLink) return;
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send(AUTH_DEEP_LINK_CHANNEL, pendingAuthDeepLink);
  } catch (error) {
    console.warn('Failed to deliver auth deep link to renderer', error);
  }
}

function extractDeepLinkFromArgs(argv) {
  if (!Array.isArray(argv)) return null;
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith(`${CUSTOM_PROTOCOL}://`)) {
      return arg;
    }
  }
  return null;
}

function registerCustomProtocol() {
  try {
    if (process.defaultApp && process.argv.length > 1) {
      const appPath = path.resolve(process.argv[1]);
      app.setAsDefaultProtocolClient(CUSTOM_PROTOCOL, process.execPath, [appPath]);
    } else {
      app.setAsDefaultProtocolClient(CUSTOM_PROTOCOL);
    }
  } catch (error) {
    console.warn('Failed to register custom auth protocol handler', error);
  }
}


function getDialogTarget(preferredWindow) {
  if (preferredWindow && !preferredWindow.isDestroyed()) {
    return preferredWindow;
  }
  if (primaryWindow && !primaryWindow.isDestroyed()) {
    return primaryWindow;
  }
  const [fallback] = BrowserWindow.getAllWindows();
  if (fallback && !fallback.isDestroyed()) {
    return fallback;
  }
  return null;
}

function rememberManualUpdateRequest(windowCandidate) {
  manualUpdateState.pending = true;
  manualUpdateState.window = getDialogTarget(windowCandidate);
}

function clearManualUpdateRequest() {
  manualUpdateState.pending = false;
  manualUpdateState.window = null;
}

function resolveManualUpdateRequest(messageOptions = {}) {
  if (!manualUpdateState.pending) {
    return;
  }
  const target = getDialogTarget(manualUpdateState.window);
  clearManualUpdateRequest();
  dialog.showMessageBox(target ?? null, {
    type: messageOptions.type ?? 'info',
    title: MANUAL_UPDATE_DIALOG_TITLE,
    message: messageOptions.message ?? '',
    detail: messageOptions.detail ?? '',
    noLink: true,
  });
}

function formatAutoUpdateErrorForUser(error) {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? '';
  const lower = raw.toLowerCase();

  if (
    lower.includes('unable to find latest version on github') ||
    lower.includes('cannot parse releases feed')
  ) {
    return {
      message: 'Обновление пока недоступно.',
      detail:
        'На GitHub ещё нет опубликованного релиза (Releases/latest). Опубликуйте релиз и повторите проверку.',
    };
  }

  if (lower.includes('net::') || lower.includes('enotfound') || lower.includes('ecconnrefused')) {
    return {
      message: 'Не удалось проверить обновления.',
      detail: 'Проверьте интернет и попробуйте снова.',
    };
  }

  if (lower.includes('404')) {
    return {
      message: 'Обновление пока недоступно.',
      detail: 'Ссылка на релизы не найдена (404). Проверьте настройки репозитория и релизов.',
    };
  }

  return {
    message: 'Не удалось проверить обновления. Попробуйте позже.',
    detail: firstLine && firstLine.length <= 200 ? firstLine : '',
  };
}

function broadcastUpdateStatus(payload) {
  lastUpdateStatusPayload = payload;
  BrowserWindow.getAllWindows().forEach((win) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send(UPDATE_STATUS_CHANNEL, payload);
    }
  });
}

function broadcastUpdateError(payload) {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send(UPDATE_ERROR_CHANNEL, payload);
    }
  });
}

function getUpdaterCacheDir() {
  try {
    const helper = autoUpdater?.downloadedUpdateHelper;
    if (helper?.cacheDir && typeof helper.cacheDir === 'string') {
      return helper.cacheDir;
    }
  } catch {}
  // electron-updater (NSIS) обычно кладёт установщик в %LOCALAPPDATA%\<app>-updater\pending
  try {
    const name = autoUpdater?.updaterCacheDirName || `${APP_DISPLAY_NAME.toLowerCase()}-updater`;
    const base = process.env.LOCALAPPDATA || '';
    if (name && base) {
      return path.join(base, name, 'pending');
    }
  } catch {}
  try {
    const name = autoUpdater?.updaterCacheDirName;
    const base = typeof app.getPath === 'function' ? app.getPath('cache') : '';
    if (name && base) {
      return path.join(base, name);
    }
  } catch {}
  try {
    const base = typeof app.getPath === 'function' ? app.getPath('userData') : '';
    const name = autoUpdater?.updaterCacheDirName || `${APP_DISPLAY_NAME}-updater`;
    if (base) {
      return path.join(base, name);
    }
  } catch {}
  return '';
}

function isLikelyCancelledDownloadError(error) {
  const message = String(error?.message ?? error ?? '').toLowerCase();
  if (!message) return false;
  return (
    message.includes('cancel') ||
    message.includes('canceled') ||
    message.includes('cancelled') ||
    message.includes('abort') ||
    message.includes('aborted') ||
    message.includes('err_aborted')
  );
}

function isUserInitiatedUpdateCancel(error) {
  if (!updateDownloadCancelRequestedAt) return false;
  if (Date.now() - updateDownloadCancelRequestedAt > 15000) return false;
  return isLikelyCancelledDownloadError(error) || !error;
}

async function cancelUpdateDownload(options = {}) {
  const { closeWindow = false } = options && typeof options === 'object' ? options : {};

  if (PREVIEW_UPDATE_DOWNLOAD) {
    if (updateDownloadPreviewTimer) {
      clearInterval(updateDownloadPreviewTimer);
      updateDownloadPreviewTimer = null;
    }
    isDownloadingUpdate = false;
    broadcastUpdateStatus({ type: 'download-cancelled' });
    if (closeWindow) closeUpdateDownloadWindow();
    return { ok: true, preview: true };
  }

  if (!ALLOW_AUTO_UPDATE || !app.isPackaged) {
    return { ok: false, reason: 'disabled' };
  }

  if (!isDownloadingUpdate) {
    if (closeWindow) closeUpdateDownloadWindow();
    return { ok: false, reason: 'not-downloading' };
  }

  if (UPDATE_MODE === 'nsis') {
    const canCancel = typeof autoUpdater?.cancelDownload === 'function';
    if (!canCancel) {
      dialog.showMessageBox(getDialogTarget() ?? null, {
        type: 'info',
        title: 'Загрузка обновления',
        message: 'Отмена загрузки не поддерживается в этой сборке.',
        detail: 'Загрузка продолжится.',
        noLink: true,
      });
      return { ok: false, reason: 'unsupported' };
    }
  } else if (UPDATE_MODE !== 'inno') {
    return { ok: false, reason: 'unsupported' };
  }

  updateDownloadCancelRequestedAt = Date.now();
  isDownloadingUpdate = false;
  broadcastUpdateStatus({ type: 'download-cancelling' });

  try {
    if (UPDATE_MODE === 'nsis') {
      await Promise.resolve(autoUpdater.cancelDownload());
    } else if (UPDATE_MODE === 'inno') {
      innoDownloadCancelRequested = true;
      try {
        innoDownloadAbortController?.abort?.();
      } catch {}
    }
  } catch (error) {
    log.warn('Failed to cancel update download', error);
  } finally {
    broadcastUpdateStatus({ type: 'download-cancelled' });
    const win = getDialogTarget();
    if (win && !win.isDestroyed()) {
      try {
        win.setProgressBar(-1);
      } catch {}
    }

    if (closeWindow) {
      if (updateDownloadWindow && !updateDownloadWindow.isDestroyed()) {
        updateDownloadWindow.__synastrySkipCloseConfirm = true;
      }
      closeUpdateDownloadWindow();
    }
  }

  return { ok: true };
}

function closeUpdateDownloadWindow() {
  if (!updateDownloadWindow || updateDownloadWindow.isDestroyed()) {
    updateDownloadWindow = null;
    return;
  }
  try {
    updateDownloadWindow.__synastrySkipCloseConfirm = true;
    updateDownloadWindow.close();
  } catch {
    // ignore close errors
  }
  updateDownloadWindow = null;
}

function ensureUpdateDownloadWindow(parentWindow) {
  if (!ALLOW_AUTO_UPDATE || !app.isPackaged) return null;
  if (updateDownloadWindow && !updateDownloadWindow.isDestroyed()) {
    try {
      if (!updateDownloadWindow.isVisible()) {
        updateDownloadWindow.show();
      }
      updateDownloadWindow.focus();
    } catch {}
    return updateDownloadWindow;
  }

  const parent = getDialogTarget(parentWindow);
  const win = new BrowserWindow({
    width: 520,
    height: 320,
    useContentSize: true,
    resizable: false,
    minimizable: true,
    maximizable: false,
    show: false,
    parent: parent ?? undefined,
    modal: false,
    title: 'Загрузка обновления',
    icon: APP_ICON,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      devTools: DEVTOOLS_ENABLED,
    },
  });
  win.setMenu(null);
  win.__synastrySkipCloseConfirm = false;
  win.on('close', (event) => {
    if (!isDownloadingUpdate) return;
    if (win.__synastrySkipCloseConfirm) return;
    event.preventDefault();
    try {
      win.hide();
    } catch {}
    if (updateDownloadBackgroundNoticeShown) return;
    updateDownloadBackgroundNoticeShown = true;
    dialog
      .showMessageBox(getDialogTarget() ?? null, {
        type: 'info',
        title: 'Загрузка обновления',
        message: 'Загрузка продолжается в фоне.',
        detail: 'Можно снова открыть окно прогресса в любой момент.',
        buttons: ['Показать прогресс', 'OK'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      })
      .then(({ response }) => {
        if (response !== 0) return;
        try {
          if (!win.isDestroyed()) win.show();
          if (!win.isDestroyed()) win.focus();
        } catch {}
      })
      .catch(() => undefined);
  });
  win.on('closed', () => {
    if (updateDownloadWindow === win) {
      updateDownloadWindow = null;
    }
  });

  win.loadFile(path.join(__dirname, 'update-download.html')).catch((error) => {
    log.error('Failed to load update-download window', error);
  });

  win.webContents.on('did-finish-load', () => {
    if (!lastUpdateStatusPayload) return;
    try {
      win.webContents.send(UPDATE_STATUS_CHANNEL, lastUpdateStatusPayload);
    } catch {}
  });

  win.once('ready-to-show', () => {
    try {
      win.show();
    } catch {}
  });

  updateDownloadWindow = win;
  return win;
}

async function startUpdateDownloadPreview() {
  if (updateDownloadPreviewTimer) {
    clearInterval(updateDownloadPreviewTimer);
    updateDownloadPreviewTimer = null;
  }

  if (updateDownloadWindow && !updateDownloadWindow.isDestroyed()) {
    try {
      updateDownloadWindow.__synastrySkipCloseConfirm = true;
      updateDownloadWindow.close();
    } catch {}
  }
  updateDownloadWindow = null;

  const win = new BrowserWindow({
    width: 520,
    height: 320,
    useContentSize: true,
    resizable: false,
    minimizable: true,
    maximizable: false,
    show: false,
    title: 'Загрузка обновления (preview)',
    icon: APP_ICON,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      devTools: DEVTOOLS_ENABLED,
    },
  });
  win.setMenu(null);

  win.on('closed', () => {
    if (updateDownloadWindow === win) {
      updateDownloadWindow = null;
    }
    if (updateDownloadPreviewTimer) {
      clearInterval(updateDownloadPreviewTimer);
      updateDownloadPreviewTimer = null;
    }
    isDownloadingUpdate = false;
    if (PREVIEW_UPDATE_DOWNLOAD) {
      try {
        app.quit();
      } catch {}
    }
  });

  win.loadFile(path.join(__dirname, 'update-download.html')).catch((error) => {
    log.error('Failed to load update-download preview window', error);
  });

  win.once('ready-to-show', () => {
    try {
      win.show();
    } catch {}
  });

  updateDownloadWindow = win;
  isDownloadingUpdate = true;
  updateDownloadCancelRequestedAt = 0;
  innoDownloadCancelRequested = false;

  const cacheDir = path.join(app.getPath('userData'), 'synastry-inno-updater');
  const total = 1240 * 1024 * 1024;
  const tickMs = 250;
  const bytesPerSecond = 2.2 * 1024 * 1024;
  const step = Math.max(128 * 1024, Math.round((bytesPerSecond * tickMs) / 1000));

  win.webContents.on('did-finish-load', () => {
    broadcastUpdateStatus({ type: 'available', info: { version: APP_VERSION } });
    broadcastUpdateStatus({ type: 'download-started', info: { version: APP_VERSION, cacheDir } });

    let transferred = 0;
    const startedAt = Date.now();
    updateDownloadPreviewTimer = setInterval(() => {
      if (!isDownloadingUpdate) return;
      if (!updateDownloadWindow || updateDownloadWindow.isDestroyed()) return;
      transferred = Math.min(total, transferred + step);
      const elapsed = Math.max(1, Date.now() - startedAt);
      const avgBps = Math.round((transferred * 1000) / elapsed);
      const percent = total > 0 ? (transferred / total) * 100 : 0;
      broadcastUpdateStatus({
        type: 'download-progress',
        info: { percent, transferred, total, bytesPerSecond: avgBps || Math.round(bytesPerSecond) },
      });
      if (transferred >= total) {
        isDownloadingUpdate = false;
        if (updateDownloadPreviewTimer) {
          clearInterval(updateDownloadPreviewTimer);
          updateDownloadPreviewTimer = null;
        }
        broadcastUpdateStatus({
          type: 'downloaded',
          info: {
            version: APP_VERSION,
            downloadedFile: path.join(cacheDir, `Synastry-${APP_VERSION}-update.exe`),
          },
        });
      }
    }, tickMs);
  });
}

function formatReleaseNotes(releaseNotes) {
  if (!releaseNotes) {
    return '';
  }

  const raw =
    typeof releaseNotes === 'string'
      ? releaseNotes
      : Array.isArray(releaseNotes)
        ? releaseNotes
            .map((entry) => {
              if (!entry) return '';
              if (typeof entry === 'string') return entry;
              if (typeof entry.note === 'string') return entry.note;
              return '';
            })
            .filter(Boolean)
            .join('\n\n')
        : '';

  if (!raw) return '';

  const decodeEntities = (input) =>
    input
      .replaceAll('&nbsp;', ' ')
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'");

  const stripHtml = (input) => {
    let text = String(input);
    text = text.replace(/\r\n/g, '\n');
    text = text.replace(/<\s*br\s*\/?\s*>/gi, '\n');
    text = text.replace(/<\/\s*p\s*>/gi, '\n\n');
    text = text.replace(/<\s*p(\s+[^>]*)?>/gi, '');
    text = text.replace(/<\/\s*div\s*>/gi, '\n');
    text = text.replace(/<\s*div(\s+[^>]*)?>/gi, '');
    text = text.replace(/<\s*li(\s+[^>]*)?>/gi, '• ');
    text = text.replace(/<\/\s*li\s*>/gi, '\n');
    text = text.replace(/<\/?\s*ul(\s+[^>]*)?\s*>/gi, '\n');
    text = text.replace(/<\/?\s*ol(\s+[^>]*)?\s*>/gi, '\n');
    text = text.replace(/<\/?\s*h[1-6](\s+[^>]*)?\s*>/gi, '\n');
    text = text.replace(/<[^>]*>/g, '');
    return decodeEntities(text);
  };

  const lines = stripHtml(raw)
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .filter((line) => !/^full changelog\s*:/i.test(line))
    .filter((line) => !/^assets\s*:/i.test(line))
    .filter((line) => !/^https?:\/\//i.test(line)) // скрываем длинные ссылки
    .filter((line) => !/^!\[.*\]\(.*\)$/i.test(line)) // скрываем картинки
    .filter((line) => !/^#/i.test(line)); // убираем markdown-заголовки

  const MAX_LINES = 8;
  let text = lines.slice(0, MAX_LINES).join('\n');

  const MAX_CHARS = 600;
  if (text.length > MAX_CHARS) {
    const cutAt = text.lastIndexOf(' ', MAX_CHARS);
    const safeCut = cutAt > 200 ? cutAt : MAX_CHARS;
    text = text.slice(0, safeCut).trim();
  }

  if (text.length < raw.length || lines.length > MAX_LINES) {
    text = `${text}\n\n(Полный текст — на GitHub Releases)`;
  }

  return text;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSimpleVersion(value) {
  if (typeof value !== 'string') return '';
  const match = value.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] || '';
}

function getInnoUpdaterCacheDir() {
  try {
    const base = typeof app.getPath === 'function' ? app.getPath('cache') : '';
    if (base) return path.join(base, 'synastry-inno-updater');
  } catch {}
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'synastry-inno-updater');
}

function getInnoUpdaterCacheDirCandidates() {
  const dirs = [];
  try {
    dirs.push(getInnoUpdaterCacheDir());
  } catch {}
  try {
    const appData = typeof app.getPath === 'function' ? app.getPath('appData') : '';
    if (appData) dirs.push(path.join(appData, 'synastry-inno-updater'));
  } catch {}
  if (process.env.APPDATA) {
    dirs.push(path.join(process.env.APPDATA, 'synastry-inno-updater'));
  }
  if (process.env.LOCALAPPDATA) {
    dirs.push(path.join(process.env.LOCALAPPDATA, 'synastry-inno-updater'));
  }
  return [...new Set(dirs.filter((d) => typeof d === 'string' && d.trim()))];
}

function pickInnoInstallerAsset(assets, version) {
  const list = Array.isArray(assets) ? assets : [];
  const ver = String(version || '').trim();
  const exact = ver
    ? new RegExp(`^${escapeRegex(APP_DISPLAY_NAME)}[\\s_-]*${escapeRegex(ver)}[\\s_-]*setup\\.exe$`, 'i')
    : null;

  const exeAssets = list
    .filter((a) => a && typeof a === 'object')
    .map((a) => ({
      name: typeof a.name === 'string' ? a.name : '',
      url: typeof a.browser_download_url === 'string' ? a.browser_download_url : '',
      size: Number(a.size || 0) || 0,
    }))
    .filter((a) => a.name && a.url && a.name.toLowerCase().endsWith('.exe'));

  if (exact) {
    const found = exeAssets.find((a) => exact.test(a.name));
    if (found) return found;
  }

  // fallback: any "setup.exe" for Synastry
  const soft = exeAssets.find((a) => /setup\.exe$/i.test(a.name) && new RegExp(escapeRegex(APP_DISPLAY_NAME), 'i').test(a.name));
  if (soft) return soft;

  return null;
}

async function fetchLatestReleaseFromGithub() {
  const url = `https://api.github.com/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases/latest`;
  const release = await httpGetJson(url);
  const tagName = typeof release?.tag_name === 'string' ? release.tag_name : '';
  const name = typeof release?.name === 'string' ? release.name : '';
  const body = typeof release?.body === 'string' ? release.body : '';
  const htmlUrl = typeof release?.html_url === 'string' ? release.html_url : '';
  const version = extractSimpleVersion(tagName) || extractSimpleVersion(name);
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return { version, tagName, name, body, htmlUrl, assets };
}

async function checkForUpdatesInno(options = {}) {
  const { userInitiated = false, browserWindow = null } = options;

  const currentVersion = parseSimpleVersion(app.getVersion?.() ?? '');
  if (!currentVersion) {
    if (userInitiated) {
      dialog.showMessageBox(getDialogTarget(browserWindow) ?? null, {
        type: 'error',
        title: MANUAL_UPDATE_DIALOG_TITLE,
        message: 'Не удалось определить текущую версию приложения.',
        noLink: true,
      });
    }
    return { started: false, reason: 'bad-current-version' };
  }

  const release = await fetchLatestReleaseFromGithub();
  const latestVersion = parseSimpleVersion(release.version);
  if (!latestVersion) {
    if (userInitiated) {
      dialog.showMessageBox(getDialogTarget(browserWindow) ?? null, {
        type: 'error',
        title: MANUAL_UPDATE_DIALOG_TITLE,
        message: 'Не удалось определить версию последнего релиза на GitHub.',
        detail: release.htmlUrl || '',
        noLink: true,
      });
    }
    return { started: false, reason: 'bad-latest-version' };
  }

  if (compareSimpleVersions(latestVersion, currentVersion) <= 0) {
    broadcastUpdateStatus({ type: 'not-available', info: { version: app.getVersion() } });
    if (userInitiated) {
      resolveManualUpdateRequest({
        message: `Установлена последняя версия (${app.getVersion()}).`,
      });
    }
    return { started: true, available: false };
  }

  const asset = pickInnoInstallerAsset(release.assets, release.version);
  if (!asset) {
    const detail = [
      `Релиз: ${release.htmlUrl || '(unknown)'}`,
      `Ожидалось имя установщика: ${APP_DISPLAY_NAME}-${release.version}-setup.exe`,
    ].join('\n');
    if (userInitiated) {
      resolveManualUpdateRequest({
        type: 'error',
        message: 'Не найден Inno Setup установщик в релизе.',
        detail,
      });
    } else {
      broadcastUpdateError({ message: 'no-inno-installer', detail });
    }
    return { started: false, reason: 'no-asset' };
  }

  const target = getDialogTarget(browserWindow);
  const versionLabel = release.version ? `версия ${release.version}` : 'обновление';
  const notes = formatReleaseNotes(release.body);

  broadcastUpdateStatus({ type: 'available', info: { version: release.version, releaseNotes: notes } });
  clearManualUpdateRequest();

  const { response } = await dialog.showMessageBox(target ?? null, {
    type: 'info',
    buttons: ['Скачать и установить', 'Позже'],
    defaultId: 0,
    cancelId: 1,
    title: 'Доступно обновление',
    message: `Доступна ${versionLabel}.`,
    detail: notes || '',
    noLink: true,
  });

  if (response !== 0) {
    return { started: true, available: true, downloaded: false };
  }

  if (isDownloadingUpdate) {
    return { started: true, available: true, downloaded: false, reason: 'already-downloading' };
  }

  isDownloadingUpdate = true;
  updateDownloadCancelRequestedAt = 0;
  innoDownloadCancelRequested = false;
  ensureUpdateDownloadWindow(target);

  const cacheDir = getInnoUpdaterCacheDir();
  try {
    await fsPromises.mkdir(cacheDir, { recursive: true });
  } catch {}

  broadcastUpdateStatus({ type: 'download-started', info: { version: release.version, cacheDir } });

  const downloadedPath = path.join(cacheDir, asset.name || `${APP_DISPLAY_NAME}-${release.version}-setup.exe`);
  try {
    innoDownloadAbortController = typeof AbortController === 'function' ? new AbortController() : null;
    const signal = innoDownloadAbortController?.signal ?? null;

    await downloadToFile(
      asset.url,
      downloadedPath,
      (progress) => {
        if (updateDownloadCancelRequestedAt) return;
        broadcastUpdateStatus({ type: 'download-progress', info: progress });
        const p = Number(progress?.percent);
        const win = getDialogTarget();
        if (win && !win.isDestroyed()) {
          try {
            if (Number.isFinite(p)) {
              win.setProgressBar(Math.max(0, Math.min(1, p / 100)));
            }
          } catch {}
        }
      },
      signal
        ? { signal, shouldCancel: () => innoDownloadCancelRequested }
        : { shouldCancel: () => innoDownloadCancelRequested },
    );

    broadcastUpdateStatus({ type: 'downloaded', info: { version: release.version, downloadedFile: downloadedPath } });
    closeUpdateDownloadWindow();
    const win = getDialogTarget();
    if (win && !win.isDestroyed()) {
      try {
        win.setProgressBar(-1);
      } catch {}
    }

    const detailLines = ['Откроется установщик обновления (Inno Setup).', '', `Файл: ${downloadedPath}`];
    if (cacheDir) detailLines.push('', `Папка загрузки: ${cacheDir}`);

    const { response: installResponse } = await dialog.showMessageBox(target ?? null, {
      type: 'info',
      buttons: ['Запустить установщик', 'Позже'],
      defaultId: 0,
      cancelId: 1,
      title: 'Обновление загружено',
      message: 'Новая версия загружена. Установить сейчас?',
      detail: detailLines.join('\n'),
      noLink: true,
    });

    if (installResponse !== 0) {
      isDownloadingUpdate = false;
      return { started: true, available: true, downloaded: true, installed: false };
    }

    try {
      spawn(downloadedPath, [], { detached: true, stdio: 'ignore', windowsHide: false });
    } catch (error) {
      isDownloadingUpdate = false;
      dialog.showMessageBox(target ?? null, {
        type: 'error',
        title: 'Установка обновления',
        message: 'Не удалось запустить установщик обновления.',
        detail: error instanceof Error ? error.message : String(error),
        noLink: true,
      });
      return { started: true, available: true, downloaded: true, installed: false, reason: 'spawn-failed' };
    }

    setImmediate(() => {
      try {
        app.quit();
      } catch {}
    });

    return { started: true, available: true, downloaded: true, installed: true };
  } catch (error) {
    if (isUserInitiatedUpdateCancel(error)) {
      closeUpdateDownloadWindow();
      updateDownloadCancelRequestedAt = 0;
      innoDownloadCancelRequested = false;
      return { started: true, available: true, downloaded: false, cancelled: true };
    }
    isDownloadingUpdate = false;
    closeUpdateDownloadWindow();
    log.error('Failed to download Inno installer', error);
    const target2 = getDialogTarget(browserWindow);
    dialog.showMessageBox(target2 ?? null, {
      type: 'error',
      title: 'Загрузка обновления',
      message: 'Не удалось скачать обновление. Попробуйте позже.',
      detail: error instanceof Error ? error.message : String(error),
      noLink: true,
    });
    return { started: false, reason: 'download-error', error: error?.message ?? String(error) };
  } finally {
    isDownloadingUpdate = false;
    innoDownloadAbortController = null;
    innoDownloadCancelRequested = false;
  }
}

function setupAutoUpdate(window) {
  if (!ALLOW_AUTO_UPDATE) {
    return;
  }
  if (UPDATE_MODE !== 'nsis') {
    return;
  }
  if (!app.isPackaged) {
    return;
  }
  if (window) {
    primaryWindow = window;
  }
  if (autoUpdateListenersBound) {
    return;
  }
  autoUpdateListenersBound = true;

  autoUpdater.logger = log;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.fullChangelog = true;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => {
    broadcastUpdateStatus({ type: 'checking' });
  });

  autoUpdater.on('update-available', async (info) => {
    clearManualUpdateRequest();
    if (info?.version && info.version === app.getVersion()) {
      broadcastUpdateStatus({ type: 'not-available', info });
      resolveManualUpdateRequest({
        message: `Обновление не требуется: установлена последняя версия (${app.getVersion()}).`,
      });
      return;
    }
    broadcastUpdateStatus({ type: 'available', info });
    const target = getDialogTarget();
    const versionLabel = info?.version ? `версия ${info.version}` : 'обновление';

    try {
      const { response } = await dialog.showMessageBox(target ?? null, {
        type: 'info',
        buttons: ['Скачать и установить', 'Позже'],
        defaultId: 0,
        cancelId: 1,
        title: 'Доступно обновление',
        message: `Доступна ${versionLabel}.`,
        detail: '',
        noLink: true,
      });

      if (response === 0) {
        if (isDownloadingUpdate) {
          return;
        }
        updateDownloadBackgroundNoticeShown = false;
        isDownloadingUpdate = true;
        ensureUpdateDownloadWindow(target);
        const cacheDir = getUpdaterCacheDir();
        broadcastUpdateStatus({ type: 'download-started', info: { version: info?.version, cacheDir } });
        try {
          await autoUpdater.downloadUpdate();
        } catch (error) {
          if (isUserInitiatedUpdateCancel(error)) {
            closeUpdateDownloadWindow();
            updateDownloadCancelRequestedAt = 0;
            return;
          }
          isDownloadingUpdate = false;
          closeUpdateDownloadWindow();
          log.error('Failed to download update', error);
          dialog.showMessageBox(target ?? null, {
            type: 'error',
            title: 'Загрузка обновления',
            message: 'Не удалось скачать обновление. Попробуйте позже.',
            detail: error?.message ?? '',
            noLink: true,
          });
        }
      }
    } catch (error) {
      isDownloadingUpdate = false;
      log.error('Failed to handle update-available prompt', error);
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    broadcastUpdateStatus({ type: 'not-available', info });
    const shownVersion =
      typeof info?.version === 'string' && info.version.trim() ? info.version.trim() : app.getVersion();
    resolveManualUpdateRequest({
      message: `Установлена последняя версия (${shownVersion}).`,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    broadcastUpdateStatus({ type: 'download-progress', info: progress });
    const p = Number(progress?.percent);
    const win = getDialogTarget();
    if (win && !win.isDestroyed()) {
      try {
        if (Number.isFinite(p)) {
          win.setProgressBar(Math.max(0, Math.min(1, p / 100)));
        }
      } catch {}
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    isDownloadingUpdate = false;
    broadcastUpdateStatus({ type: 'downloaded', info });
    closeUpdateDownloadWindow();
    const win = getDialogTarget();
    if (win && !win.isDestroyed()) {
      try {
        win.setProgressBar(-1);
      } catch {}
    }
    const target = getDialogTarget();
    const cacheDir = getUpdaterCacheDir();
    const downloadedPath =
      typeof info?.downloadedFile === 'string' && info.downloadedFile.trim()
        ? info.downloadedFile.trim()
        : '';
    const detailLines = ['Приложение будет закрыто и перезапущено автоматически.'];
    if (cacheDir) detailLines.push('', `Папка загрузки: ${cacheDir}`);
    if (downloadedPath) detailLines.push(`Файл: ${downloadedPath}`);
    dialog
      .showMessageBox(target ?? null, {
        type: 'info',
        buttons: ['Перезапустить и установить', 'Позже'],
        defaultId: 0,
        cancelId: 1,
        title: 'Обновление загружено',
        message: 'Новая версия загружена. Установить сейчас?',
        detail: detailLines.join('\n'),
        noLink: true,
      })
      .then(({ response }) => {
        if (response === 0) {
          setImmediate(() => autoUpdater.quitAndInstall());
        }
      })
      .catch((error) => {
        log.error('Failed to prompt for installation', error);
      });
  });

  autoUpdater.on('error', (error) => {
    isDownloadingUpdate = false;
    log.error('Auto update error', error);
    if (isUserInitiatedUpdateCancel(error)) {
      updateDownloadCancelRequestedAt = 0;
      closeUpdateDownloadWindow();
      const win = getDialogTarget();
      if (win && !win.isDestroyed()) {
        try {
          win.setProgressBar(-1);
        } catch {}
      }
      broadcastUpdateStatus({ type: 'download-cancelled' });
      return;
    }
    const userError = formatAutoUpdateErrorForUser(error);
    broadcastUpdateError({ message: 'auto-update-error', detail: userError.detail ?? '' });
    closeUpdateDownloadWindow();
    const win = getDialogTarget();
    if (win && !win.isDestroyed()) {
      try {
        win.setProgressBar(-1);
      } catch {}
    }

    if (manualUpdateState.pending) {
      resolveManualUpdateRequest({
        type: 'info',
        message: userError.message,
        detail: userError.detail ?? '',
      });
      return;
    }
  });
}

async function checkForUpdates(options = {}) {
  const { userInitiated = false, browserWindow = null } = options;

  if (!ALLOW_AUTO_UPDATE) {
    return { started: false, reason: 'disabled' };
  }
  if (!app.isPackaged) {
    if (userInitiated) {
      dialog.showMessageBox(getDialogTarget(browserWindow) ?? null, {
        type: 'info',
        title: MANUAL_UPDATE_DIALOG_TITLE,
        message: 'Автообновления доступны только в собранной версии приложения.',
        noLink: true,
      });
    }
    return { started: false, reason: 'development' };
  }

  if (UPDATE_MODE !== 'nsis') {
    if (userInitiated) {
      rememberManualUpdateRequest(browserWindow);
    }
    if (isCheckingForUpdates) {
      if (userInitiated) {
        dialog.showMessageBox(getDialogTarget(browserWindow) ?? null, {
          type: 'info',
          title: MANUAL_UPDATE_DIALOG_TITLE,
          message: 'Проверка обновлений уже выполняется.',
          noLink: true,
        });
      }
      return { started: false, reason: 'in-progress' };
    }
    isCheckingForUpdates = true;
    broadcastUpdateStatus({ type: 'checking' });
    try {
      const res = await checkForUpdatesInno({ userInitiated, browserWindow });
      return { ...res, mode: 'inno' };
    } catch (error) {
      log.error('Failed to check for updates (Inno mode)', error);
      const userError = formatAutoUpdateErrorForUser(error);
      if (userInitiated) {
        resolveManualUpdateRequest({
          type: 'info',
          message: userError.message,
          detail: userError.detail ?? '',
        });
      }
      return { started: false, reason: 'error', error: error?.message ?? String(error) };
    } finally {
      isCheckingForUpdates = false;
    }
  }

  if (!autoUpdateListenersBound) {
    setupAutoUpdate(getDialogTarget(browserWindow));
  }

  if (isCheckingForUpdates) {
    if (userInitiated) {
      dialog.showMessageBox(getDialogTarget(browserWindow) ?? null, {
        type: 'info',
        title: MANUAL_UPDATE_DIALOG_TITLE,
        message: 'Проверка обновлений уже выполняется.',
        noLink: true,
      });
    }
    return { started: false, reason: 'in-progress' };
  }

  if (userInitiated) {
    rememberManualUpdateRequest(browserWindow);
  }

  isCheckingForUpdates = true;
  broadcastUpdateStatus({ type: 'checking' });

  try {
    await autoUpdater.checkForUpdates();
    return { started: true };
  } catch (error) {
    log.error('Failed to check for updates', error);
    const userError = formatAutoUpdateErrorForUser(error);
    if (userInitiated) {
      resolveManualUpdateRequest({
        type: 'info',
        message: userError.message,
        detail: userError.detail ?? '',
      });
    }
    return { started: false, reason: 'error', error: error?.message ?? String(error) };
  } finally {
    isCheckingForUpdates = false;
  }
}

async function runPendingDataMigrations() {
  const stateFilePath = path.join(app.getPath('userData'), MIGRATION_STATE_FILE);
  const currentVersion = app.getVersion();
  let storedVersion = null;

  try {
    const payload = await readJsonFileSafe(stateFilePath);
    if (payload && typeof payload.version === 'string') {
      storedVersion = payload.version;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      log.warn('Failed to read migration state file', error);
    }
  }

  if (!storedVersion) {
    await writeJsonFileSafe(stateFilePath, { version: currentVersion, updatedAt: Date.now() });
    return;
  }

  if (storedVersion === currentVersion) {
    return;
  }

  try {
    await performDataMigrations(storedVersion, currentVersion);
    await writeJsonFileSafe(stateFilePath, {
      version: currentVersion,
      previousVersion: storedVersion,
      updatedAt: Date.now(),
    });
  } catch (error) {
    log.error('Data migration failed', error);
    dialog.showErrorBox(
      'Ошибка обновления данных',
      `Не удалось обновить локальные данные при переходе с версии ${storedVersion} на ${currentVersion}.\n\n${error?.message ?? ''}`
    );
  }
}

async function performDataMigrations(fromVersion, toVersion) {
  // Placeholder for future migrations that need to transform cached or user-generated data
  log.info(`No data migrations registered for ${fromVersion ?? 'unknown'} -> ${toVersion}`);
}

async function cleanupUpdaterCache() {
  try {
    const names = [
      `${String(app.getName?.() ?? '').toLowerCase()}-updater`,
      `${APP_DISPLAY_NAME.toLowerCase()}-updater`,
      'synastry-updater',
      'synastry-ui-updater',
    ].filter(Boolean);
    const appDataPaths = new Set([
      app.getPath('appData'), // Roaming
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    ]);
    let removedAny = false;

    for (const base of appDataPaths) {
      for (const dirName of names) {
        const target = path.join(base, dirName);
        const exePath = path.join(base, `${dirName}.exe`);
        try {
          await fsPromises.rm(target, { recursive: true, force: true });
          if (!fs.existsSync(target)) {
            removedAny = true;
          }
        } catch {
          if (process.platform === 'win32') {
            spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', target], { shell: false, stdio: 'ignore' });
            if (!fs.existsSync(target)) {
              removedAny = true;
            }
          }
        }
        try {
          await fsPromises.rm(exePath, { force: true });
          if (!fs.existsSync(exePath)) {
            removedAny = true;
          }
        } catch {
          if (process.platform === 'win32') {
            spawnSync('cmd', ['/c', 'del', '/f', '/q', exePath], { shell: false, stdio: 'ignore' });
            if (!fs.existsSync(exePath)) {
              removedAny = true;
            }
          }
        }
      }
    }
    if (removedAny) {
      log.info('Updater cache cleared');
    } else {
      log.info('Updater cache not found');
    }
  } catch (error) {
    log.warn('Failed to clean updater cache', error);
  }
}

function parseSimpleVersion(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/^v/i, '');
  const match = cleaned.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSimpleVersions(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  for (let i = 0; i < 3; i += 1) {
    const av = Number(a[i] ?? 0);
    const bv = Number(b[i] ?? 0);
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

async function cleanupStaleUpdateInstallers() {
  if (!app.isPackaged || !ALLOW_AUTO_UPDATE) {
    return;
  }

  const currentVersion = parseSimpleVersion(app.getVersion?.() ?? '');
  if (!currentVersion) {
    return;
  }

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dirCandidates = [
    autoUpdater?.updaterCacheDirName,
    `${APP_DISPLAY_NAME.toLowerCase()}-updater`,
    'synastry-updater',
  ]
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim());

  for (const dirName of dirCandidates) {
    const pendingDir = path.join(localAppData, dirName, 'pending');
    let entries = [];
    try {
      entries = await fsPromises.readdir(pendingDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry?.isFile?.()) continue;
      const fileName = String(entry.name || '');
      if (!fileName.toLowerCase().endsWith('.exe')) continue;

      const match = fileName.match(/Synastry-(\d+\.\d+\.\d+)-update(?:\s*\(\d+\))?\.exe/i);
      const fileVersion = parseSimpleVersion(match?.[1] ?? '');
      if (!fileVersion) continue;

      // Удаляем установщики текущей/старых версий — они уже не нужны.
      if (compareSimpleVersions(fileVersion, currentVersion) <= 0) {
        const fullPath = path.join(pendingDir, fileName);
        try {
          await fsPromises.rm(fullPath, { force: true });
        } catch {
          if (process.platform === 'win32') {
            spawnSync('cmd', ['/c', 'del', '/f', '/q', fullPath], { shell: false, stdio: 'ignore' });
          }
        }
      }
    }
  }
}

async function cleanupStaleInnoInstallers() {
  if (!app.isPackaged || !ALLOW_AUTO_UPDATE) {
    return;
  }
  if (UPDATE_MODE === 'nsis') {
    return;
  }

  const currentVersion = parseSimpleVersion(app.getVersion?.() ?? '');
  if (!currentVersion) {
    return;
  }

  const cacheDirs = getInnoUpdaterCacheDirCandidates();
  for (const cacheDir of cacheDirs) {
    let entries = [];
    try {
      entries = await fsPromises.readdir(cacheDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry?.isFile?.()) continue;
      const fileName = String(entry.name || '');
      if (!fileName.toLowerCase().endsWith('.exe')) continue;

      const match = fileName.match(/Synastry[\s_-]*(\d+\.\d+\.\d+)[\s_-]*setup\.exe/i);
      const fileVersion = parseSimpleVersion(match?.[1] ?? '');
      if (!fileVersion) continue;

      if (compareSimpleVersions(fileVersion, currentVersion) <= 0) {
        const fullPath = path.join(cacheDir, fileName);
        try {
          await fsPromises.rm(fullPath, { force: true });
        } catch {
          if (process.platform === 'win32') {
            spawnSync('cmd', ['/c', 'del', '/f', '/q', fullPath], { shell: false, stdio: 'ignore' });
          }
        }
      }
    }
  }
}
const singleInstanceLock = app.requestSingleInstanceLock();
console.log('Electron userData path:', app.getPath('userData'));
if (!singleInstanceLock) {
  app.quit();
  process.exit(0);
}

const initialDeepLink = normalizeAuthDeepLink(extractDeepLinkFromArgs(process.argv));
if (initialDeepLink) {
  pendingAuthDeepLink = initialDeepLink;
}

app.on('second-instance', (event, argv) => {
  event.preventDefault();
  const candidate = normalizeAuthDeepLink(extractDeepLinkFromArgs(argv));
  if (candidate) {
    dispatchAuthDeepLink(candidate);
  }
  const existingWindows = BrowserWindow.getAllWindows();
  if (existingWindows.length > 0) {
    const mainWin = existingWindows[0];
    if (mainWin.isMinimized()) {
      mainWin.restore();
    }
    mainWin.focus();
  }
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  const candidate = normalizeAuthDeepLink(url);
  if (candidate) {
    dispatchAuthDeepLink(candidate);
  }
});

function buildApplicationMenu() {
  const template = [
    {
      label: 'Файл',
      submenu: [
        {
          label: 'Новая карта',
          accelerator: 'Ctrl+N',
          click: (_item, browserWindow) => {
            const target = browserWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
            if (target && !target.isDestroyed()) {
              target.webContents.send('navigation:open-app');
            }
          },
        },
        {
          label: 'Выйти из профиля',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
          click: (_item, browserWindow) => {
            const target = browserWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
            if (target && !target.isDestroyed()) {
              target.webContents.send('navigation:logout');
            }
          },
        },
      ],
    },
    {
      label: 'Настройки',
      submenu: [
        {
          label: 'Уведомления',
          click: (_item, browserWindow) => {
            const target = browserWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
            if (target && !target.isDestroyed()) {
              target.webContents.send('navigation:open-settings');
            }
          },
        },
        {
          label: 'Сменить пароль',
          accelerator: 'Ctrl+Shift+P',
          click: (_item, browserWindow) => {
            const target = browserWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
            if (target && !target.isDestroyed()) {
              target.webContents.send('navigation:change-password');
            }
          },
        },
        {
          label: 'Чёрный список',
          accelerator: 'Ctrl+Shift+B',
          click: (_item, browserWindow) => {
            const target = browserWindow || BrowserWindow.getFocusedWindow() || null;
            openBlocklistWindow(target);
          },
        },
        {
          label: 'Перезагрузить окно',
          accelerator: process.platform === 'darwin' ? 'Cmd+R' : 'Ctrl+R',
          click: (_item, browserWindow) => {
            const target = browserWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
            if (!target || target.isDestroyed()) return;
            target.webContents.reloadIgnoringCache();
          },
        },
      ],
    },
    {
      label: 'Справка',
      submenu: [
        {
          label: 'Проверить обновления',
          accelerator: 'Ctrl+Shift+U',
          click: (_item, browserWindow) => {
            checkForUpdates({ userInitiated: true, browserWindow }).catch((error) => {
              log.error('Manual update check from menu failed', error);
            });
          },
        },
        {
          label: 'Купить',
          click: (_item, browserWindow) => {
            showPurchaseDialog(browserWindow || BrowserWindow.getFocusedWindow() || null);
          },
        },
        {
          label: 'Помощь',
          click: (_item, browserWindow) => showCalculationsDialog(browserWindow || BrowserWindow.getFocusedWindow()),
        },
        {
          label: 'Лицензии (Open Source)',
          click: (_item, browserWindow) => showLicensesDialog(browserWindow || BrowserWindow.getFocusedWindow()),
        },
      ],
    },
  ];

  if (DEVTOOLS_ENABLED) {
    template.push({
      label: 'Разработка',
      submenu: [
        {
          label: 'Открыть DevTools',
          accelerator: process.platform === 'darwin' ? 'Alt+Command+I' : 'Ctrl+Shift+I',
          click: (_item, browserWindow) => {
            const target = browserWindow || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
            if (!target || target.isDestroyed()) return;
            if (target.webContents.isDevToolsOpened()) {
              target.webContents.closeDevTools();
            } else {
              target.webContents.openDevTools({ mode: 'detach' });
            }
          },
        },
      ],
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

async function readJsonFileSafe(targetPath) {
  const raw = await fsPromises.readFile(targetPath, 'utf-8');
  return JSON.parse(raw);
}

async function writeJsonFileSafe(targetPath, data) {
  await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
  await fsPromises.writeFile(targetPath, JSON.stringify(data), 'utf-8');
}

// --- Trial storage helpers (encrypted file + registry fallback) ---
const TRIAL_SECRET = 'synastry-trial-secret-01';
const TRIAL_REG_KEY = 'HKCU\\Software\\Synastry';
const TRIAL_REG_VALUE = 'FirstLaunchMs';

function encryptPayload(data) {
  const key = crypto.createHash('sha256').update(TRIAL_SECRET).digest();
  const iv = crypto.createHash('md5').update(TRIAL_SECRET).digest(); // 16 bytes
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const json = JSON.stringify(data);
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]).toString('base64');
  return encrypted;
}

function decryptPayload(raw) {
  const key = crypto.createHash('sha256').update(TRIAL_SECRET).digest();
  const iv = crypto.createHash('md5').update(TRIAL_SECRET).digest();
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(raw, 'base64')), decipher.final()]).toString('utf8');
  return JSON.parse(decrypted);
}

async function readTrialFileEncrypted(filePath) {
  const raw = await fsPromises.readFile(filePath, 'utf-8');
  return decryptPayload(raw);
}

async function writeTrialFileEncrypted(filePath, payload) {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const blob = encryptPayload(payload);
  await fsPromises.writeFile(filePath, blob, 'utf-8');
}

function readTrialFromRegistry() {
  if (process.platform !== 'win32') return null;
  try {
    const res = spawnSync('reg', ['query', TRIAL_REG_KEY, '/v', TRIAL_REG_VALUE], {
      shell: false,
      encoding: 'utf-8',
    });
    if (res.status !== 0) return null;
    const match = res.stdout.match(/FirstLaunchMs\s+REG_SZ\s+(\d+)/);
    if (match) {
      const parsed = Number(match[1]);
      return Number.isFinite(parsed) ? parsed : null;
    }
  } catch (error) {
    console.warn('Failed to read trial info from registry', error);
  }
  return null;
}

function writeTrialToRegistry(firstLaunchMs) {
  if (process.platform !== 'win32') return;
  try {
    spawnSync('reg', ['add', TRIAL_REG_KEY, '/v', TRIAL_REG_VALUE, '/t', 'REG_SZ', '/d', String(firstLaunchMs), '/f'], {
      shell: false,
      stdio: 'ignore',
    });
  } catch (error) {
    console.warn('Failed to write trial info to registry', error);
  }
}

async function ensureTrialInfo() {
  const trialFilePath = path.join(app.getPath('userData'), TRIAL_FILE_NAME);
  const now = Date.now();

  // Try registry first
  const registryFirstLaunch = readTrialFromRegistry();
  if (typeof registryFirstLaunch === 'number' && Number.isFinite(registryFirstLaunch)) {
    try {
      await writeTrialFileEncrypted(trialFilePath, { firstLaunchMs: registryFirstLaunch });
    } catch (error) {
      console.warn('Failed to sync trial info to file', error);
    }
    return { filePath: trialFilePath, firstLaunchMs: registryFirstLaunch };
  }

  try {
    const payload = await readTrialFileEncrypted(trialFilePath);
    if (typeof payload?.firstLaunchMs === 'number') {
      writeTrialToRegistry(payload.firstLaunchMs);
      return { filePath: trialFilePath, firstLaunchMs: payload.firstLaunchMs };
    }
    throw new Error('Malformed trial payload');
  } catch (error) {
    const payload = { firstLaunchMs: now };
    await writeTrialFileEncrypted(trialFilePath, payload);
    writeTrialToRegistry(payload.firstLaunchMs);
    return { filePath: trialFilePath, firstLaunchMs: payload.firstLaunchMs };
  }
}

async function readStoredLicenseKey() {
  const licenseFilePath = path.join(app.getPath('userData'), LICENSE_FILE_NAME);
  try {
    const payload = await readJsonFileSafe(licenseFilePath);
    if (typeof payload?.key === 'string') {
      return { filePath: licenseFilePath, key: payload.key };
    }
    return { filePath: licenseFilePath, key: null };
  } catch (error) {
    return { filePath: licenseFilePath, key: null };
  }
}

async function storeLicenseKey(key) {
  const licenseFilePath = path.join(app.getPath('userData'), LICENSE_FILE_NAME);
  await writeJsonFileSafe(licenseFilePath, { key });
}

function buildLicenseStatus({ trialInfo, licenseResult, trialError, identity }) {
  const now = Date.now();
  const firstLaunchMs = trialInfo?.firstLaunchMs ?? now;
  const trialExpiresMs = firstLaunchMs + TRIAL_DAYS * DAY_MS;
  const remainingMs = trialExpiresMs - now;
  const daysLeft = remainingMs > 0 ? Math.ceil(remainingMs / DAY_MS) : 0;

  const identityEmail = typeof identity?.email === 'string' && identity.email ? identity.email : null;
  const normalizedIdentityEmail = normalizeEmail(identityEmail);
  const normalizedOwner = normalizeEmail(licenseResult?.owner);
  const licenseValid = Boolean(licenseResult?.valid && !licenseResult?.expired);
  let licensed = licenseValid;
  let allowed = licensed || daysLeft > 0;

  const status = {
    allowed,
    licensed,
    licenseOwner: licensed ? licenseResult.owner : undefined,
    expectedOwner: licenseResult?.owner,
    identityEmail,
    licenseExpiresAt: licensed ? licenseResult.expiresAt : undefined,
    trial: {
      firstLaunchMs,
      expiresAt: new Date(trialExpiresMs).toISOString(),
      daysTotal: TRIAL_DAYS,
      daysLeft,
    },
    message: undefined,
  };

  if (licenseValid && normalizedOwner && normalizedIdentityEmail && normalizedOwner !== normalizedIdentityEmail) {
    licensed = false;
    allowed = daysLeft > 0;
    status.allowed = allowed;
    status.licensed = false;
    status.licenseOwner = undefined;
    status.licenseExpiresAt = undefined;
    status.message = `Этот ключ привязан к ${licenseResult.owner}, а текущий пользователь: ${identityEmail || 'неизвестен'}.`;
  } else if (licenseValid && normalizedOwner && !normalizedIdentityEmail) {
    licensed = false;
    status.licensed = false;
    status.licenseOwner = undefined;
    status.licenseExpiresAt = undefined;
    status.message = 'Авторизуйтесь, чтобы подтвердить лицензию и разблокировать приложение.';
  } else if (!licensed && trialError) {
    status.message = trialError;
  } else if (!licensed && licenseResult?.reason) {
    status.message = licenseResult.reason;
  } else if (!allowed) {
    status.message = 'Пробный период завершён. Введите лицензионный ключ для продолжения работы.';
  }

  return status;
}

async function evaluateLicenseStatus() {
  try {
    const trialInfo = await ensureTrialInfo();
    const { key } = await readStoredLicenseKey();
    const licenseResult = key ? verifyLicenseKey(key) : null;
    return buildLicenseStatus({
      trialInfo,
      licenseResult,
      trialError: null,
      identity: currentLicenseIdentity,
    });
  } catch (error) {
    console.error('Failed to evaluate license status', error);
    return {
      allowed: false,
      licensed: false,
      expectedOwner: undefined,
      identityEmail: currentLicenseIdentity.email,
      trial: {
        firstLaunchMs: Date.now(),
        expiresAt: new Date(Date.now()).toISOString(),
        daysTotal: TRIAL_DAYS,
        daysLeft: 0,
      },
      message: 'Не удалось проверить пробный период. Перезапустите приложение с правами администратора.',
    };
  }
}

function broadcastLicenseStatus() {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send('license:status', currentLicenseStatus);
      if (!DISABLE_LICENSE_UI) {
        if (!currentLicenseStatus?.licensed && currentLicenseStatus?.allowed) {
          win.webContents.send(TRIAL_PROMPT_CHANNEL, currentLicenseStatus);
        }
      }
    }
  });
}

function closeLicensePromptWindow() {
  if (licensePromptWindow && !licensePromptWindow.isDestroyed()) {
    licensePromptWindow.close();
  }
  licensePromptWindow = null;
}

function createLicensePromptWindow(parentWindow) {
  if (licensePromptWindow && !licensePromptWindow.isDestroyed()) {
    licensePromptWindow.focus();
    return licensePromptWindow;
  }

  const parent = parentWindow || BrowserWindow.getFocusedWindow() || null;

  licensePromptWindow = new BrowserWindow({
    parent,
    modal: true,
    width: 520,
    height: 400,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: `${APP_DISPLAY_NAME} - активация лицензии`,
    icon: APP_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'license-prompt-preload.cjs'),
    },
  });

  licensePromptWindow.once('ready-to-show', () => {
    if (licensePromptWindow && !licensePromptWindow.isDestroyed()) {
      licensePromptWindow.show();
    }
  });

  licensePromptWindow.on('closed', () => {
    licensePromptWindow = null;
  });

  licensePromptWindow.loadFile(path.join(__dirname, 'license-prompt.html')).catch((error) => {
    console.error('Не удалось открыть окно активации лицензии', error);
    closeLicensePromptWindow();
    dialog.showMessageBox(parent, {
      type: 'error',
      buttons: ['OK'],
      defaultId: 0,
      title: 'Активация лицензии',
      message: 'Не удалось открыть окно активации. Попробуйте снова.',
      noLink: true,
    });
  });

  return licensePromptWindow;
}

function triggerLicensePrompt(targetWindow) {
  createLicensePromptWindow(targetWindow);
}

async function setLicenseIdentity(identity) {
  const email = typeof identity?.email === 'string' ? identity.email.trim() || null : null;
  const userId = typeof identity?.userId === 'string' ? identity.userId : null;
  const changed = email !== currentLicenseIdentity.email || userId !== currentLicenseIdentity.userId;
  currentLicenseIdentity = { email, userId };
  // persist last known identity so the prompt can show it immediately on next launch
  writeIdentityToDisk(currentLicenseIdentity).catch(() => {});
  if (changed) {
    await refreshLicenseStatus();
  }
  return currentLicenseStatus;
}

async function showPurchaseDialog(browserWindow) {
  const parent = browserWindow || null;
  if (currentLicenseStatus?.licensed) {
    const expiresText = currentLicenseStatus.licenseExpiresAt
      ? new Date(currentLicenseStatus.licenseExpiresAt).toLocaleString()
      : 'бессрочно';
    await dialog.showMessageBox(parent, {
      type: 'info',
      buttons: ['OK'],
      defaultId: 0,
      cancelId: 0,
      title: `${APP_DISPLAY_NAME} - лицензия активна`,
      message: 'Лицензия уже активирована',
      detail: `Ключ привязан к аккаунту ${currentLicenseStatus.identityEmail || '—'}.\nСрок действия: ${expiresText}.`,
      noLink: true,
    });
    return;
  }
  const message = [
    'Для покупки лицензии свяжитесь с автором любым удобным способом:',
    `Email: ${LICENSE_CONTACT.email}`,
    `Telegram: ${LICENSE_CONTACT.telegram}`,
    '',
    'После получения ключа выберите «Ввести ключ» и вставьте его в открывшееся поле.',
  ].join('\n');

  const { response } = await dialog.showMessageBox(parent, {
    type: 'info',
    buttons: ['Ввести ключ', 'Написать письмо', 'Отмена'],
    defaultId: 0,
    cancelId: 2,
    title: `${APP_DISPLAY_NAME} — покупка лицензии`,
    message: 'Приобретение лицензии',
    detail: message,
    noLink: true,
  });

  if (response === 0) {
    triggerLicensePrompt(parent);
  } else if (response === 1) {
    await shell.openExternal(`mailto:${LICENSE_CONTACT.email}`);
  }
}

async function refreshLicenseStatus() {
  currentLicenseStatus = await evaluateLicenseStatus();
  broadcastLicenseStatus();
  return currentLicenseStatus;
}

  function findSystemPython() {
    const candidates = [];
    candidates.push('py -3');
    const userPy = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe');
    const progFilesPy = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Python312', 'python.exe');
    if (fs.existsSync(userPy)) candidates.push(`"${userPy}"`);
    if (fs.existsSync(progFilesPy)) candidates.push(`"${progFilesPy}"`);
    candidates.push('python');

    for (const cmd of candidates) {
      try {
        const res = spawnSync(cmd, ['-V'], { shell: true, encoding: 'utf-8', windowsHide: true });
        const out = `${res.stdout || ''}${res.stderr || ''}`;
        if (res.status === 0 && /Python\s+3\.12/.test(out)) {
          return cmd;
        }
      } catch {
        // ignore
      }
    }
    return null;
  }

  function resolveEmbeddedPython() {
    const embedCandidates = [];
    if (app.isPackaged) {
      embedCandidates.push(path.join(process.resourcesPath, 'python-embed', 'python.exe'));
    } else {
      embedCandidates.push(path.join(__dirname, 'resources', 'python-embed', 'python.exe'));
    }
    for (const p of embedCandidates) {
      if (fs.existsSync(p)) return `"${p}"`;
    }
    return null;
  }

  function resolvePythonExecutable() {
    const envRaw = process.env[PYTHON_ENV_VAR];
    const envOverride = normalizeQuotedPath(envRaw);
    if (envOverride) {
      if (fs.existsSync(envOverride)) return envOverride;
      // allow values like `py -3` / `python`
      if (/^(py(\s|$)|python(\s|$)|python3(\s|$))/i.test(envOverride)) return envOverride;
    }
    const embedded = resolveEmbeddedPython();
    if (embedded) return embedded;
    const systemPy = findSystemPython();
    if (systemPy) return systemPy;
    return null;
  }

function resolveNudeNetModelPath(isPackaged) {
  if (isPackaged) {
    const bundled = path.join(process.resourcesPath, 'nudenet', '640m.onnx');
    if (fs.existsSync(bundled)) return bundled;
    return null;
  }
  const projectRoot = path.join(__dirname, '..');
  const devModel = path.join(projectRoot, 'app', 'nudenet', '640m.onnx');
  if (fs.existsSync(devModel)) return devModel;
  return null;
}

  function ensureBackendDependencies(pythonExecutable) {
    const debug = {
      pythonExecutable,
      wheelsRoot: '',
      requirementsPath: '',
      sitePackagesDir: '',
      pipCommand: '',
      pipBootstrapStdout: '',
      pipBootstrapStderr: '',
      depsCheckStderr: '',
      depsCheckStdout: '',
      lastExitCode: null,
      pipStdout: '',
      pipStderr: '',
      error: '',
    };

    const requirementsPath = app.isPackaged
      ? path.join(process.resourcesPath, 'requirements.txt')
      : path.join(__dirname, '..', 'requirements.txt');
    debug.requirementsPath = requirementsPath;

    const wheelsRoot = app.isPackaged
      ? path.join(process.resourcesPath, 'wheels')
      : path.join(__dirname, 'resources', 'wheels');
    debug.wheelsRoot = wheelsRoot;

    const sitePackagesDir = app.isPackaged
      ? path.join(process.resourcesPath, 'python-embed', 'Lib', 'site-packages')
      : null;
    debug.sitePackagesDir = sitePackagesDir || '';
    if (sitePackagesDir) {
      try {
        fs.mkdirSync(sitePackagesDir, { recursive: true });
      } catch (err) {
        console.error('Failed to ensure site-packages dir', err);
      }
    }

    const pythonEnv = {
      ...process.env,
      // Some embedded Python builds ship without `import site` enabled; ensure pip/installed deps are importable anyway.
      PYTHONPATH: sitePackagesDir
        ? `${sitePackagesDir}${path.delimiter}${process.env.PYTHONPATH || ''}`
        : process.env.PYTHONPATH || '',
    };

    if (app.isPackaged) {
      try {
        const embedExe = path.join(process.resourcesPath, 'python-embed', 'python.exe');
        const normalizedExec = normalizeQuotedPath(pythonExecutable);
        if (normalizedExec && path.normalize(normalizedExec) === path.normalize(embedExe)) {
          const embedDir = path.dirname(embedExe);
          const pythonRuntimeDll = path.join(embedDir, 'python312.dll');
          if (!fs.existsSync(pythonRuntimeDll)) {
            debug.error = `Missing Python runtime DLL in python-embed: python312.dll`;
            return { ok: false, reason: 'python-runtime-missing', debug };
          }
          const mustHave = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'concrt140.dll'];
          const missing = mustHave.filter((name) => !fs.existsSync(path.join(embedDir, name)));
          if (missing.length > 0) {
            debug.error = `Missing VC++ runtime DLL(s) in python-embed: ${missing.join(', ')}`;
            return { ok: false, reason: 'vc-dlls-missing', debug };
          }

          // Self-heal for older installs: remove risky asyncio monkeypatch from sitecustomize.py.
          const siteFix = sanitizeEmbeddedSitecustomize(embedDir);
          if (siteFix?.error) {
            log.warn('[backend] failed to sanitize sitecustomize.py', siteFix.error);
          } else if (siteFix?.changed) {
            log.warn(`[backend] sanitized sitecustomize.py: ${siteFix.path}`);
          }

          // If we already detected a crash on this machine, apply compat fix proactively.
          const flags = loadBackendCompatFlags();
          if (process.platform === 'win32' && flags.disableAsyncioPyd) {
            const res = disableEmbeddedAsyncioPyd(embedDir, flags.disableAsyncioPydReason || 'flagged');
            if (res?.error) {
              debug.error = `Failed to disable _asyncio.pyd: ${res.error}`;
              return { ok: false, reason: 'python-crashed', debug };
            }
            if (res?.changed) {
              log.warn(`[backend] disabled crashing module (flag): ${res.path}`);
            }
          }
        }
      } catch {
        // ignore bundle preflight errors
      }
    }
    const checkScript = [
      'import importlib, sys',
      'mods = ["nudenet", "uvicorn", "fastapi", "numpy", "scipy", "astropy", "skyfield", "swisseph", "PIL"]',
      'missing = []',
      'for m in mods:',
      '    try:',
      '        importlib.import_module(m)',
      '    except Exception as exc:',
      '        missing.append((m, exc))',
      'if missing:',
      '    for name, exc in missing:',
      '        print(f"[deps-check] {name}: {exc}", file=sys.stderr)',
      '    sys.exit(99)',
    ].join('\n');

    const runDepsCheck = () =>
      spawnSync(pythonExecutable, ['-c', checkScript], {
        shell: false,
        windowsHide: true,
        stdio: 'pipe',
        env: pythonEnv,
      });

    const checkResult = runDepsCheck();
    debug.lastExitCode = checkResult.status;
    if (checkResult?.error) {
      debug.error = checkResult.error instanceof Error ? checkResult.error.message : String(checkResult.error);
    }
    if (checkResult.status === 0) {
      return { ok: true, debug };
    }
    const checkStdout = (checkResult.stdout || '').toString().trim();
    const checkStderr = (checkResult.stderr || '').toString().trim();
    debug.depsCheckStdout = checkStdout;
    debug.depsCheckStderr = checkStderr;
    if (checkStdout) {
      log.warn(`[backend] deps check stdout: ${checkStdout}`);
    }
    if (checkStderr) {
      log.warn(`[backend] deps check stderr: ${checkStderr}`);
    }

    if (!checkStdout && !checkStderr && isWindowsMissingDllExitCode(checkResult.status)) {
      debug.error = `Python crashed on startup with exit code ${checkResult.status} (0xC0000135)`;
      return { ok: false, reason: 'python-crashed', debug };
    }

    const dllRelated = /dll load failed|could not find|msvcp\d+|vcruntime\d+|concrt\d+|vcomp\d+/i.test(
      `${checkStdout}\n${checkStderr}`
    );
    if (dllRelated) {
      return { ok: false, reason: 'vc-runtime', debug };
    }

    let tmpReqPath = requirementsPath;
    if (app.isPackaged) {
      try {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synastry-req-'));
        tmpReqPath = path.join(tempDir, 'requirements.txt');
        fs.writeFileSync(tmpReqPath, fs.readFileSync(requirementsPath, 'utf-8'));
      } catch (error) {
        console.error('Failed to prepare temp requirements file', error);
      }
    }

    const useOffline = fs.existsSync(wheelsRoot);
    const wheelsExists = useOffline && fs.existsSync(wheelsRoot);
    // распакуем pip whl, если pip отсутствует
    let pipAvailable = false;
    try {
      const pipProbe = spawnSync(pythonExecutable, ['-m', 'pip', '--version'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
        env: pythonEnv,
      });
      pipAvailable = pipProbe.status === 0;
      debug.lastExitCode = pipProbe.status;
      if (!pipAvailable && isWindowsMissingDllExitCode(pipProbe.status)) {
        debug.error = `Python crashed on startup with exit code ${pipProbe.status} (0xC0000135)`;
        return { ok: false, reason: 'python-crashed', debug };
      }
    } catch {
      pipAvailable = false;
    }
    if (!pipAvailable && wheelsExists && sitePackagesDir) {
      try {
        const pipWheel = fs.readdirSync(wheelsRoot).find((f) => f.startsWith('pip-') && f.endsWith('.whl'));
        if (pipWheel) {
          const pipPath = path.join(wheelsRoot, pipWheel);
          const unzipScript = `
 import zipfile
 zipfile.ZipFile(r"${pipPath.replace(/\\\\/g, '\\\\\\\\')}").extractall(r"${sitePackagesDir.replace(/\\\\/g, '\\\\\\\\')}")
 `;
          const unzipResult = spawnSync(pythonExecutable, ['-c', unzipScript], {
            shell: false,
            stdio: 'pipe',
            windowsHide: true,
            env: pythonEnv,
          });
          debug.pipBootstrapStdout = (unzipResult.stdout || '').toString().trim();
          debug.pipBootstrapStderr = (unzipResult.stderr || '').toString().trim();
          const pipProbe2 = spawnSync(pythonExecutable, ['-m', 'pip', '--version'], {
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
            env: pythonEnv,
          });
          pipAvailable = pipProbe2.status === 0;
          debug.lastExitCode = pipProbe2.status;
          if (!pipAvailable && isWindowsMissingDllExitCode(pipProbe2.status)) {
            debug.error = `Python crashed on startup with exit code ${pipProbe2.status} (0xC0000135)`;
            return { ok: false, reason: 'python-crashed', debug };
          }
        }
      } catch (err) {
        console.error('Failed to unzip pip wheel', err);
      }
    }
    if (!pipAvailable) {
      return { ok: false, reason: 'pip-missing', debug };
    }

    const baseInstallArgs = [
      '-m',
      'pip',
      'install',
      '--no-warn-script-location',
      '--disable-pip-version-check',
      '--upgrade',
    ];
    if (useOffline) {
      baseInstallArgs.push('--no-index', '--find-links', wheelsRoot);
    }
    if (sitePackagesDir) {
      baseInstallArgs.push('--target', sitePackagesDir);
    }
    baseInstallArgs.push('-r', tmpReqPath);
    debug.pipCommand = [quoteCmdArg(pythonExecutable), ...baseInstallArgs.map(quoteCmdArg)].join(' ');

    const installResult = spawnSync(
      pythonExecutable,
      baseInstallArgs,
      { shell: false, stdio: 'pipe', env: pythonEnv, windowsHide: true }
    );
    const installStdout = (installResult.stdout || '').toString().trim();
    const installStderr = (installResult.stderr || '').toString().trim();
    debug.pipStdout = installStdout;
    debug.pipStderr = installStderr;
    if (installStdout) {
      log.warn(`[backend] pip stdout: ${installStdout}`);
    }
    if (installStderr) {
      log.warn(`[backend] pip stderr: ${installStderr}`);
    }
    if (installResult.status === 0) {
      return { ok: true, debug };
    }

    // Some embedded stdlib builds can cause pip to crash during cleanup (e.g. shutil/os mismatch),
    // even though packages were installed successfully. Re-check imports before failing hard.
    try {
      const recheck = runDepsCheck();
      const recheckStdout = (recheck.stdout || '').toString().trim();
      const recheckStderr = (recheck.stderr || '').toString().trim();
      if (recheck.status === 0) {
        if (recheckStdout) log.warn(`[backend] deps recheck stdout: ${recheckStdout}`);
        if (recheckStderr) log.warn(`[backend] deps recheck stderr: ${recheckStderr}`);
        return { ok: true, debug: { ...debug, depsCheckStdout: recheckStdout, depsCheckStderr: recheckStderr } };
      }
    } catch {}

    // Fallback: if bundled wheels are incomplete, allow downloading from the internet.
    if (useOffline) {
      const onlineArgs = baseInstallArgs.filter((arg) => arg !== '--no-index' && arg !== '--find-links' && arg !== wheelsRoot);
      const onlineResult = spawnSync(pythonExecutable, onlineArgs, { shell: false, stdio: 'pipe', env: pythonEnv, windowsHide: true });
      const onlineStdout = (onlineResult.stdout || '').toString().trim();
      const onlineStderr = (onlineResult.stderr || '').toString().trim();
      if (onlineStdout) log.warn(`[backend] pip (online) stdout: ${onlineStdout}`);
      if (onlineStderr) log.warn(`[backend] pip (online) stderr: ${onlineStderr}`);
      if (onlineResult.status === 0) {
        return { ok: true, debug: { ...debug, pipStdout: onlineStdout, pipStderr: onlineStderr } };
      }
    }

    return { ok: false, reason: 'pip-failed', debug };
  }

  function parsePythonCommand(command) {
    if (!command) return { exec: null, extraArgs: [] };
    const trimmed = String(command).trim();
    if (!trimmed) return { exec: null, extraArgs: [] };

    const asPath = normalizeQuotedPath(trimmed);
    if (asPath && fs.existsSync(asPath)) {
      return { exec: asPath, extraArgs: [] };
    }

    if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
      const quote = trimmed[0];
      const end = trimmed.indexOf(quote, 1);
      if (end > 0) {
        const exec = trimmed.slice(1, end);
        const rest = trimmed.slice(end + 1).trim();
        const extraArgs = rest ? rest.split(/\s+/).filter(Boolean) : [];
        return { exec, extraArgs };
      }
    }

    const parts = trimmed.split(/\s+/).filter(Boolean);
    const exec = parts.shift() ?? null;
    return { exec, extraArgs: parts };
  }

  function getBackendLaunchConfig() {
    const pythonExecutable = resolvePythonExecutable();
    if (!pythonExecutable) {
      const embedExpectedPath = app.isPackaged
        ? path.join(process.resourcesPath, 'python-embed', 'python.exe')
        : path.join(__dirname, 'resources', 'python-embed', 'python.exe');
      const installerPath = app.isPackaged
        ? path.join(process.resourcesPath, 'python-installer', 'python-3.13.9-amd64.exe')
        : path.join(__dirname, 'resources', 'python-3.13.9-amd64.exe');

      const buttons = fs.existsSync(installerPath)
        ? ['Установить Python', 'Отмена']
        : ['Открыть python.org', 'Отмена'];

      const result = dialog.showMessageBoxSync({
        type: 'error',
        buttons,
        defaultId: 0,
        cancelId: 1,
        title: 'Не найден Python',
        message: 'Не удалось найти Python для запуска бэкенда Synastry.',
        detail: fs.existsSync(installerPath)
          ? [
              `Встроенный Python (python-embed) не найден по пути:\n${embedExpectedPath}\n`,
              'Нажмите "Установить Python", чтобы установить Python 3.13.9 (x64) в автоматическом режиме.\n',
              'Также можно указать явный путь через переменную окружения:',
              `${PYTHON_ENV_VAR}="C:\\\\Path\\\\to\\\\python.exe"`,
            ].join('\n')
          : [
              `Встроенный Python (python-embed) не найден по пути:\n${embedExpectedPath}\n`,
              'Откроется страница python.org: скачайте и установите Python 3.12+ (x64), затем перезапустите Synastry.\n',
              'Также можно указать явный путь через переменную окружения:',
              `${PYTHON_ENV_VAR}="C:\\\\Path\\\\to\\\\python.exe"`,
            ].join('\n'),
        noLink: true,
      });

      if (result === 0 && fs.existsSync(installerPath)) {
        try {
        const res = spawnSync(`"${installerPath}"`, ['/passive', 'InstallAllUsers=1', 'PrependPath=1', 'Include_launcher=1'], {
          shell: true,
          stdio: 'ignore',
          windowsHide: true,
        });
          if (res.status !== 0) {
            dialog.showMessageBoxSync({
              type: 'error',
              buttons: ['OK'],
              title: 'Установка Python',
              message: 'Автоустановка Python завершилась с ошибкой. Установите Python вручную с python.org и перезапустите Synastry.',
            });
            return null;
          }
        } catch (error) {
          dialog.showMessageBoxSync({
            type: 'error',
            buttons: ['OK'],
            title: 'Установка Python',
            message: 'Не удалось запустить установщик Python. Установите Python вручную с python.org и перезапустите Synastry.',
            detail: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      } else if (result === 0) {
        // open python.org
        shell.openExternal('https://www.python.org/downloads/windows/');
      }

      return null;
    }

  const baseEnv = { ...process.env, SYN_BACKEND_HOST: BACKEND_HOST, SYN_BACKEND_PORT: BACKEND_PORT };
  const debugPythonEnv = {
    // Helps capture Python tracebacks on native crashes where possible.
    PYTHONFAULTHANDLER: process.env.PYTHONFAULTHANDLER || '1',
    PYTHONUNBUFFERED: process.env.PYTHONUNBUFFERED || '1',
    PYTHONIOENCODING: process.env.PYTHONIOENCODING || 'utf-8',
  };
  const pythonPycachePrefix = path.join(app.getPath('userData'), 'cache', 'python-pycache');
  const nudenetModelPath = resolveNudeNetModelPath(app.isPackaged);
  const nudenetEnv = nudenetModelPath ? { NUDENET_MODEL_PATH: nudenetModelPath } : {};
    const { exec: parsedExec, extraArgs: parsedArgs } = parsePythonCommand(pythonExecutable);
    const effectiveExec = parsedExec || pythonExecutable;
    const sitePackagesDir = app.isPackaged
      ? path.join(process.resourcesPath, 'python-embed', 'Lib', 'site-packages')
      : path.join(__dirname, '..', 'python-env', 'Lib', 'site-packages');

    if (app.isPackaged) {
      const resourceRoot = process.resourcesPath;
      const unpackedDir = path.join(resourceRoot, 'app.asar.unpacked');
      const legacyAppDir = path.join(resourceRoot, 'app');
      const unpackedAppDir = path.join(unpackedDir, 'app');
      const existingEntries = [
        resourceRoot,
        fs.existsSync(unpackedDir) ? unpackedDir : null,
        fs.existsSync(legacyAppDir) ? legacyAppDir : null,
        fs.existsSync(unpackedAppDir) ? unpackedAppDir : null,
        fs.existsSync(sitePackagesDir) ? sitePackagesDir : null,
      ].filter(Boolean);
      const inheritedEntries = baseEnv.PYTHONPATH
        ? baseEnv.PYTHONPATH.split(path.delimiter).filter((entry) => entry && entry.trim().length > 0)
        : [];
      const pyPath = [...existingEntries, ...inheritedEntries].filter((entry, index, arr) => arr.indexOf(entry) === index).join(path.delimiter);

      // Force pure-Python protocol stack for stability (avoid `httptools_impl` on Windows embedded builds).
      const httpImpl = process.env.SYN_BACKEND_HTTP || 'h11';
      const wsImpl = process.env.SYN_BACKEND_WS || 'websockets';
      const loopImpl = process.env.SYN_BACKEND_LOOP || 'asyncio';
      const logLevel = process.env.SYN_BACKEND_LOG || 'warning';

      return {
      command: effectiveExec,
      args: [
        ...parsedArgs,
        '-m',
        'uvicorn',
        'app.main:app',
        '--host',
        BACKEND_HOST,
        '--port',
        String(BACKEND_PORT),
        '--log-level',
        logLevel,
        '--http',
        httpImpl,
        '--ws',
        wsImpl,
        '--loop',
        loopImpl,
      ],
      options: {
        cwd: resourceRoot,
        shell: false,
        detached: false,
          stdio: BACKEND_STDIO,
          windowsHide: true,
          env: {
            ...baseEnv,
            ...debugPythonEnv,
            ...nudenetEnv,
            SYN_RESOURCE_ROOT: resourceRoot,
            PYTHONPYCACHEPREFIX: process.env.PYTHONPYCACHEPREFIX || pythonPycachePrefix,
            PYTHONPATH: pyPath,
          },
        },
      };
    }

  const projectRoot = path.join(__dirname, '..');
  const devPyPath = baseEnv.PYTHONPATH ? `${projectRoot}${path.delimiter}${baseEnv.PYTHONPATH}` : projectRoot;
  const httpImpl = process.env.SYN_BACKEND_HTTP || 'h11';
  const wsImpl = process.env.SYN_BACKEND_WS || 'websockets';
  const loopImpl = process.env.SYN_BACKEND_LOOP || 'asyncio';
  const logLevel = process.env.SYN_BACKEND_LOG || 'warning';
    return {
      command: effectiveExec,
      args: [
        ...parsedArgs,
        '-m',
        'uvicorn',
        'app.main:app',
        '--host',
        BACKEND_HOST,
        '--port',
        String(BACKEND_PORT),
        '--log-level',
        logLevel,
        '--http',
        httpImpl,
        '--ws',
        wsImpl,
        '--loop',
        loopImpl,
      ],
      options: {
        cwd: projectRoot,
      shell: false,
      detached: false,
      stdio: BACKEND_STDIO,
      windowsHide: true,
        env: {
          ...baseEnv,
          ...debugPythonEnv,
          ...nudenetEnv,
          SYN_RESOURCE_ROOT: projectRoot,
          PYTHONPYCACHEPREFIX: process.env.PYTHONPYCACHEPREFIX || pythonPycachePrefix,
          PYTHONPATH: devPyPath,
        },
      },
    };
}

function broadcastOnlineStatus(status) {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send('net:status-changed', status);
    }
  });
}

function attachBackendProcessLogging(proc, options = {}) {
  if (!proc) return;
  const { onExit } = options || {};

  const logStream = (stream, level) => {
    if (!stream) return;
    stream.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (!text) return;
      text.split(/\r?\n/).forEach((line) => {
        if (line) {
          log[level](`[backend] ${line}`);
        }
      });
    });
  };

  proc.on('exit', (code, signal) => {
    const hex = formatWindowsExitCode(code);
    const suffix = hex ? ` (${hex})` : '';
    log.warn(`[backend] exited with code=${code}${suffix} signal=${signal ?? 'none'}`);
    if (proc === backendProcess) {
      backendProcess = null;
    }
    try {
      if (typeof onExit === 'function') onExit(code, signal);
    } catch {}
  });

  proc.on('error', (error) => {
    log.error('[backend] process error', error);
  });

  logStream(proc.stdout, 'info');
  logStream(proc.stderr, 'error');
}

ipcMain.handle('net:get-status', () => currentOnlineStatus);

ipcMain.on('net:renderer-status', (_event, status) => {
  const nextStatus = Boolean(status);
  if (nextStatus !== currentOnlineStatus) {
    currentOnlineStatus = nextStatus;
    broadcastOnlineStatus(currentOnlineStatus);
  }
});

ipcMain.handle('cache:get-image-path', async (_event, key) => {
  if (typeof key !== 'string' || !cacheImagesDir) return null;
  const targetPath = path.join(cacheImagesDir, `${key}.png`);
  try {
    await fsPromises.access(targetPath, fs.constants.F_OK);
    return targetPath;
  } catch {
    return null;
  }
});

ipcMain.handle('cache:save-image', async (_event, payload) => {
  if (!payload || typeof payload.key !== 'string' || !Array.isArray(payload.data) || !cacheImagesDir) {
    return null;
  }
  const buffer = Buffer.from(payload.data);
  const targetPath = path.join(cacheImagesDir, `${payload.key}.png`);
  try {
    await fsPromises.mkdir(cacheImagesDir, { recursive: true });
    await fsPromises.writeFile(targetPath, buffer);
    return targetPath;
  } catch (error) {
    console.error('Failed to store cached image', error);
    return null;
  }
});

ipcMain.handle('cache:clear', async () => {
  if (!cacheRootDir) return;
  try {
    await fsPromises.rm(cacheRootDir, { recursive: true, force: true });
    await fsPromises.mkdir(cacheImagesDir, { recursive: true });
  } catch (error) {
    console.error('Failed to clear cache directory', error);
  }
});

ipcMain.handle('maps:get-static', async () => {
  // Заглушка: реализация будет добавлена позднее.
  return null;
});

ipcMain.handle('license:get-status', async () => {
  if (!currentLicenseStatus) {
    await refreshLicenseStatus();
  }
  return currentLicenseStatus;
});

ipcMain.handle('license:set-identity', async (_event, identity) => {
  try {
    return await setLicenseIdentity(identity);
  } catch (error) {
    console.error('Failed to set license identity', error);
    return currentLicenseStatus;
  }
});

ipcMain.handle('license:purchase', async (event) => {
  try {
    const browserWindow = BrowserWindow.fromWebContents(event?.sender);
    await showPurchaseDialog(browserWindow || null);
  } catch (error) {
    console.error('Failed to open purchase dialog', error);
    const target = BrowserWindow.fromWebContents(event?.sender);
    dialog.showMessageBox(target ?? null, {
      type: 'error',
      buttons: ['OK'],
      defaultId: 0,
      cancelId: 0,
      title: `${APP_DISPLAY_NAME} — покупка лицензии`,
      message: 'Не удалось открыть окно покупки. Попробуйте ещё раз.',
      noLink: true,
    }).catch(() => {});
  }
});

ipcMain.handle('license:get-stored-key', async () => {
  const { key } = await readStoredLicenseKey();
  return key;
});

ipcMain.handle('auth:get-pending', () => {
  return pendingAuthDeepLink ? { ...pendingAuthDeepLink } : null;
});

ipcMain.handle('auth:acknowledge', () => {
  pendingAuthDeepLink = null;
  return true;
});

ipcMain.handle('license:activate', async (_event, key) => {
  const validation = verifyLicenseKey(typeof key === 'string' ? key.trim() : '');
  if (!validation.valid) {
    return {
      success: false,
      message: validation.reason || 'Ключ не прошёл проверку.',
    };
  }

  const normalizedOwner = normalizeEmail(validation.owner);
  const normalizedIdentity = normalizeEmail(currentLicenseIdentity.email);

  if (!normalizedIdentity) {
    return {
      success: false,
      message: 'Сначала войдите в приложение под своим аккаунтом, затем активируйте лицензию.',
    };
  }

  if (!normalizedOwner || normalizedOwner !== normalizedIdentity) {
    return {
      success: false,
      message: `Этот ключ распознан как принадлежащий ${validation.owner || 'неизвестному пользователю'}, текущий аккаунт: ${currentLicenseIdentity.email ?? 'не указан'}.`,
    };
  }

  try {
    await storeLicenseKey(key.trim());
    await refreshLicenseStatus();
    return {
      success: true,
      message: `Лицензия активирована для ${validation.owner}. Спасибо!`,
    };
  } catch (error) {
    console.error('Failed to store license key', error);
    return {
      success: false,
      message: 'Не удалось сохранить лицензию. Попробуйте запустить приложение с правами администратора.',
    };
  }
});

ipcMain.handle('license:prompt', () => {
  triggerLicensePrompt(null);
});

ipcMain.on('license-prompt:close', () => {
  closeLicensePromptWindow();
});

ipcMain.on('license-prompt:resize', (event, nextContentHeight) => {
  try {
    const win = BrowserWindow.fromWebContents(event?.sender);
    if (!win || win.isDestroyed()) return;
    if (licensePromptWindow && !licensePromptWindow.isDestroyed() && win.id !== licensePromptWindow.id) return;

    const desiredHeight = Number(nextContentHeight);
    if (!Number.isFinite(desiredHeight) || desiredHeight <= 0) return;

    const [contentWidth, currentContentHeight] = win.getContentSize();
    const display = screen?.getDisplayMatching ? screen.getDisplayMatching(win.getBounds()) : null;
    const maxHeight = Math.max(320, (display?.workAreaSize?.height ?? 900) - 80);
    const clampedHeight = Math.min(maxHeight, Math.max(320, Math.ceil(desiredHeight)));

    if (Math.abs(currentContentHeight - clampedHeight) < 2) return;
    win.setContentSize(contentWidth, clampedHeight, false);
  } catch (error) {
    console.warn('Failed to resize license prompt window', error);
  }
});

ipcMain.handle('ui:offline-access-dialog', async (event) => {
  const parent = BrowserWindow.fromWebContents(event?.sender) || null;
  const title = `${APP_DISPLAY_NAME} - требуется регистрация`;
  const detail = [
    'Для продолжения требуется регистрация.',
    'В офлайн-режиме доступна только страница «Модули Джйотиш».',
  ].join('\n');

  try {
    const { response } = await dialog.showMessageBox(parent, {
      type: 'info',
      buttons: ['Отмена', 'Зарегистрироваться'],
      defaultId: 1,
      cancelId: 0,
      title,
      message: 'Требуется регистрация',
      detail,
      noLink: true,
    });
    return typeof response === 'number' ? response : 0;
  } catch (error) {
    console.warn('Failed to show offline access dialog', error);
    return 0;
  }
});

ipcMain.handle('ui:message-box', async (event, options) => {
  const parent = BrowserWindow.fromWebContents(event?.sender) || null;
  const payload = options && typeof options === 'object' ? options : {};
  const type = payload.type === 'warning' || payload.type === 'error' ? payload.type : 'info';
  const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : APP_DISPLAY_NAME;
  const message = typeof payload.message === 'string' && payload.message.trim() ? payload.message.trim() : '';
  const detail = typeof payload.detail === 'string' && payload.detail.trim() ? payload.detail.trim() : undefined;

  try {
    await dialog.showMessageBox(parent, {
      type,
      buttons: ['OK'],
      defaultId: 0,
      cancelId: 0,
      title,
      message,
      detail,
      noLink: true,
    });
    return true;
  } catch (error) {
    console.warn('Failed to show message box', error);
    return false;
  }
});

ipcMain.handle('chat:open', (event, payload) => {
  const opener = BrowserWindow.fromWebContents(event?.sender);
  openChatWindow(typeof payload === 'string' ? payload : '', opener);
});

ipcMain.handle('blocklist:open', (event) => {
  const opener = BrowserWindow.fromWebContents(event?.sender);
  openBlocklistWindow(opener);
});

ipcMain.handle('updates:check-now', async (event) => {
  const sourceWindow = BrowserWindow.fromWebContents(event?.sender);
  return checkForUpdates({ userInitiated: true, browserWindow: sourceWindow });
});

ipcMain.handle('updates:cancel-download', async (event, options) => {
  const payload = options && typeof options === 'object' ? options : {};
  const closeWindow = Boolean(payload.closeWindow);
  return cancelUpdateDownload({ closeWindow });
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: APP_DISPLAY_NAME,
    icon: APP_ICON,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      devTools: DEVTOOLS_ENABLED,
    },
  });

  // Load React build
  win.loadFile(path.join(__dirname, '../dist/index.html'));
  win.setTitle(APP_DISPLAY_NAME);

  return win;
}

async function ensureCacheDirs() {
  try {
    const userData = app.getPath('userData');
    const cacheBase = path.join(userData, 'cache');
    await fsPromises.mkdir(cacheBase, { recursive: true });

    await fsPromises.mkdir(path.join(cacheBase, 'python-pycache'), { recursive: true });

    cacheRootDir = path.join(cacheBase, CACHE_VERSION);
    cacheImagesDir = path.join(cacheRootDir, 'images');

    await fsPromises.mkdir(cacheRootDir, { recursive: true });
    await fsPromises.mkdir(cacheImagesDir, { recursive: true });
  } catch (error) {
    console.error('Failed to initialize cache directories', error);
    cacheRootDir = '';
    cacheImagesDir = '';
  }
}

app.whenReady().then(async () => {
  registerCustomProtocol();
  buildApplicationMenu();
  if (PREVIEW_UPDATE_DOWNLOAD) {
    await startUpdateDownloadPreview();
    return;
  }
  // Load previously saved identity before evaluating license status
  try {
    const savedIdentity = await readIdentityFromDisk();
    if (savedIdentity.email || savedIdentity.userId) {
      currentLicenseIdentity = savedIdentity;
    }
  } catch {}
  currentLicenseStatus = await refreshLicenseStatus();

  await ensureCacheDirs();
  await runPendingDataMigrations();
  // Чистим только "старые" установщики обновлений, чтобы не ломать отложенную установку.
  await cleanupStaleUpdateInstallers();
  await cleanupStaleInnoInstallers();
  setTimeout(() => {
    cleanupStaleUpdateInstallers().catch(() => undefined);
    cleanupStaleInnoInstallers().catch(() => undefined);
  }, 7000);

  const launchConfig = getBackendLaunchConfig();
  if (!launchConfig) {
    return;
  }

  try {
    const embedPath = app.isPackaged
      ? path.join(process.resourcesPath, 'python-embed', 'python.exe')
      : path.join(__dirname, 'resources', 'python-embed', 'python.exe');
    const envOverride = normalizeQuotedPath(process.env[PYTHON_ENV_VAR]);
    const normalizedExec = normalizeQuotedPath(launchConfig.command);
    const isEmbedded =
      Boolean(normalizedExec) && path.normalize(normalizedExec) === path.normalize(embedPath);
    log.info('[backend] python selected', {
      python: launchConfig.command,
      embeddedExpected: embedPath,
      source: envOverride ? 'env' : isEmbedded ? 'embedded' : 'system',
      env: envOverride || '',
    });
  } catch {}

  const depsResult = ensureBackendDependencies(launchConfig.command);
  if (!depsResult?.ok) {
    const embedPath = app.isPackaged
      ? path.join(process.resourcesPath, 'python-embed', 'python.exe')
      : path.join(__dirname, 'resources', 'python-embed', 'python.exe');
    const logPath = resolveElectronLogFilePath();
    const debug = depsResult?.debug || {};

    try {
      log.error('[backend] Python dependency bootstrap failed', {
        reason: depsResult?.reason || 'unknown',
        debug,
      });
    } catch {}
    if (logPath) {
      try {
        fs.appendFileSync(
          logPath,
          `\n[${new Date().toISOString()}] [backend] Python dependency bootstrap failed: ${depsResult?.reason || 'unknown'}\n`
        );
      } catch {}
    }

    const parts = [];
    parts.push(`Python: ${launchConfig.command}`);
    parts.push(`Embedded: ${embedPath}`);
    if (debug.requirementsPath) parts.push(`requirements.txt: ${debug.requirementsPath}`);
    if (debug.wheelsRoot) parts.push(`wheels: ${debug.wheelsRoot}`);
    if (debug.sitePackagesDir) parts.push(`site-packages: ${debug.sitePackagesDir}`);
    if (debug.pipCommand) parts.push(`\nКоманда установки:\n${debug.pipCommand}`);

    if (depsResult.reason === 'vc-runtime') {
      parts.push(
        '\nПохоже, не установлен Microsoft Visual C++ Redistributable 2015-2022 (x64).\n' +
          'Скачайте и установите, затем перезапустите Synastry:\n' +
          'https://aka.ms/vs/17/release/vc_redist.x64.exe'
      );
    } else if (depsResult.reason === 'vc-dlls-missing') {
      parts.push(
        '\nВ сборке отсутствуют VC++ runtime DLL рядом с python-embed.\n' +
          'Пересоберите установщик с `npm run runtime:prepare` или установите VC++ Runtime:\n' +
          'https://aka.ms/vs/17/release/vc_redist.x64.exe'
      );
    } else if (depsResult.reason === 'python-runtime-missing') {
      parts.push(
        '\nВ папке приложения отсутствует python312.dll (ядро Python), поэтому встроенный Python не запускается.\n' +
          'Переустановите Synastry (или пересоберите установщик, убедившись что `python312.dll` лежит рядом с `python.exe`).'
      );
    } else if (depsResult.reason === 'python-crashed') {
      parts.push(
        '\nВстроенный Python аварийно завершился при запуске (часто из‑за отсутствующих системных DLL/VC++ Runtime).\n' +
          'Установите Microsoft Visual C++ Redistributable 2015-2022 (x64) и перезапустите ПК:\n' +
          'https://aka.ms/vs/17/release/vc_redist.x64.exe\n' +
          'Если проблема остаётся, убедитесь что ОС Windows 10/11 (x64) и антивирус не удалил файлы из папки Synastry.'
      );
    } else if (depsResult.reason === 'pip-missing') {
      parts.push('\nВстроенный Python запустился, но модуль pip не найден.');
    } else if (depsResult.reason === 'pip-failed') {
      parts.push('\nУстановка зависимостей через pip завершилась с ошибкой.');
    }

    const depsCheckIndentationError = /IndentationError:\s*unexpected indent/i.test(String(debug.depsCheckStderr || ''));
    if (depsCheckIndentationError) {
      parts.push(
        '\nОбнаружена ошибка IndentationError в проверке зависимостей (deps-check).\n' +
          'Это баг конкретной версии приложения. Обновите Synastry до последней версии и перезапустите.'
      );
    }
    const pipOsWalkAttrError = /os has no attribute '_walk_symlinks_as_files'/i.test(String(debug.pipStderr || ''));
    if (pipOsWalkAttrError) {
      parts.push(
        '\nОбнаружена ошибка совместимости встроенного Python (os._walk_symlinks_as_files).\n' +
          'Обычно помогает обновление/переустановка Synastry (файлы Python-embed могли быть неполными).'
      );
    }

    if (debug.depsCheckStderr) parts.push(`\nПроверка зависимостей:\n${debug.depsCheckStderr}`);
    if (debug.pipBootstrapStderr) parts.push(`\npip bootstrap stderr:\n${debug.pipBootstrapStderr}`);
    if (debug.pipBootstrapStdout) parts.push(`\npip bootstrap stdout:\n${debug.pipBootstrapStdout}`);
    if (debug.pipStderr) parts.push(`\npip stderr:\n${debug.pipStderr}`);
    if (debug.error) parts.push(`\nОшибка запуска:\n${debug.error}`);
    if (logPath) parts.push(`\nЛоги: ${logPath}`);

    const vcRedistUrl = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
    const shouldOfferVcRedist =
      depsResult.reason === 'vc-runtime' || depsResult.reason === 'vc-dlls-missing' || depsResult.reason === 'python-crashed';

    if (shouldOfferVcRedist) {
      const clicked = dialog.showMessageBoxSync({
        type: 'error',
        buttons: ['Скачать VC++ Runtime', 'OK'],
        defaultId: 0,
        cancelId: 1,
        title: 'Ошибка зависимостей Python',
        message: 'Не удалось запустить встроенный Python / установить зависимости.',
        detail: parts.join('\n'),
        noLink: true,
      });
      if (clicked === 0) {
        shell.openExternal(vcRedistUrl).catch(() => undefined);
      }
      return;
    }

    dialog.showErrorBox('Ошибка зависимостей Python', parts.join('\n'));
    return;
  }

  startBackendProcess(launchConfig);

  const mainWindow = createWindow();
  primaryWindow = mainWindow;
  mainWindow.on('closed', () => {
    if (primaryWindow === mainWindow) {
      primaryWindow = null;
    }
  });

  setupAutoUpdate(mainWindow);
  if (app.isPackaged && ALLOW_AUTO_UPDATE) {
    checkForUpdates({ userInitiated: false }).catch((error) => {
      log.error('Automatic update check failed', error);
    });
  }

  mainWindow.webContents.once('did-finish-load', () => {
    if (currentLicenseStatus) {
      mainWindow.webContents.send('license:status', currentLicenseStatus);
      if (!currentLicenseStatus.allowed) {
        setTimeout(() => {
          triggerLicensePrompt(mainWindow);
        }, 300);
      } else if (!currentLicenseStatus.licensed) {
        mainWindow.webContents.send(TRIAL_PROMPT_CHANNEL, currentLicenseStatus);
      }
    }
    deliverAuthLinkToWindow(mainWindow);
});

function shutdownBackend() {
  if (backendProcess && !backendProcess.killed) {
    try {
      backendProcess.kill('SIGTERM');
    } catch (err) {
      log.warn('Failed to kill backend process', err);
    }
    backendProcess = null;
  }
}

app.on('before-quit', () => {
  isQuitting = true;
  shutdownBackend();
});

app.on('window-all-closed', () => {
  shutdownBackend();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      const newWindow = createWindow();
      primaryWindow = newWindow;
      newWindow.on('closed', () => {
        if (primaryWindow === newWindow) {
          primaryWindow = null;
        }
      });
      newWindow.webContents.once('did-finish-load', () => {
        if (currentLicenseStatus) {
          newWindow.webContents.send('license:status', currentLicenseStatus);
          if (!currentLicenseStatus.allowed) {
            setTimeout(() => {
              triggerLicensePrompt(newWindow);
            }, 300);
          } else if (!currentLicenseStatus.licensed) {
            newWindow.webContents.send(TRIAL_PROMPT_CHANNEL, currentLicenseStatus);
          }
        }
        deliverAuthLinkToWindow(newWindow);
      });
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
  if (backendProcess) {
    backendProcess.kill();
  }
  primaryWindow = null;
});


