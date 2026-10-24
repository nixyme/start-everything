(function () {
  'use strict';

  const methods = {
    getProjects: ['get-projects'], addProject: ['add-project', 'project'],
    updateProject: ['update-project', 'id', 'updates'], deleteProject: ['delete-project', 'id'],
    reorderProjects: ['reorder-projects', 'ids'], togglePin: ['toggle-pin', 'id'],
    updateCommand: ['update-command', 'projectId', 'index', 'command'],
    exportProjects: ['export-projects'], importProjects: ['import-projects', 'data'],
    executeCommand: ['execute-command', 'projectPath', 'command', 'projectName?', 'commandName?'],
    executeCommandSilent: ['execute-command-silent', 'projectPath', 'command', 'projectName?', 'commandName?'],
    openDataDir: ['open-data-dir'], getLastImportExportDir: ['get-last-import-export-dir'], resetData: ['reset-data'],
    getDataDirInfo: ['get-data-dir-info'], setDataDir: ['set-data-dir', 'path'],
    resetDataDir: ['reset-data-dir'], relaunchApp: ['relaunch-app'],
    getSearchHistory: ['get-search-history'], saveSearchHistory: ['save-search-history', 'history'],
    openUrl: ['open-url', 'url'], openFolder: ['open-folder', 'folderPath'], selectFolder: ['select-folder'],
    selectFile: ['select-file', 'defaultPath?'], checkPathType: ['check-path-type', 'filePath'],
    openFileWithDefault: ['open-file-with-default', 'filePath'],
    saveFile: ['save-file', 'data', 'defaultName'], quickSaveFile: ['quick-save-file', 'data'], openFile: ['open-file'],
    hideWindow: ['hide-window'], minimizeWindow: ['minimize-window'],
    getLocale: ['get-locale'], setLocale: ['set-locale', 'locale'],
    getTerminal: ['get-terminal'], setTerminal: ['set-terminal', 'terminal'],
    getGlobalShortcut: ['get-global-shortcut'], setGlobalShortcut: ['set-global-shortcut', 'accelerator'],
    getAutoLaunch: ['get-auto-launch'], setAutoLaunch: ['set-auto-launch', 'enabled'],
    getAppVersion: ['get-app-version'], checkForUpdate: ['check-for-update'],
    downloadUpdate: ['download-update', 'url'], installUpdate: ['install-update', 'filePath'],
    getSchedules: ['get-schedules'], getScheduleForCommand: ['get-schedule-for-command', 'projectId', 'index'],
    addSchedule: ['add-schedule', 'schedule'], updateSchedule: ['update-schedule', 'id', 'updates'],
    deleteSchedule: ['delete-schedule', 'id'], toggleSchedule: ['toggle-schedule', 'id', 'enabled'],
    getScheduleLogs: ['get-schedule-logs', 'options?'], clearScheduleLogs: ['clear-schedule-logs', 'scheduleId?'],
    validateCron: ['validate-cron', 'cronExpression'],
  };

  function buildRequest(method, values) {
    const contract = methods[method];
    if (!contract) throw new Error(`Unknown desktop method: ${method}`);
    const [action, ...keys] = contract;
    const required = keys.filter(key => !key.endsWith('?')).length;
    if (values.length < required || values.length > keys.length) {
      throw new Error(`${method} requires ${required}–${keys.length} arguments`);
    }
    const args = {};
    keys.forEach((key, index) => {
      if (values[index] !== undefined) args[key.replace(/\?$/, '')] = values[index];
    });
    return { action, args };
  }

  function normalizeError(error) {
    const message = typeof error === 'string' ? error : error?.message || JSON.stringify(error);
    const details = error?.details;
    return { success: false, error: details ? `${message}\n${details}` : message || 'Unknown desktop error' };
  }

  function getDroppedPaths(event) {
    if (Array.isArray(event.detail?.nativePaths)) return event.detail.nativePaths;
    return Array.from(event.dataTransfer?.files || []).map(file => file.path).filter(Boolean);
  }

  // wry 的 Windows 后端上报物理像素坐标，macOS 与 Linux 后端上报逻辑坐标。
  function dropPositionUsesLogicalUnits(userAgent = globalThis.navigator?.userAgent ?? '') {
    return !/Windows/i.test(userAgent);
  }

  function logicalDropPosition(position, scaleFactor, userAgent) {
    if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) throw new Error('Invalid display scale factor');
    if (dropPositionUsesLogicalUnits(userAgent)) return { x: position.x, y: position.y };
    return { x: position.x / scaleFactor, y: position.y / scaleFactor };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildRequest, normalizeError, getDroppedPaths, logicalDropPosition, dropPositionUsesLogicalUnits };
    return;
  }

  let fatalDialog = null;
  function showFatalError(error, context) {
    const failure = normalizeError(error);
    const details = `${context}\n${failure.error}${error?.stack ? `\n\n${error.stack}` : ''}`;
    if (!document.body) {
      window.alert(details);
      return;
    }
    if (!fatalDialog) {
      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';
      overlay.style.zIndex = '10000';
      overlay.setAttribute('role', 'alertdialog');
      overlay.setAttribute('aria-modal', 'true');
      const panel = document.createElement('div');
      panel.className = 'confirm-dialog';
      panel.style.maxWidth = 'min(720px, 90vw)';
      const title = document.createElement('h3');
      title.textContent = 'Start Everything';
      const text = document.createElement('pre');
      text.style.cssText = 'white-space:pre-wrap;overflow:auto;max-height:60vh;user-select:text;font-size:12px';
      const close = document.createElement('button');
      close.className = 'btn-primary';
      close.textContent = 'OK';
      close.addEventListener('click', () => { overlay.remove(); fatalDialog = null; });
      panel.append(title, text, close);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      fatalDialog = { text, close };
    }
    fatalDialog.text.textContent = details;
    fatalDialog.close.focus();
  }

  function log(level, event, details = {}) {
    const record = { timestamp: new Date().toISOString(), level, event, details };
    console[level === 'error' ? 'error' : 'info'](JSON.stringify(record));
    if (!window.__TAURI__?.core?.invoke) return;
    return window.__TAURI__.core.invoke('api', { action: 'frontend-log', args: record }).catch(error => {
      console.error(JSON.stringify({ level: 'error', event: 'frontend-log-failed', error: normalizeError(error).error }));
    });
  }

  async function invoke(action, args = {}) {
    try {
      return await window.__TAURI__.core.invoke('api', { action, args });
    } catch (error) {
      showFatalError(error, action);
      log('error', 'desktop-request-failed', { action, error: normalizeError(error).error });
      return normalizeError(error);
    }
  }

  const disposers = new Set();
  function subscribe(eventName, callback) {
    let disposed = false;
    let unlisten = null;
    const dispose = () => {
      disposed = true;
      if (unlisten) unlisten();
      disposers.delete(dispose);
    };
    disposers.add(dispose);
    const ready = window.__TAURI__.event.listen(eventName, event => {
      if (!disposed) callback(event.payload);
    }).then(stop => { unlisten = stop; if (disposed) stop(); });
    ready.catch(error => {
      dispose();
      showFatalError(error, `listen: ${eventName}`);
      log('error', 'desktop-listener-failed', { eventName, error: normalizeError(error).error });
    });
    dispose.ready = ready;
    return dispose;
  }

  const api = { invoke, log, showFatalError, getDroppedPaths };
  Object.keys(methods).forEach(method => {
    api[method] = (...values) => {
      const request = buildRequest(method, values);
      return invoke(request.action, request.args);
    };
  });
  api.onUpdateDownloadProgress = callback => subscribe('update-download-progress', callback);
  api.onScheduleExecuted = callback => subscribe('schedule-executed', callback);
  api.onSilentExecutionComplete = callback => subscribe('silent-execution-complete', callback);
  window.electronAPI = api;

  window.addEventListener('error', event => {
    showFatalError(event.error || event.message, 'frontend-error');
    log('error', 'frontend-error', { message: event.message, file: event.filename, line: event.lineno, stack: event.error?.stack });
  });
  window.addEventListener('unhandledrejection', event => {
    event.preventDefault();
    showFatalError(event.reason, 'frontend-unhandled-rejection');
    log('error', 'frontend-unhandled-rejection', { error: normalizeError(event.reason).error, stack: event.reason?.stack });
  });
  window.addEventListener('pagehide', () => { for (const dispose of [...disposers]) dispose(); }, { once: true });

  api.setupNativeDragDrop = async () => {
    let highlighted = null;
    const clearHighlight = () => {
      highlighted?.classList.remove('native-drag-over');
      highlighted = null;
    };
    const stop = await window.__TAURI__.webview.getCurrentWebview().onDragDropEvent(event => {
      const payload = event.payload;
      clearHighlight();
      if (payload.type === 'leave') return;
      const position = logicalDropPosition(payload.position, window.devicePixelRatio);
      const target = document.elementFromPoint(position.x, position.y);
      if (!target) return;
      if (payload.type === 'over' || payload.type === 'enter') {
        highlighted = target.closest('button, input, .subproject-section, .subproject-drop-zone') || target;
        highlighted.classList.add('native-drag-over');
        return;
      }
      if (payload.type === 'drop') {
        const destination = target.closest('button, input, .subproject-section, .subproject-drop-zone') || target;
        const drop = new CustomEvent('drop', { bubbles: true, cancelable: true, detail: { nativePaths: payload.paths } });
        Object.defineProperty(drop, 'dataTransfer', { value: new DataTransfer() });
        destination.dispatchEvent(drop);
        log('info', 'native-files-dropped', { count: payload.paths.length });
      }
    });
    disposers.add(stop);
  };
  Object.freeze(api);
})();
