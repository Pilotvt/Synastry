import electron from 'electron';
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = electron;
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
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

const CACHE_VERSION = 'v1';
let cacheRootDir = '';
let cacheImagesDir = '';

let backendProcess = null;
let currentOnlineStatus = true;
const PYTHON_ENV_VAR = 'SYN_PYTHON_PATH';
const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = process.env.SYN_BACKEND_PORT || '8000';
// Use piped IO by default to avoid terminal escape codes polluting logs; can override via ENV if needed.
const BACKEND_STDIO = process.env.ELECTRON_BACKEND_STDIO || 'pipe';

const APP_DISPLAY_NAME = 'Synastry';
const APP_VERSION = `${app.getVersion()}`;
// Автообновление включено по умолчанию; можно отключить через SYN_AUTOUPDATE=0 при необходимости.
const ALLOW_AUTO_UPDATE = process.env.SYN_AUTOUPDATE !== '0';
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
let autoUpdateErrorNotified = false;
const manualUpdateState = {
  pending: false,
  window: null,
};

let currentLicenseStatus = null;
let licensePromptWindow = null;
let currentLicenseIdentity = {
  email: null,
  userId: null,
};
const chatWindows = new Set();
const blocklistWindows = new Set();
const TRIAL_PROMPT_CHANNEL = 'license:show-trial-warning';
// Включено: лицензионная логика и интерфейс активны
const DISABLE_LICENSE_UI = false;
const CUSTOM_PROTOCOL = 'synastry';
const AUTH_CALLBACK_PATH = '/auth-callback';
const AUTH_DEEP_LINK_CHANNEL = 'auth:deep-link';

