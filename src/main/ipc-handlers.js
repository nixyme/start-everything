const { ipcMain, dialog, shell, BrowserWindow, app, globalShortcut } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getLogger } = require('./logger');

// Shell 特殊字符转义（防注入）
function escapeShellArg(str) {
  return str.replace(/(["\\s'$`\\\\!#&|;(){}])/g, '\\$1');
}

// 解析工作目录：空路径回退到桌面
function resolveWorkDir(projectPath) {
  if (projectPath && fs.existsSync(projectPath)) return projectPath;
  return app.getPath('desktop');
}

// 校验路径是否为已注册项目（空路径也视为合法）
function isRegisteredProject(store, projectPath) {
  const projects = store.getAllProjects();
  return projects.some((p) => p.path === projectPath);
}

// 智能处理命令路径：自动补 ./ 并给含空格的路径加单引号
// 返回 shell 安全的命令字符串
// mode: 'terminal' 或 'silent'，用于区分终端模式和静默模式
function normalizeCommandPath(command, projectPath, mode = 'terminal') {
  // 已经被引号包裹的，不处理
  if (command.startsWith('"') || command.startsWith("'")) return command;

  // 尝试整条命令或逐词缩短，找到存在的文件路径
  const words = command.split(/\s+/);
  for (let i = words.length; i >= 1; i--) {
    const candidate = words.slice(0, i).join(' ');
    const rest = i < words.length ? ' ' + words.slice(i).join(' ') : '';

    // 相对路径：拼接项目目录检查
    if (!candidate.startsWith('/') && !candidate.startsWith('./') && !candidate.startsWith('~')) {
      const fullPath = path.join(projectPath, candidate);
      if (fs.existsSync(fullPath)) {
        // macOS .app 应用：终端模式使用 open，静默模式执行内部可执行文件
        if (fullPath.endsWith('.app')) {
          if (mode === 'terminal') {
            return `open '${fullPath.replace(/'/g, "'\\''")}'` + rest;
          } else {
            // 静默模式：尝试执行 .app 内部的可执行文件
            const appName = path.basename(fullPath, '.app');
            const execPath = path.join(fullPath, 'Contents', 'MacOS', appName);
            if (fs.existsSync(execPath)) {
              return `'${execPath.replace(/'/g, "'\\''")}'` + rest;
            }
            // 如果找不到可执行文件，还是用 open
            return `open '${fullPath.replace(/'/g, "'\\''")}'` + rest;
          }
        }
        const safePath = './' + candidate.replace(/'/g, "'\\''");
        return "'" + safePath + "'" + rest;
      }
    } else {
      // 绝对路径或 ./ 开头
      if (fs.existsSync(candidate)) {
        // macOS .app 应用：终端模式使用 open，静默模式执行内部可执行文件
        if (candidate.endsWith('.app')) {
          if (mode === 'terminal') {
            return `open '${candidate.replace(/'/g, "'\\''")}'` + rest;
          } else {
            // 静默模式：尝试执行 .app 内部的可执行文件
            const appName = path.basename(candidate, '.app');
            const execPath = path.join(candidate, 'Contents', 'MacOS', appName);
            if (fs.existsSync(execPath)) {
              return `'${execPath.replace(/'/g, "'\\''")}'` + rest;
            }
            // 如果找不到可执行文件，还是用 open
            return `open '${candidate.replace(/'/g, "'\\''")}'` + rest;
          }
        }
        if (candidate.includes(' ')) {
          const safePath = candidate.replace(/'/g, "'\\''");
          return "'" + safePath + "'" + rest;
        }
        return command;
      }
    }
  }
  return command;
}

// 获取用户的 shell 路径和对应的 RC 文件
function getUserShellInfo() {
  const shell = process.env.SHELL || '/bin/zsh';
  const home = process.env.HOME || '';
  let rcFile = '';
  if (shell.endsWith('/zsh')) rcFile = `${home}/.zshrc`;
  else if (shell.endsWith('/bash')) rcFile = `${home}/.bashrc`;
  else if (shell.endsWith('/fish')) rcFile = `${home}/.config/fish/config.fish`;
  return { shell, rcFile };
}

// 版本号比较：返回 1(a>b), -1(a<b), 0(a==b)
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function registerIpcHandlers(store, autoUpdater, getMainWindow, scheduler) {
  // --- 项目 CRUD ---
  ipcMain.handle('get-projects', () => {
    try {
      return { success: true, data: store.getAllProjects() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('add-project', (_event, project) => {
    try {
      const result = store.addProject(project);
      return { success: true, data: result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('update-project', (_event, { id, updates }) => {
    try {
      const result = store.updateProject(id, updates);
      return { success: true, data: result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('delete-project', (_event, id) => {
    try {
      // 联动清理该项目的所有 schedule 和日志
      if (scheduler) {
        const schedules = store.getAllSchedules().filter(s => s.projectId === id);
        for (const s of schedules) {
          store.clearScheduleLogs(s.id);
        }
        scheduler.removeSchedulesByProject(id);
      }
      const result = store.deleteProject(id);
      return { success: true, data: result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('reorder-projects', (_event, projectIds) => {
    try {
      store.reorderProjects(projectIds);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('toggle-pin', (_event, id) => {
    try {
      const result = store.togglePin(id);
      return { success: true, data: result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('update-command', (_event, { projectId, index, command }) => {
    try {
      const result = store.updateCommandAtIndex(projectId, index, command);
      return { success: true, data: result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // --- 导入/导出 ---
  ipcMain.handle('export-projects', () => {
    try {
      return { success: true, data: store.exportData() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('import-projects', (_event, data) => {
    try {
      const result = store.importData(data);
      return { success: true, data: result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // --- 命令执行（支持终端选择） ---
  ipcMain.handle('execute-command', (_event, { projectPath, command, projectName, commandName }) => {
    return new Promise((resolve) => {
      if (!isRegisteredProject(store, projectPath)) {
        resolve({ success: false, error: 'Unregistered project path' });
        return;
      }
      const workDir = resolveWorkDir(projectPath);

      const startTime = new Date().toISOString();
      const platform = process.platform;
      const terminal = store.getSetting('terminal') || 'default';
      let proc;

      // 智能处理命令中的文件路径：自动补 ./ 和引号（终端模式）
      command = normalizeCommandPath(command, workDir, 'terminal');

      if (platform === 'darwin') {
        const { shell: userShell, rcFile } = getUserShellInfo();
        const sourceCmd = rcFile ? `[ -f \\"${rcFile}\\" ] && source \\"${rcFile}\\" 2>/dev/null; ` : '';
        if (terminal === 'kaku') {
          if (!fs.existsSync('/Applications/Kaku.app')) {
            resolve({ success: false, error: 'Kaku.app not found in /Applications' });
            return;
          }
          const escapedWd = workDir.replace(/'/g, "'\\''");
          const sourcePrefix = rcFile ? `[ -f '${rcFile}' ] && . '${rcFile}' 2>/dev/null; ` : '';
          const kakuCmd = sourcePrefix + "cd '" + escapedWd + "' && " + command + "; exec " + userShell;
          proc = spawn('open', ['-n', '-a', 'Kaku', '--args', 'start', '--always-new-process', '--cwd', workDir, '--', userShell, '-l', '-c', kakuCmd], { detached: true });
          proc.unref();
        } else {
          const safePath = workDir.replace(/'/g, "'\\'");
          const script = `tell application "Terminal"
  activate
  do script "${sourceCmd}cd '${safePath}' && ${command}"
end tell`;
          proc = spawn('osascript', ['-e', script]);
        }
      } else if (platform === 'linux') {
        const { shell: userShell } = getUserShellInfo();
        const shellName = path.basename(userShell);
        const terminals = ['gnome-terminal', 'xterm', 'xfce4-terminal', 'konsole'];
        const termArgs = {
          'gnome-terminal': ['--', shellName, '-c', "cd '" + workDir + "' && " + command + '; exec ' + shellName],
          'xterm': ['-e', shellName + ' -c "cd \'' + workDir + '\' && ' + command + '; exec ' + shellName + '"'],
          'xfce4-terminal': ['-e', shellName + ' -c "cd \'' + workDir + '\' && ' + command + '; exec ' + shellName + '"'],
          'konsole': ['-e', shellName, '-c', "cd '" + workDir + "' && " + command + '; exec ' + shellName],
        };
        let launched = false;
        for (const term of terminals) {
          try {
            proc = spawn(term, termArgs[term], { detached: true });
            launched = true;
            break;
          } catch { /* try next */ }
        }
        if (!launched) {
          resolve({ success: false, error: 'No terminal emulator found' });
          return;
        }
      } else if (platform === 'win32') {
        proc = spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', 'cd /d "' + workDir + '" && ' + command], { shell: true });
      } else {
        resolve({ success: false, error: 'Unsupported platform: ' + platform });
        return;
      }

      proc.on('close', (code) => {
        // 终端执行也记录日志（无 stdout 捕获，仅记录事件）
        store.addScheduleLog({
          scheduleId: null,
          projectName: projectName || '',
          commandName: commandName || '',
          command,
          startTime,
          endTime: new Date().toISOString(),
          durationMs: Date.now() - new Date(startTime).getTime(),
          exitCode: code,
          stdout: '',
          stderr: '',
          status: code === 0 ? 'success' : (code === null ? 'success' : 'failed'),
          trigger: 'manual',
          mode: 'terminal',
        });
        resolve({ success: true, code });
      });
      proc.on('error', (err) => {
        store.addScheduleLog({
          scheduleId: null,
          projectName: projectName || '',
          commandName: commandName || '',
          command,
          startTime,
          endTime: new Date().toISOString(),
          durationMs: Date.now() - new Date(startTime).getTime(),
          exitCode: -1,
          stdout: '',
          stderr: err.message,
          status: 'error',
          trigger: 'manual',
          mode: 'terminal',
        });
        resolve({ success: false, error: err.message });
      });
    });
  });

  // --- 静默执行命令 ---
  ipcMain.handle('execute-command-silent', (_event, { projectPath, command, projectName, commandName }) => {
    return new Promise((resolve) => {
      if (!isRegisteredProject(store, projectPath)) {
        resolve({ success: false, error: 'Unregistered project path' });
        return;
      }
      const workDir = resolveWorkDir(projectPath);

      command = normalizeCommandPath(command, workDir, 'silent');

      const startTime = new Date().toISOString();
      const MAX_OUTPUT = 10 * 1024;
      let stdout = '';
      let stderr = '';

      // 使用用户默认 shell 并加载 RC 文件以获取完整 PATH
      const { shell: userShell, rcFile } = getUserShellInfo();
      const escapedWorkDir = workDir.replace(/'/g, "'\\''");
      const sourceCmd = rcFile ? `[ -f "${rcFile}" ] && . "${rcFile}" 2>/dev/null; ` : '';
      const fullCmd = `${sourceCmd}cd '${escapedWorkDir}' && ${command}`;
      const proc = spawn(userShell, ['-l', '-c', fullCmd], {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      });

      proc.stdout.on('data', (data) => {
        if (stdout.length < MAX_OUTPUT) {
          stdout += data.toString();
          if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(0, MAX_OUTPUT);
        }
      });

      proc.stderr.on('data', (data) => {
        if (stderr.length < MAX_OUTPUT) {
          stderr += data.toString();
          if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(0, MAX_OUTPUT);
        }
      });

      // 默认 60 分钟超时
      const timer = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        }, 5000);
      }, 60 * 60 * 1000);

      proc.on('close', (code, signal) => {
        clearTimeout(timer);
        const endTime = new Date().toISOString();
        const durationMs = Date.now() - new Date(startTime).getTime();
        let status = 'success';
        if (signal === 'SIGTERM' || signal === 'SIGKILL') status = 'timeout';
        else if (code !== 0) status = 'failed';

        store.addScheduleLog({
          scheduleId: null,
          projectName: projectName || '',
          commandName: commandName || '',
          command,
          startTime,
          endTime,
          durationMs,
          exitCode: code,
          stdout,
          stderr,
          status,
          trigger: 'manual',
          mode: 'silent',
        });

        // 通知渲染进程
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('silent-execution-complete', {
            projectName, commandName, command, status, durationMs,
          });
        }

        resolve({ success: status === 'success', code, stdout, stderr, status, durationMs });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        const endTime = new Date().toISOString();
        store.addScheduleLog({
          scheduleId: null,
          projectName: projectName || '',
          commandName: commandName || '',
          command,
          startTime,
          endTime,
          durationMs: Date.now() - new Date(startTime).getTime(),
          exitCode: -1,
          stdout,
          stderr: err.message,
          status: 'error',
          trigger: 'manual',
          mode: 'silent',
        });
        resolve({ success: false, error: err.message, status: 'error' });
      });
    });
  });

  // --- 路径类型检测 ---
  ipcMain.handle('check-path-type', (_event, filePath) => {
    try {
      if (!fs.existsSync(filePath)) return { exists: false };
      const stat = fs.statSync(filePath);
      return { exists: true, isDirectory: stat.isDirectory(), isFile: stat.isFile() };
    } catch (e) {
      return { exists: false, error: e.message };
    }
  });

  // --- 文件夹操作 ---
  ipcMain.handle('open-folder', async (_event, folderPath) => {
    if (!fs.existsSync(folderPath)) {
      return { success: false, error: 'Path does not exist' };
    }
    await shell.openPath(folderPath);
    return { success: true };
  });

  // --- 文件操作（使用默认应用打开文件）---
  ipcMain.handle('open-file-with-default', async (_event, filePath) => {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File does not exist' };
    }
    const result = await shell.openPath(filePath);
    if (result) {
      return { success: false, error: result };
    }
    return { success: true };
  });

  ipcMain.handle('select-file', async (_event, defaultPath) => {
    const win = BrowserWindow.getFocusedWindow();
    const opts = {
      properties: ['openFile'],
      title: 'Select Executable',
    };
    if (defaultPath && fs.existsSync(defaultPath)) opts.defaultPath = defaultPath;
    const result = await dialog.showOpenDialog(win, opts);
    if (result.canceled) return { canceled: true };
    return { canceled: false, path: result.filePaths[0] };
  });

  ipcMain.handle('select-folder', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select Folder',
    });
    if (result.canceled) return { canceled: true };
    return { canceled: false, path: result.filePaths[0] };
  });

  ipcMain.handle('save-file', async (_event, { data, defaultName }) => {
    const win = BrowserWindow.getFocusedWindow();
    const lastPath = store.getSetting('lastExportPath');
    const result = await dialog.showSaveDialog(win, {
      title: 'Export Settings',
      defaultPath: lastPath || defaultName || 'start-everything-settings.json',
      filters: [{ name: 'JSON Files', extensions: ['json'] }],
    });
    if (result.canceled) return { canceled: true };
    fs.writeFileSync(result.filePath, data, 'utf-8');
    store.setSetting('lastExportPath', result.filePath);
    return { canceled: false, path: result.filePath };
  });

  // 快速保存：直接写入上次导出路径，无路径则返回需要弹窗
  ipcMain.handle('quick-save-file', async (_event, data) => {
    const lastPath = store.getSetting('lastExportPath');
    if (!lastPath) return { needsDialog: true };
    try {
      fs.writeFileSync(lastPath, data, 'utf-8');
      return { success: true, path: lastPath };
    } catch (e) {
      return { needsDialog: true, error: e.message };
    }
  });

  // --- 窗口控制 ---
  ipcMain.handle('hide-window', () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) {
      if (process.platform === 'darwin') app.hide();
      else win.hide();
    }
    return { success: true };
  });

  ipcMain.handle('minimize-window', () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) win.minimize();
    return { success: true };
  });

  ipcMain.handle('open-file', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const lastPath = store.getSetting('lastImportPath');
    const path = require('path');

    // 如果有上次的路径，使用其目录作为默认目录
    const defaultPath = lastPath ? path.dirname(lastPath) : undefined;

    const result = await dialog.showOpenDialog(win, {
      title: 'Import Settings',
      defaultPath: defaultPath,
      filters: [{ name: 'JSON Files', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled) return { canceled: true };

    const filePath = result.filePaths[0];
    const content = fs.readFileSync(filePath, 'utf-8');

    // 保存此次导入的路径
    store.setSetting('lastImportPath', filePath);

    return { canceled: false, data: content };
  });

  // --- Open Data Dir ---
  ipcMain.handle('open-data-dir', async () => {
    try {
      await shell.openPath(store.dataDir);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // --- Get Last Import/Export Directory ---
  ipcMain.handle('get-last-import-export-dir', () => {
    const path = require('path');
    const lastImportPath = store.getSetting('lastImportPath');
    const lastExportPath = store.getSetting('lastExportPath');

    // 优先使用最近的导出路径，其次是导入路径，最后回退到数据目录
    const targetPath = lastExportPath || lastImportPath;
    if (targetPath) {
      return { success: true, path: path.dirname(targetPath) };
    }
    return { success: true, path: store.dataDir };
  });

  // --- Reset Data ---
  ipcMain.handle('reset-data', () => {
    try {
      store.resetData();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // --- Search History ---
  ipcMain.handle('get-search-history', () => {
    return store.getSetting('searchHistory') || [];
  });

  ipcMain.handle('save-search-history', (_event, history) => {
    store.setSetting('searchHistory', history);
    return { success: true };
  });

  // --- Open URL ---
  ipcMain.handle('open-url', async (_event, url) => {
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // --- Locale ---
  ipcMain.handle('get-locale', () => {
    return store.getSetting('locale');
  });

  ipcMain.handle('set-locale', (_event, locale) => {
    store.setSetting('locale', locale);
    return { success: true };
  });

  // --- Terminal Setting ---
  ipcMain.handle('get-terminal', () => {
    return store.getSetting('terminal') || 'default';
  });

  ipcMain.handle('set-terminal', (_event, terminal) => {
    store.setSetting('terminal', terminal);
    return { success: true };
  });

  // --- Global Shortcut ---
  ipcMain.handle('get-global-shortcut', () => {
    return store.getSetting('globalShortcut') || '';
  });

  ipcMain.handle('set-global-shortcut', (_event, accelerator) => {
    // Unregister old
    const old = store.getSetting('globalShortcut');
    if (old) {
      try { globalShortcut.unregister(old); } catch { /* ignore */ }
    }

    if (!accelerator) {
      store.setSetting('globalShortcut', '');
      return { success: true };
    }

    // Check conflict
    if (globalShortcut.isRegistered(accelerator)) {
      return { success: false, error: 'conflict' };
    }

    try {
      const ok = globalShortcut.register(accelerator, () => {
        const win = getMainWindow();
        if (!win) return;
        if (process.platform === 'darwin') {
          app.show();
          app.focus({ steal: true });
        }
        if (win.isMinimized()) win.restore();
        if (!win.isVisible()) win.show();
        win.focus();
      });
      if (!ok) {
        return { success: false, error: 'register_failed' };
      }
      store.setSetting('globalShortcut', accelerator);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // --- Settings: Auto Launch (cross-platform) ---
  // Helper: get platform-specific auto-launch file path
  function getAutoLaunchPath() {
    if (process.platform === 'darwin') {
      return path.join(process.env.HOME || '', 'Library', 'LaunchAgents', 'com.nixyme.start-everything.plist');
    } else if (process.platform === 'linux') {
      const configDir = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config');
      return path.join(configDir, 'autostart', 'start-everything.desktop');
    }
    return null; // Windows uses Electron's built-in API
  }

  ipcMain.handle('get-auto-launch', () => {
    const autoFile = getAutoLaunchPath();
    const fileExists = autoFile ? fs.existsSync(autoFile) : false;
    const electronSetting = app.getLoginItemSettings().openAtLogin;
    getLogger().debug({
      event: 'job_started',
      status: 'success',
      action: 'get_auto_launch',
      file_exists: fileExists,
      electron_setting: electronSetting,
      platform: process.platform,
    }, 'Get auto-launch status');
    return fileExists || electronSetting;
  });

  ipcMain.handle('set-auto-launch', (_event, enabled) => {
    const log = getLogger();
    log.info({
      event: 'job_started',
      status: 'running',
      action: 'set_auto_launch',
      enabled,
      platform: process.platform,
      packaged: app.isPackaged,
    }, 'Setting auto-launch');

    if (!app.isPackaged) {
      log.warn({
        event: 'error_occurred',
        status: 'warning',
        decision_reason: 'dev_mode_auto_launch_unreliable',
        action: 'set_auto_launch',
      }, 'Auto-launch may not work in development mode');
    }

    try {
      // 1. Electron 内置方式（Windows 主力，其他平台辅助）
      const loginSettings = { openAtLogin: enabled };
      if (process.platform === 'win32') {
        loginSettings.path = app.getPath('exe');
      }
      app.setLoginItemSettings(loginSettings);

      // 2. macOS: LaunchAgent plist（非签名应用的可靠方案）
      if (process.platform === 'darwin') {
        const launchAgentsDir = path.join(process.env.HOME || '', 'Library', 'LaunchAgents');
        const plistPath = path.join(launchAgentsDir, 'com.nixyme.start-everything.plist');

        if (enabled) {
          if (!fs.existsSync(launchAgentsDir)) {
            fs.mkdirSync(launchAgentsDir, { recursive: true });
          }

          // 获取 .app 路径
          let appPath;
          if (app.isPackaged) {
            appPath = path.resolve(app.getAppPath(), '../../');
          } else {
            appPath = app.getPath('exe');
          }

          const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.nixyme.start-everything</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-a</string>
    <string>${appPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>`;
          fs.writeFileSync(plistPath, plistContent, 'utf-8');
          log.info({
            event: 'job_succeeded',
            status: 'success',
            action: 'create_plist',
            plist_path: plistPath,
          }, 'macOS LaunchAgent plist created');
        } else {
          if (fs.existsSync(plistPath)) {
            fs.unlinkSync(plistPath);
            log.info({
              event: 'job_succeeded',
              status: 'success',
              action: 'remove_plist',
            }, 'macOS LaunchAgent plist removed');
          }
        }
      }

      // 3. Linux: XDG Autostart .desktop 文件
      if (process.platform === 'linux') {
        const configDir = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config');
        const autostartDir = path.join(configDir, 'autostart');
        const desktopPath = path.join(autostartDir, 'start-everything.desktop');

        if (enabled) {
          if (!fs.existsSync(autostartDir)) {
            fs.mkdirSync(autostartDir, { recursive: true });
          }

          const exePath = app.isPackaged ? app.getPath('exe') : process.execPath;
          const desktopContent = `[Desktop Entry]
Type=Application
Name=Start Everything
Exec=${exePath}
X-GNOME-Autostart-enabled=true
Hidden=false
NoDisplay=false
Comment=Manage and launch CLI projects
`;
          fs.writeFileSync(desktopPath, desktopContent, 'utf-8');
          log.info({
            event: 'job_succeeded',
            status: 'success',
            action: 'create_desktop_entry',
            desktop_path: desktopPath,
          }, 'Linux XDG autostart entry created');
        } else {
          if (fs.existsSync(desktopPath)) {
            fs.unlinkSync(desktopPath);
            log.info({
              event: 'job_succeeded',
              status: 'success',
              action: 'remove_desktop_entry',
            }, 'Linux XDG autostart entry removed');
          }
        }
      }

      // 验证：必须同时检查文件和 Electron 登录项
      const autoFile = getAutoLaunchPath();
      const electronOk = app.getLoginItemSettings().openAtLogin === enabled;
      const fileOk = autoFile
        ? (enabled ? fs.existsSync(autoFile) : !fs.existsSync(autoFile))
        : true;

      // macOS/Linux: if file is correct but Electron login item lingers, retry
      if (fileOk && !electronOk) {
        log.warn({
          event: 'retry_scheduled',
          status: 'retrying',
          decision_reason: 'electron_login_item_out_of_sync',
          action: 'set_auto_launch',
          enabled,
        }, 'Electron login item out of sync, retrying');
        app.setLoginItemSettings({ openAtLogin: enabled });
      }

      const finalElectronOk = app.getLoginItemSettings().openAtLogin === enabled;
      const verified = fileOk && finalElectronOk;
      log.info({
        event: 'job_succeeded',
        status: verified ? 'success' : 'failed',
        action: 'set_auto_launch',
        file_ok: fileOk,
        electron_ok: finalElectronOk,
        verified,
        ...((!verified) && { decision_reason: 'auto_launch_verification_failed' }),
      }, `Auto-launch set ${verified ? 'verified' : 'unverified'}`);

      return { success: verified, value: enabled };
    } catch (e) {
      log.error({
        event: 'job_failed',
        status: 'error',
        decision_reason: 'auto_launch_set_exception',
        action: 'set_auto_launch',
        error: e.message,
      }, 'Auto-launch set failed');
      return { success: false, error: e.message };
    }
  });

  // --- App Info ---
  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });

  // --- Auto Update (GitHub API) ---
  ipcMain.handle('check-for-update', async () => {
    const https = require('https');
    const currentVersion = app.getVersion();
    return new Promise((resolve) => {
      const opts = {
        hostname: 'api.github.com',
        path: '/repos/nixyme/start-everything/releases/latest',
        headers: { 'User-Agent': 'START-EVERYTHING/' + currentVersion },
      };
      https.get(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              resolve({ success: false, error: `GitHub API: ${res.statusCode}` });
              return;
            }
            const release = JSON.parse(data);
            const latestVersion = (release.tag_name || '').replace(/^v/, '');
            if (!latestVersion) {
              resolve({ success: false, error: 'No version found' });
              return;
            }
            // 找到 DMG 下载链接
            const dmgAsset = (release.assets || []).find(a => a.name.endsWith('.dmg'));
            const isNewer = compareVersions(latestVersion, currentVersion) > 0;
            resolve({
              success: true,
              data: {
                currentVersion,
                latestVersion,
                isNewer,
                releaseNotes: release.body || '',
                downloadUrl: dmgAsset ? dmgAsset.browser_download_url : release.html_url,
                releaseUrl: release.html_url,
              },
            });
          } catch (e) {
            resolve({ success: false, error: e.message });
          }
        });
      }).on('error', (e) => {
        resolve({ success: false, error: e.message });
      });
    });
  });

  // 直接下载 DMG 到临时目录，通过事件报告进度
  ipcMain.handle('download-update', async (_event, url) => {
    const https = require('https');
    const http = require('http');
    const os = require('os');
    const tmpDir = path.join(os.tmpdir(), 'start-everything-update');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const fileName = url.split('/').pop() || 'Start-Everything-update.dmg';
    const filePath = path.join(tmpDir, fileName);
    const win = getMainWindow();

    return new Promise((resolve) => {
      const doDownload = (downloadUrl, redirectCount) => {
        if (redirectCount > 5) {
          resolve({ success: false, error: 'Too many redirects' });
          return;
        }
        const mod = downloadUrl.startsWith('https') ? https : http;
        mod.get(downloadUrl, { headers: { 'User-Agent': 'Start-Everything/' + app.getVersion() } }, (res) => {
          // 跟随重定向
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            doDownload(res.headers.location, redirectCount + 1);
            return;
          }
          if (res.statusCode !== 200) {
            resolve({ success: false, error: `HTTP ${res.statusCode}` });
            return;
          }
          const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
          let downloaded = 0;
          const file = fs.createWriteStream(filePath);
          let lastPercent = 0;
          res.on('data', (chunk) => {
            downloaded += chunk.length;
            file.write(chunk);
            if (win && !win.isDestroyed() && totalBytes > 0) {
              const percent = Math.round((downloaded / totalBytes) * 100);
              // 节流：每变化 1% 才发送，避免过于频繁
              if (percent > lastPercent) {
                lastPercent = percent;
                win.webContents.send('update-download-progress', { percent, downloaded, total: totalBytes });
              }
            }
          });
          res.on('end', () => {
            file.end(() => {
              // 确保发送 100%
              if (win && !win.isDestroyed()) {
                win.webContents.send('update-download-progress', { percent: 100, downloaded: totalBytes || downloaded, total: totalBytes || downloaded });
              }
              resolve({ success: true, filePath });
            });
          });
          res.on('error', (e) => {
            file.end();
            resolve({ success: false, error: e.message });
          });
        }).on('error', (e) => {
          resolve({ success: false, error: e.message });
        });
      };
      doDownload(url, 0);
    });
  });

  // 自动安装：挂载 DMG → 复制 .app 到 /Applications → 卸载 → 重启
  ipcMain.handle('install-update', async (_event, filePath) => {
    const { execSync } = require('child_process');
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return { success: false, error: 'DMG file not found' };
      }

      // 1. 挂载 DMG，解析挂载点
      const mountOutput = execSync(`hdiutil attach "${filePath}" -nobrowse -noverify -noautoopen 2>&1`, { encoding: 'utf-8' });
      const mountMatch = mountOutput.match(/\/Volumes\/.+/);
      if (!mountMatch) {
        return { success: false, error: 'Failed to mount DMG: ' + mountOutput };
      }
      const mountPoint = mountMatch[0].trim();

      // 2. 找到 .app
      const items = fs.readdirSync(mountPoint);
      const appName = items.find(f => f.endsWith('.app'));
      if (!appName) {
        execSync(`hdiutil detach "${mountPoint}" -force 2>/dev/null`);
        return { success: false, error: 'No .app found in DMG' };
      }

      const srcApp = path.join(mountPoint, appName);
      const destApp = path.join('/Applications', appName);

      // 3. 删除旧版本，复制新版本
      if (fs.existsSync(destApp)) {
        execSync(`rm -rf "${destApp}"`);
      }
      execSync(`cp -R "${srcApp}" "/Applications/"`);

      // 4. 移除 quarantine 属性
      execSync(`xattr -cr "${destApp}" 2>/dev/null || true`);

      // 5. 卸载 DMG
      execSync(`hdiutil detach "${mountPoint}" -force 2>/dev/null || true`);

      // 6. 清理下载文件
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }

      // 7. 重启应用：先退出旧进程，延迟后再启动新版本，避免双图标
      spawn('/bin/sh', ['-c', `sleep 1 && open "${destApp}"`], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      app.quit();

      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // --- Schedule CRUD ---
  ipcMain.handle('get-schedules', () => {
    try {
      return { success: true, data: store.getAllSchedules() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('get-schedule-for-command', (_event, { projectId, commandIndex }) => {
    try {
      const schedule = store.getScheduleForCommand(projectId, commandIndex);
      return { success: true, data: schedule };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('add-schedule', (_event, data) => {
    try {
      if (!scheduler) return { success: false, error: 'Scheduler not available' };
      const result = scheduler.addSchedule(data);
      return { success: true, data: result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('update-schedule', (_event, { id, updates }) => {
    try {
      if (!scheduler) return { success: false, error: 'Scheduler not available' };
      const result = scheduler.updateSchedule(id, updates);
      return { success: true, data: result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('delete-schedule', (_event, id) => {
    try {
      if (!scheduler) return { success: false, error: 'Scheduler not available' };
      const result = scheduler.removeSchedule(id);
      return { success: true, data: result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('toggle-schedule', (_event, { id, enabled }) => {
    try {
      if (!scheduler) return { success: false, error: 'Scheduler not available' };
      const result = scheduler.toggleSchedule(id, enabled);
      return { success: true, data: result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // --- Schedule Logs ---
  ipcMain.handle('get-schedule-logs', (_event, opts) => {
    try {
      return { success: true, data: store.getScheduleLogs(opts || {}) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('clear-schedule-logs', (_event, scheduleId) => {
    try {
      if (scheduleId) store.clearScheduleLogs(scheduleId);
      else store.clearAllScheduleLogs();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // --- Cron Validation ---
  ipcMain.handle('validate-cron', (_event, expression) => {
    const cron = require('node-cron');
    return { valid: cron.validate(expression) };
  });
}

module.exports = { registerIpcHandlers };