// Electron 外壳：拉起本地后端，再开一个原生窗口指向它。
// 开发态：用系统 node 跑 backend/；打包态：用 resources/node/node.exe 跑 resources/backend/。
const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const PORT = 47910;
const URL = `http://127.0.0.1:${PORT}`;

let backend = null;

function backendRunning() {
  return new Promise((resolve) => {
    const req = http.get(URL, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => { req.destroy(); resolve(false); });
  });
}

async function waitForBackend(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await backendRunning()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function backendCommand() {
  if (app.isPackaged) {
    return {
      node: path.join(process.resourcesPath, 'node', 'node.exe'),
      entry: path.join(process.resourcesPath, 'backend', 'src', 'index.js'),
      env: {
        TAGGER_DATA_DIR: path.join(app.getPath('userData'), 'data'),
        TAGGER_TAGS_FILE: path.join(process.resourcesPath, 'config', 'tags.json'),
        TAGGER_WEB_DIST: path.join(process.resourcesPath, 'web', 'dist'),
      },
    };
  }
  return {
    node: 'node',
    entry: path.join(__dirname, '..', 'backend', 'src', 'index.js'),
    env: {},
  };
}

async function startBackend() {
  if (await backendRunning()) return true;
  const { node, entry, env } = backendCommand();
  backend = spawn(node, [entry], {
    cwd: app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'),
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  backend.on('exit', () => { backend = null; });
  return waitForBackend();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(URL);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  const ok = await startBackend();
  if (!ok) {
    console.error('[electron] 后端启动失败。开发态需安装 Node 24；打包态请确认 resources 内含 node/backend。');
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (backend) backend.kill();
  if (process.platform !== 'darwin') app.quit();
});