let pendingAuthDeepLink = null;

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function openChatWindow(encodedPayload, opener) {
  if (typeof encodedPayload !== 'string' || !encodedPayload.trim()) return;
  const chatWindow = new BrowserWindow({
    width: 520,
    height: 680,
    minWidth: 480,
    minHeight: 560,
    title: `${APP_DISPLAY_NAME} — Чат`,
    autoHideMenuBar: true,
    parent: opener && !opener.isDestroyed() ? opener : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      devTools: true,
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
    autoHideMenuBar: true,
    parent: opener && !opener.isDestroyed() ? opener : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      devTools: true,
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

function showAboutDialog(parent) {
  const title = `О программе — ${APP_DISPLAY_NAME} ${APP_VERSION}`;
  const detail = [
    'Назначение: офлайн/десктоп-приложение для расчёта натальных карт, синастрии и мухурты.',
    'В основе используются реальные звёздные созвездия (IAU) и положения планет, поэтому не требуется аянамша.',
    '',
    'Автор: Виталий Алексеев',
    'Обучение Джйотиш и вопросы по программе:',
    'Telegram: @PilotVT',
    'Email: pilot.vt@mail.ru',
    'Канал в Telegram: t.me/yasnosun — Веды. Астрология. Ясновидение. Сонник.',
    'RUTUBE: https://rutube.ru/channel/24373966/ — Разум вселенной.',
    'YouTube: https://www.youtube.com/@universe_mind_369 — Universe mind.',
  ].join('\n');

  dialog.showMessageBox(parent ?? null, {
    type: 'info',
    buttons: ['OK'],
    defaultId: 0,
    title,
    message: APP_DISPLAY_NAME,
    detail,
    noLink: true,
  });
}

function normalizeAuthDeepLink(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return null;
  try {
    const urlObj = new URL(rawUrl);
    if (urlObj.protocol !== `${CUSTOM_PROTOCOL}:`) {
      return null;
    }
      const pathname = urlObj.pathname || '';
        const sanitized = pathname.replace(/\\/g, '/');
        const normalizedPath = sanitized.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    if (normalizedPath !== AUTH_CALLBACK_PATH) {
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

function broadcastUpdateStatus(payload) {
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

function formatReleaseNotes(releaseNotes) {
  if (!releaseNotes) {
    return '';
  }
  if (typeof releaseNotes === 'string') {
    return releaseNotes;
  }
  if (Array.isArray(releaseNotes)) {
    return releaseNotes
      .map((entry) => {
        if (!entry) return '';
        if (typeof entry === 'string') return entry;
        if (typeof entry.note === 'string') return entry.note;
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

function setupAutoUpdate(window) {
  if (!ALLOW_AUTO_UPDATE) {
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
        message: '��⠭������ �� ���������: ������ ��㯭� �� ������.',
      });
      return;
    }
    broadcastUpdateStatus({ type: 'available', info });
    const target = getDialogTarget();
    const versionLabel = info?.version ? `версия ${info.version}` : 'обновление';
    const releaseNotes = formatReleaseNotes(info?.releaseNotes);
    const detailParts = ['Приложение скачает установщик из GitHub Releases и предложит перезапуск после загрузки.'];
    if (releaseNotes) {
      detailParts.push('', releaseNotes);
    }

    try {
      const { response } = await dialog.showMessageBox(target ?? null, {
        type: 'info',
        buttons: ['Скачать и установить', 'Позже'],
        defaultId: 0,
        cancelId: 1,
        title: 'Доступно обновление',
        message: `Доступна ${versionLabel}.`,
        detail: detailParts.join('\n'),
        noLink: true,
      });

      if (response === 0) {
        if (isDownloadingUpdate) {
          return;
        }
        isDownloadingUpdate = true;
        try {
          await autoUpdater.downloadUpdate();
        } catch (error) {
          isDownloadingUpdate = false;
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
    resolveManualUpdateRequest({
      message: 'Установлена последняя версия.',
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    broadcastUpdateStatus({ type: 'download-progress', info: progress });
  });

  autoUpdater.on('update-downloaded', (info) => {
    isDownloadingUpdate = false;
    broadcastUpdateStatus({ type: 'downloaded', info });
    const target = getDialogTarget();
    dialog
      .showMessageBox(target ?? null, {
        type: 'info',
        buttons: ['Перезапустить и установить', 'Позже'],
        defaultId: 0,
        cancelId: 1,
        title: 'Обновление загружено',
        message: 'Новая версия загружена. Установить сейчас?',
        detail: 'Приложение будет закрыто и перезапущено автоматически.',
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
    broadcastUpdateError({ message: 'auto-update-error', detail: error?.message ?? '' });

    if (manualUpdateState.pending) {
      resolveManualUpdateRequest({
        type: 'error',
        message: 'Не удалось проверить обновления. Попробуйте позже.',
        detail: error?.message ?? '',
      });
      return;
    }

    if (autoUpdateErrorNotified) {
      return;
    }
    autoUpdateErrorNotified = true;
    const target = getDialogTarget();
    dialog.showMessageBox(target ?? null, {
      type: 'error',
      title: MANUAL_UPDATE_DIALOG_TITLE,
      message: 'Не удалось проверить обновления. Попробуйте позже.',
      detail: error?.message ?? '',
      noLink: true,
    });
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
    if (userInitiated) {
      resolveManualUpdateRequest({
        type: 'error',
        message: 'Не удалось проверить обновления. Попробуйте позже.',
        detail: error?.message ?? '',
      });
    } else if (!autoUpdateErrorNotified) {
      const target = getDialogTarget();
      dialog.showMessageBox(target ?? null, {
        type: 'error',
        title: MANUAL_UPDATE_DIALOG_TITLE,
        message: 'Не удалось проверить обновления. Попробуйте позже.',
        detail: error?.message ?? '',
        noLink: true,
      });
      autoUpdateErrorNotified = true;
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
    const names = [`${app.getName().toLowerCase()}-updater`, 'synastry-ui-updater'];
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
          label: 'О программе',
          click: (_item, browserWindow) => showAboutDialog(browserWindow || BrowserWindow.getFocusedWindow()),
        },
      ],
    },
    {
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
  ];

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
    width: 420,
    height: 440,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: `${APP_DISPLAY_NAME} — активация лицензии`,
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
    const envOverride = process.env[PYTHON_ENV_VAR]?.trim();
    if (envOverride && fs.existsSync(envOverride)) return envOverride;
    const embedded = resolveEmbeddedPython();
    if (embedded) return embedded;
    const systemPy = findSystemPython();
    if (systemPy) return systemPy;
    return null;
  }

function resolveNudeNetModelPath(isPackaged) {
  if (isPackaged) {
    const bundled = path.join(process.resourcesPath, 'nudenet', '320n.onnx');
    if (fs.existsSync(bundled)) return bundled;
    return null;
  }
  const projectRoot = path.join(__dirname, '..');
  const devModel = path.join(projectRoot, 'app', 'nudenet', '320n.onnx');
  if (fs.existsSync(devModel)) return devModel;
  return null;
}

  function ensureBackendDependencies(pythonExecutable) {
    const checkScript = `
import importlib, sys
mods = ["nudenet", "uvicorn", "fastapi", "numpy", "scipy", "astropy", "skyfield", "swisseph", "PIL"]
missing = []
for m in mods:
    try:
        importlib.import_module(m)
    except Exception:
        missing.append(m)
if missing:
    sys.exit(99)
`;

    const checkResult = spawnSync(pythonExecutable, ['-c', checkScript], { shell: false, windowsHide: true });
    if (checkResult.status === 0) {
      return true;
    }

    const requirementsPath = app.isPackaged
      ? path.join(process.resourcesPath, 'requirements.txt')
      : path.join(__dirname, '..', 'requirements.txt');

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

    const wheelsRoot = app.isPackaged
      ? path.join(process.resourcesPath, 'wheels')
      : path.join(__dirname, 'resources', 'wheels');

    const useOffline = fs.existsSync(wheelsRoot);
    const sitePackagesDir = app.isPackaged
      ? path.join(process.resourcesPath, 'python-embed', 'Lib', 'site-packages')
      : null;
    if (sitePackagesDir) {
      try {
        fs.mkdirSync(sitePackagesDir, { recursive: true });
      } catch (err) {
        console.error('Failed to ensure site-packages dir', err);
      }
    }
    const wheelsExists = useOffline && fs.existsSync(wheelsRoot);
    // распакуем pip whl, если pip отсутствует
    if (wheelsExists && sitePackagesDir) {
      try {
        const pipWheel = fs.readdirSync(wheelsRoot).find((f) => f.startsWith('pip-') && f.endsWith('.whl'));
        if (pipWheel) {
          const pipPath = path.join(wheelsRoot, pipWheel);
          const unzipScript = `
import zipfile
zipfile.ZipFile(r"${pipPath.replace(/\\\\/g, '\\\\\\\\')}").extractall(r"${sitePackagesDir.replace(/\\\\/g, '\\\\\\\\')}")
`;
          spawnSync(pythonExecutable, ['-c', unzipScript], { shell: false, stdio: 'pipe', windowsHide: true });
        }
      } catch (err) {
        console.error('Failed to unzip pip wheel', err);
      }
    }

    // ensure pip exists (skip when ensurepip module is absent in the embedded build)
    let ensurepipAvailable = false;
    try {
      const probe = spawnSync(pythonExecutable, ['-c', 'import ensurepip'], { shell: false, windowsHide: true });
      ensurepipAvailable = probe.status === 0;
    } catch {
      ensurepipAvailable = false;
    }
    if (ensurepipAvailable) {
      try {
        spawnSync(pythonExecutable, ['-m', 'ensurepip', '--default-pip'], { shell: false, stdio: 'pipe', windowsHide: true });
      } catch (err) {
        console.error('ensurepip failed', err);
      }
    } else if (!wheelsExists) {
      console.warn('ensurepip module not available and no bundled pip wheel found');
    }

    // offline pip install
    const baseInstallArgs = [
      '-m',
      'pip',
      'install',
      '--no-warn-script-location',
      '--disable-pip-version-check',
      '--upgrade',
      '--no-index', '--find-links', wheelsRoot,
      '--target', sitePackagesDir || '',
      '-r', tmpReqPath,
    ];
    const env = {
      ...process.env,
      PYTHONPATH: sitePackagesDir
        ? `${sitePackagesDir}${path.delimiter}${process.env.PYTHONPATH || ''}`
        : process.env.PYTHONPATH || '',
    };

    const installResult = spawnSync(
      pythonExecutable,
      baseInstallArgs,
      { shell: false, stdio: 'pipe', env, windowsHide: true }
    );
    return installResult.status === 0;
  }

  function parsePythonCommand(command) {
    if (!command) return { exec: null, extraArgs: [] };
    const parts = command
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .split(/\s+/)
      .filter(Boolean);
    const exec = parts.shift() ?? null;
    return { exec, extraArgs: parts };
  }

  function getBackendLaunchConfig() {
    const pythonExecutable = resolvePythonExecutable();
    if (!pythonExecutable) {
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
        title: 'Требуется Python 3.12+',
        message: 'Не найден системный Python 3.12+. Без него Synastry не запустится.',
        detail: fs.existsSync(installerPath)
          ? 'Нажмите "Установить Python", чтобы установить Python 3.13.9 (x64) в автоматическом режиме.'
          : 'Откроется страница python.org, скачайте и установите Python 3.12+ (x64), затем перезапустите Synastry.',
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
      return {
      command: effectiveExec,
      args: [...parsedArgs, '-m', 'app'],
      options: {
        cwd: resourceRoot,
        shell: false,
        detached: false,
          stdio: BACKEND_STDIO,
          windowsHide: true,
          env: {
            ...baseEnv,
            ...nudenetEnv,
            SYN_RESOURCE_ROOT: resourceRoot,
            PYTHONPATH: pyPath,
          },
        },
      };
    }

  const projectRoot = path.join(__dirname, '..');
  const devPyPath = baseEnv.PYTHONPATH ? `${projectRoot}${path.delimiter}${baseEnv.PYTHONPATH}` : projectRoot;
    return {
      command: effectiveExec,
      args: [...parsedArgs, '-m', 'app'],
      options: {
        cwd: projectRoot,
      shell: false,
      detached: false,
      stdio: BACKEND_STDIO,
      windowsHide: true,
        env: {
          ...baseEnv,
          ...nudenetEnv,
          SYN_RESOURCE_ROOT: projectRoot,
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

function attachBackendProcessLogging(proc) {
  if (!proc) return;

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
    log.warn(`[backend] exited with code=${code} signal=${signal ?? 'none'}`);
    if (proc === backendProcess) {
      backendProcess = null;
    }
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: APP_DISPLAY_NAME,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      devTools: true,
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
  await cleanupUpdaterCache();

  const launchConfig = getBackendLaunchConfig();
  if (!launchConfig) {
    return;
  }

  if (!ensureBackendDependencies(launchConfig.command)) {
    dialog.showErrorBox(
      'Ошибка зависимостей Python',
      'Не удалось установить нужные пакеты (nudenet/uvicorn и др.). Проверьте интернет или установите вручную: pip install -r requirements.txt'
    );
    return;
  }

  try {
    backendProcess = spawn(launchConfig.command, launchConfig.args, {
      ...launchConfig.options,
      shell: false,
    });
    attachBackendProcessLogging(backendProcess);
    backendProcess.on('error', (error) => {
      console.error('Failed to launch backend process:', error);
      dialog.showErrorBox(
        'Ошибка запуска бэкенда',
        `Не удалось запустить Python по пути:\n${launchConfig.command}\n\n` +
          'Установите или переустановите Python 3.12+ (x64). ' +
          'В дистрибутив включён python-3.13.9-amd64.exe в папке resources/python-installer.'
      );
    });
  } catch (error) {
    console.error('Unexpected error while spawning backend process:', error);
    dialog.showErrorBox(
      'Ошибка запуска бэкенда',
      `Не удалось запустить Python.\n\n${error instanceof Error ? error.message : String(error)}`
    );
  }

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


