import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron';
import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyLicenseKey } from './license.js';

const fsPromises = fs.promises;

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

const APP_DISPLAY_NAME = 'Synastry';
const APP_VERSION = 'v1.0 (beta)';
const TRIAL_DAYS = 10;
const TRIAL_FILE_NAME = 'trial-info.json';
const LICENSE_FILE_NAME = 'license-info.json';
const IDENTITY_FILE_NAME = 'identity-info.json';
const DAY_MS = 24 * 60 * 60 * 1000;

const LICENSE_CONTACT = {
  email: 'pilot.vt@mail.ru',
  telegram: '@PilotVT',
};
const DIST_INDEX_FILE = path.join(__dirname, '../dist/index.html');

let currentLicenseStatus = null;
let licensePromptWindow = null;
let currentLicenseIdentity = {
  email: null,
  userId: null,
};
const chatWindows = new Set();
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
      label: 'Справка',
      submenu: [
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

async function ensureTrialInfo() {
  const trialFilePath = path.join(app.getPath('userData'), TRIAL_FILE_NAME);
  const now = Date.now();

  try {
    const payload = await readJsonFileSafe(trialFilePath);
    if (typeof payload?.firstLaunchMs === 'number') {
      return { filePath: trialFilePath, firstLaunchMs: payload.firstLaunchMs };
    }
    throw new Error('Malformed trial payload');
  } catch (error) {
    const payload = { firstLaunchMs: now };
    await writeJsonFileSafe(trialFilePath, payload);
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
    height: 360,
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

function resolvePythonExecutable() {
  if (app.isPackaged) {
    const scriptsDir = process.platform === 'win32' ? 'Scripts' : 'bin';
    const exeName = process.platform === 'win32' ? 'python.exe' : 'python';
    return path.join(process.resourcesPath, 'python', scriptsDir, exeName);
  }
  return process.env[PYTHON_ENV_VAR]?.trim() || 'python';
}

function getBackendLaunchConfig() {
  const pythonExecutable = resolvePythonExecutable();
  const baseEnv = { ...process.env, SYN_BACKEND_HOST: BACKEND_HOST, SYN_BACKEND_PORT: BACKEND_PORT };

  if (app.isPackaged) {
    const resourceRoot = process.resourcesPath;
    const unpackedDir = path.join(resourceRoot, 'app.asar.unpacked');
    const legacyAppDir = path.join(resourceRoot, 'app');
    const existingEntries = [
      resourceRoot,
      fs.existsSync(unpackedDir) ? unpackedDir : null,
      fs.existsSync(legacyAppDir) ? legacyAppDir : null,
    ].filter(Boolean);
    const inheritedEntries = baseEnv.PYTHONPATH
      ? baseEnv.PYTHONPATH.split(path.delimiter).filter((entry) => entry && entry.trim().length > 0)
      : [];
    const pyPath = [...existingEntries, ...inheritedEntries].filter((entry, index, arr) => arr.indexOf(entry) === index).join(path.delimiter);
    return {
      command: pythonExecutable,
      args: ['-m', 'app'],
      options: {
        cwd: resourceRoot,
        shell: false,
        detached: false,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...baseEnv,
          SYN_RESOURCE_ROOT: resourceRoot,
          PYTHONPATH: pyPath,
        },
      },
    };
  }

  const projectRoot = path.join(__dirname, '..');
  const stdio = process.env.ELECTRON_BACKEND_STDIO || 'inherit';
  const devPyPath = baseEnv.PYTHONPATH ? `${projectRoot}${path.delimiter}${baseEnv.PYTHONPATH}` : projectRoot;
  return {
    command: pythonExecutable,
    args: ['-m', 'app'],
    options: {
      cwd: projectRoot,
      shell: false,
      detached: false,
      stdio,
      windowsHide: true,
      env: {
        ...baseEnv,
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

  const launchConfig = getBackendLaunchConfig();

  if (app.isPackaged && !fs.existsSync(launchConfig.command)) {
    const message = `Не найден встроенный интерпретатор Python по пути:\n${launchConfig.command}\n\nУбедитесь, что перед сборкой выполнена команда \"npm run backend:setup\".`;
    dialog.showErrorBox('Ошибка запуска бэкенда', message);
  } else {
    try {
      backendProcess = spawn(launchConfig.command, launchConfig.args, launchConfig.options);

      backendProcess.on('error', (error) => {
        console.error('Failed to launch backend process:', error);
        const packagedHint = app.isPackaged
          ? 'Убедитесь, что в поставке присутствует папка resources/python. При самостоятельной сборке запустите "npm run backend:setup" перед "npm run desktop:build".'
          : `Убедитесь, что Python установлен и доступен в PATH, либо задайте переменную окружения ${PYTHON_ENV_VAR} с путём до python.exe.`;
        dialog.showErrorBox(
          'Ошибка запуска бэкенда',
          `Не удалось запустить сервер Python. ${packagedHint}\n\n${error.message}`
        );
      });
    } catch (error) {
      console.error('Unexpected error while spawning backend process:', error);
      const packagedHint = app.isPackaged
        ? 'Убедитесь, что встроенный Python находится в папке resources/python и был подготовлен командой "npm run backend:setup".'
        : `Проверьте установку Python или переменную ${PYTHON_ENV_VAR}.`;
      dialog.showErrorBox(
        'Ошибка запуска бэкенда',
        `Не удалось запустить сервер Python. ${packagedHint}\n\n${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const mainWindow = createWindow();

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

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      const newWindow = createWindow();
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
});


