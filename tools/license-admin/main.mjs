/**
 * 图库授权管理工具 · Electron 入口。
 *
 * 目标：作者双击 exe 就能打开一个真正的窗口，不再依赖命令行。
 * - 只在本机 127.0.0.1 上起一个随机端口的管理服务；
 * - 私钥优先从环境变量 / 用户数据目录 / exe 同目录 / 仓库根查找；
 * - 找不到时弹窗让作者选择 .license-private.pem，并保存到用户数据目录；
 * - 授权记录保存在用户数据目录（安装版）或仓库 licenses/（开发态）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import { startAdminServer } from './server.mjs';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEV_ROOT = path.resolve(APP_DIR, '..', '..');
const KEY_FILES = ['.license-private.pem', 'license-private.pem'];

let serverHandle = null;
let win = null;

app.setName('图库授权管理');

function fileText(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.includes('PRIVATE KEY') ? text : '';
  } catch {
    return '';
  }
}

function parentDirs(start, depth) {
  const out = [start];
  let dir = start;
  for (let i = 0; i < depth; i++) {
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
    out.push(dir);
  }
  return out;
}

function findPrivateKey() {
  if (process.env.TUKU_LICENSE_PRIVATE_KEY) return process.env.TUKU_LICENSE_PRIVATE_KEY;

  const userDir = app.getPath('userData');
  const exeDir = path.dirname(process.execPath);
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR || '';
  const dirs = [
    userDir,
    ...parentDirs(exeDir, 5),
    ...(portableDir ? [portableDir, ...parentDirs(portableDir, 4)] : []),
    APP_DIR,
    ...parentDirs(APP_DIR, 3),
    process.cwd(),
  ];
  for (const dir of [...new Set(dirs)]) {
    for (const name of KEY_FILES) {
      const key = fileText(path.join(dir, name));
      if (key) return key;
    }
  }
  return '';
}

/** 安装版首次运行：弹窗选择私钥，保存到用户数据目录，之后双击即用 */
async function ensurePrivateKey() {
  const found = findPrivateKey();
  if (found) return found;
  if (!app.isPackaged) return '';

  const choice = await dialog.showMessageBox({
    type: 'warning',
    title: '需要授权私钥',
    message: '没有找到授权私钥',
    detail:
      '签发和停用授权需要 .license-private.pem。\n\n' +
      '可以把它放在 exe 同目录，或点击「选择私钥文件」导入；导入后会保存到本机用户数据目录。',
    buttons: ['选择私钥文件', '退出'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (choice.response !== 0) return '';

  const picked = await dialog.showOpenDialog({
    title: '选择授权私钥（.license-private.pem）',
    properties: ['openFile'],
    filters: [{ name: 'PEM 私钥', extensions: ['pem', 'key', 'txt'] }],
  });
  if (picked.canceled || !picked.filePaths[0]) return '';

  const key = fileText(picked.filePaths[0]);
  if (!key) {
    dialog.showErrorBox('私钥格式不正确', '选中的文件不是 PEM 私钥（应包含 PRIVATE KEY）。');
    return '';
  }
  try {
    const userDir = app.getPath('userData');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, '.license-private.pem'), key, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    dialog.showErrorBox('保存私钥失败', err instanceof Error ? err.message : String(err));
  }
  return key;
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: '图库 · 授权管理',
    backgroundColor: '#0e1117',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  win.once('ready-to-show', () => {
    win?.show();
    win?.focus();
  });
  win.on('closed', () => {
    win = null;
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target) && !target.startsWith('http://127.0.0.1')) {
      void shell.openExternal(target);
    }
    return { action: 'deny' };
  });
  void win.loadURL(url);
}

async function boot() {
  Menu.setApplicationMenu(null);
  const privateKey = await ensurePrivateKey();

  const dataDir = app.isPackaged
    ? path.join(app.getPath('userData'), 'licenses')
    : path.join(DEV_ROOT, 'licenses');

  try {
    serverHandle = await startAdminServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      privateKey,
      autoOpen: false,
      quiet: true,
    });
  } catch (err) {
    dialog.showErrorBox('授权管理工具启动失败', err instanceof Error ? err.message : String(err));
    app.quit();
    return;
  }

  createWindow(serverHandle.url);
  if (!privateKey) {
    const notice = {
      type: 'info',
      title: '未加载授权私钥',
      message: '当前只能查看授权记录，不能签发 / 停用',
      detail: '请把 .license-private.pem 放到程序目录或用户数据目录，然后重新打开工具。',
    };
    if (win) void dialog.showMessageBox(win, notice);
    else void dialog.showMessageBox(notice);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(boot).catch((err) => {
    dialog.showErrorBox('授权管理工具启动失败', err instanceof Error ? err.message : String(err));
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverHandle) createWindow(serverHandle.url);
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('will-quit', () => {
    void serverHandle?.close();
  });
}
