// Electron 外壳：拉起本地后端，再开一个原生窗口指向它。
// 开发态：用系统 node 跑 backend/；打包态：用 resources/node/node.exe 跑 resources/backend/。
const { app, BrowserWindow, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const PORT = 47910;
const URL = `http://127.0.0.1:${PORT}`;

let backend = null;
let backendReady = false; // 后端曾成功启动过；退出时用于区分「主动关闭」与「异常退出」
let quitting = false;

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
  if (await backendRunning()) return true; // 已有实例（如手动 npm start）则直接复用
  const { node, entry, env } = backendCommand();
  backend = spawn(node, [entry], {
    cwd: app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'),
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  backend.on('error', (e) => { console.error('[electron] 后端进程启动失败:', e.message); backend = null; });
  backend.on('exit', (code) => {
    backend = null;
    // 窗口在用期间后端意外退出（非用户主动退出应用）→ 明确报错而不是白屏
    if (backendReady && !quitting && BrowserWindow.getAllWindows().length) {
      dialog.showErrorBox('后端已退出', `本地服务进程意外退出（code ${code}）。\n常见原因：端口 ${PORT} 被其他进程占用，或依赖缺失。`);
    }
  });
  const ok = await waitForBackend();
  backendReady = ok;
  return ok;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: '#0d1017',
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
  // 开发态：前端没构建时给出明确指引（否则窗口白屏）
  if (!app.isPackaged) {
    const dist = path.join(__dirname, '..', 'web', 'dist', 'index.html');
    if (!fs.existsSync(dist)) {
      const r = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['继续打开', '退出'],
        defaultId: 0,
        message: '前端尚未构建',
        detail: '未找到 web/dist/index.html，界面会是空白。\n请先在项目根目录执行：npm run build:web',
      });
      if (r.response === 1) { app.quit(); return; }
    }
  }

  const ok = await startBackend();
  if (!ok) {
    dialog.showErrorBox('后端启动失败',
      `本地服务未能在 30 秒内启动（http://127.0.0.1:${PORT}）。\n\n常见原因：\n· 端口 ${PORT} 被占用（可结束旧的 node 进程后重试）\n· 开发态未安装 Node 24 或未执行 npm install\n· 打包态 resources 内缺少 node / backend\n\n命令行启动可看到详细输出。`);
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => {
  if (backend) backend.kill();
  if (process.platform !== 'darwin') app.quit();
});
