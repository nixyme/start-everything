const { app, BrowserWindow, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const ProjectStore = require('./store');
const Scheduler = require('./scheduler');
const { registerIpcHandlers } = require('./ipc-handlers');
const { initLogger, getLogger } = require('./logger');

let mainWindow;
let store;
let scheduler;

const isDev = !app.isPackaged;

const iconPath = isDev
  ? path.join(__dirname, '../../build/icon.png')
  : path.join(process.resourcesPath, 'build', 'icon.png');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 840,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, '../preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    backgroundColor: '#0F172A',
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

// === Auto Updater ===
// 不使用 electron-updater（需要 Apple 签名），改用 GitHub API 手动检查
// 流程：检查版本 → 显示新版本 → 用户点击下载 → 浏览器打开 DMG

// 激活主窗口（从任意位置唤起）
function activateMainWindow() {
  if (!mainWindow) return;
  // macOS 需要先 show app 才能 focus window
  if (process.platform === 'darwin') {
    app.show();   // 从 Dock 隐藏状态恢复
    app.focus({ steal: true });
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

app.whenReady().then(() => {
  // 初始化数据层（需要 userDataPath，先于 logger 初始化）
  const userDataPath = app.getPath('userData');
  store = new ProjectStore(userDataPath);

  // 初始化结构化日志（日志文件写入 userData/logs/）
  initLogger(userDataPath);
  const log = getLogger();

  // macOS Dock 图标
  if (process.platform === 'darwin' && app.dock) {
    try {
      const icon = nativeImage.createFromPath(iconPath);
      if (!icon.isEmpty()) app.dock.setIcon(icon);
    } catch (e) {
      log.error({
        event: 'error_occurred',
        status: 'failed',
        decision_reason: 'dock_icon_load_failed',
        error: e.message,
      }, 'Dock icon setup failed');
    }
  }

  log.info({
    event: 'system_started',
    status: 'success',
    version: app.getVersion(),
    platform: process.platform,
    userDataPath,
  }, 'Application started');

  // 初始化调度引擎
  scheduler = new Scheduler(store, () => mainWindow);
  scheduler.init();

  // 注册 IPC 处理
  registerIpcHandlers(store, null, () => mainWindow, scheduler);

  // 直接创建窗口
  mainWindow = createWindow();

  // 恢复全局快捷键
  const savedShortcut = store.getSetting('globalShortcut');
  if (savedShortcut) {
    try {
      globalShortcut.register(savedShortcut, activateMainWindow);
    } catch (e) {
      log.error({
        event: 'error_occurred',
        status: 'failed',
        decision_reason: 'shortcut_register_failed',
        shortcut: savedShortcut,
        error: e.message,
      }, 'Failed to register global shortcut');
    }
  }
});

app.on('will-quit', () => {
  if (scheduler) scheduler.shutdown();
  globalShortcut.unregisterAll();
  getLogger().info({
    event: 'system_stopped',
    status: 'success',
  }, 'Application stopped');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
  }
});
