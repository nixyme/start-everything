(async function () {
  'use strict';

  const api = window.electronAPI;
  const startedAt = performance.now();
  const report = { passed: 0, failed: 0, checks: [], errors: [], performance: { frontendReadyMs: startedAt } };
  const executionEvents = [];
  const cleanup = { projectId: null, scheduleId: null, originalIds: null, locale: null, shortcut: null };
  const projectPath = '/Users/nixy/.tools/start-everything-new-20261019/.work';
  const projectName = `Desktop regression ${Date.now()}`;
  const command = "printf 'desktop-smoke-output\\n'";
  let testProject = null;
  let eventDisposer = null;

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function successful(result, action) {
    assert(result?.success === true, `${action}: ${JSON.stringify(result)}`);
    return result.data;
  }

  async function waitFor(predicate, message, timeoutMs = 6000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`等待超时：${message}`);
  }

  function element(selector) {
    const found = document.querySelector(selector);
    assert(found, `缺少 DOM 元素：${selector}`);
    return found;
  }

  function projectElement(id) {
    return Array.from(document.querySelectorAll('#projectList [data-project-id]')).find(item => item.dataset.projectId === id);
  }

  function fill(selector, value) {
    const input = element(selector);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input;
  }

  async function check(name, action) {
    const begin = performance.now();
    try {
      const details = await action();
      report.checks.push({ name, passed: true, durationMs: performance.now() - begin, details: details ?? null });
      report.passed += 1;
    } catch (error) {
      report.checks.push({ name, passed: false, durationMs: performance.now() - begin, error: error.message, stack: error.stack });
      report.failed += 1;
      throw error;
    }
  }

  const recordError = event => report.errors.push({ type: event.type, message: event.message || String(event.reason), stack: event.error?.stack || event.reason?.stack });
  window.addEventListener('error', recordError);
  window.addEventListener('unhandledrejection', recordError);

  try {
    await check('真实 Tauri 与原生前端初始化', async () => {
      assert(window.__TAURI__?.core?.invoke, 'Tauri core 尚未加载');
      assert(api && Object.isFrozen(api), '桌面桥接尚未初始化');
      assert(!document.querySelector('[role="alertdialog"]'), '应用初始化显示错误弹窗');
      const result = await api.getProjects();
      const initial = successful(result, 'get-projects');
      assert(initial.length === 35, `隔离数据应包含 35 个项目，实际为 ${initial.length}`);
      assert(document.querySelectorAll('#projectList [data-project-id]').length === 35, '项目列表没有完整渲染');
      assert(initial.every(project => project.commands.some(value => value.trim().split(/\s+/)[0] === 'codex')), '启动迁移没有为全部原有项目补齐 Codex 命令');
      cleanup.originalIds = initial.map(project => project.id);
      cleanup.locale = await api.getLocale();
      cleanup.shortcut = await api.getGlobalShortcut();
      assert(typeof cleanup.shortcut === 'string', '全局快捷键应返回字符串');
      assert(typeof await api.getTerminal() === 'string', '终端设置应返回字符串');
      assert(typeof await api.getAppVersion() === 'string', '应用版本应返回字符串');
      const versionBadge = document.getElementById('appVersionBadge');
      assert(versionBadge && versionBadge.style.display !== 'none' && versionBadge.textContent === `v${await api.getAppVersion()}`, `欢迎区版本徽章缺失或不匹配：${versionBadge?.textContent}`);
      const pathInfo = await api.checkPathType(projectPath);
      assert(pathInfo.exists && pathInfo.isDirectory, '隔离工作目录不存在');
      report.performance.initialProjectsRequestMs = performance.now() - startedAt;
      return { projects: initial.length, version: await api.getAppVersion(), pathInfo };
    });

    await check('选择原有项目并显示真实命令', async () => {
      const all = successful(await api.getProjects(), 'get-projects');
      const chosen = all.find(project => project.commands.some(value => value.trim()));
      assert(chosen, '原有项目没有可显示的命令');
      const begin = performance.now();
      projectElement(chosen.id).click();
      await waitFor(() => document.querySelector('#commandsDisplay .command-input-editable'), '原有项目命令');
      assert(element('#projectName').textContent === chosen.name, '项目标题不匹配');
      assert(element('#commandsDisplay .command-input-editable').value === chosen.commands.find(value => value.trim()), '命令文本不匹配');
      report.performance.selectionMs = performance.now() - begin;
      return { id: chosen.id, commands: chosen.commands.length };
    });

    await check('原生拖放坐标映射到加号按钮并带入目录', async () => {
      const btn = element('#addProjectBtn');
      const rect = btn.getBoundingClientRect();
      const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      assert(target && (target === btn || btn.contains(target)), `加号按钮中心没有命中按钮：${target?.outerHTML?.slice(0, 80)}`);
      const drop = new CustomEvent('drop', { bubbles: true, cancelable: true, detail: { nativePaths: [projectPath] } });
      Object.defineProperty(drop, 'dataTransfer', { value: new DataTransfer() });
      target.dispatchEvent(drop);
      await waitFor(() => element('#projectModal').classList.contains('show'), '拖放后新增界面没有打开');
      await waitFor(() => document.getElementById('modalProjectPath').value === projectPath, '拖放后项目路径没有填入');
      assert(document.getElementById('modalProjectName').value === projectPath.split('/').pop(), '拖放后项目名称没有按目录名填入');
      element('#cancelModalBtn').click();
      await waitFor(() => !element('#projectModal').classList.contains('show'), '取消后新增界面没有关闭');
      return { path: projectPath };
    });

    await check('通过真实新增界面创建项目', async () => {
      element('#addProjectBtn').click();
      assert(element('#projectModal').classList.contains('show'), '新增项目界面没有显示');
      const defaultCommands = [...document.querySelectorAll('#commandsList .command-item')].map(row => row.querySelector('input').value);
      assert(defaultCommands[0] === 'claude --dangerously-skip-permissions ' && defaultCommands[1] === 'codex --dangerously-bypass-approvals-and-sandbox ', `新增项目默认命令不匹配：${JSON.stringify(defaultCommands)}`);
      fill('#modalProjectName', projectName);
      fill('#modalProjectPath', projectPath);
      fill('#commandsList .command-item > input', command);
      fill('#commandsList .command-name-field', '真实输出');
      element('#commandsList .btn-mode-toggle-modal').click();
      element('#saveProjectBtn').click();
      testProject = await waitFor(async () => {
        const all = successful(await api.getProjects(), 'get-projects');
        return all.find(project => project.name === projectName);
      }, '新增项目持久化');
      cleanup.projectId = testProject.id;
      await waitFor(() => projectElement(testProject.id) && document.querySelector('#projectName')?.textContent === projectName, '新增项目显示');
      assert(testProject.commands[0] === command && testProject.command_modes[0] === 'silent', '新增项目命令或执行模式丢失');
      assert(testProject.commands[1] === 'codex --dangerously-bypass-approvals-and-sandbox', '新增项目缺少默认 Codex 命令');
      assert(!element('#projectModal').classList.contains('show'), '保存后新增界面没有关闭');
      return { id: testProject.id };
    });

    await check('搜索项目并恢复完整列表', async () => {
      fill('#searchInput', projectName);
      await waitFor(() => document.querySelectorAll('#projectList [data-project-id]').length === 1, '项目搜索');
      assert(projectElement(testProject.id), '搜索结果没有测试项目');
      fill('#searchInput', '不存在的桌面回归搜索项');
      await waitFor(() => document.querySelectorAll('#projectList [data-project-id]').length === 0, '空搜索结果');
      fill('#searchInput', '');
      await waitFor(() => document.querySelectorAll('#projectList [data-project-id]').length === 36, '完整项目列表');
    });

    await check('未知项目字段在更新和界面编辑后保持完整', async () => {
      successful(await api.updateProject(testProject.id, { futureField: { version: 42, labels: ['中文', 'preserved'] } }), 'update-project');
      projectElement(testProject.id).click();
      element('#editProjectBtn').click();
      fill('#modalProjectName', `${projectName} edited`);
      element('#saveProjectBtn').click();
      testProject = await waitFor(async () => {
        const item = successful(await api.getProjects(), 'get-projects').find(project => project.id === cleanup.projectId);
        return item?.name.endsWith(' edited') ? item : null;
      }, '项目编辑');
      assert(testProject.futureField?.version === 42, '未知字段 version 在界面编辑后丢失');
      assert(Array.isArray(testProject.futureField.labels) && testProject.futureField.labels.length === 2 && testProject.futureField.labels[0] === '中文' && testProject.futureField.labels[1] === 'preserved', '未知字段 labels 在界面编辑后丢失');
    });

    await check('界面置顶及取消置顶', async () => {
      await waitFor(() => element('#projectName').textContent === testProject.name, '编辑后的项目标题');
      element('#pinProjectBtn').click();
      await waitFor(async () => successful(await api.getProjects(), 'get-projects').find(project => project.id === testProject.id)?.pinned === true, '置顶持久化');
      await waitFor(() => projectElement(testProject.id)?.classList.contains('pinned-item'), '置顶界面');
      element('#pinProjectBtn').click();
      await waitFor(async () => successful(await api.getProjects(), 'get-projects').find(project => project.id === testProject.id)?.pinned === false, '取消置顶');
    });

    await check('项目排序持久化', async () => {
      const all = successful(await api.getProjects(), 'get-projects');
      const ids = all.map(project => project.id).reverse();
      successful(await api.reorderProjects(ids), 'reorder-projects');
      const reordered = successful(await api.getProjects(), 'get-projects');
      for (let index = 0; index < ids.length; index += 1) {
        assert(reordered.find(project => project.id === ids[index]).order === index, `项目顺序没有保存：${index}`);
      }
      successful(await api.reorderProjects([testProject.id, ...cleanup.originalIds]), 'restore-order');
      return { projects: ids.length };
    });

    await check('Cron 校验与计划界面创建', async () => {
      assert((await api.validateCron('0 0 1 1 *')).valid === true, '有效 Cron 校验失败');
      assert((await api.validateCron('invalid cron')).valid === false, '无效 Cron 被接受');
      projectElement(testProject.id).click();
      await waitFor(() => document.querySelector('#commandsDisplay .btn-schedule-command'), '计划按钮');
      element('#commandsDisplay .btn-schedule-command').click();
      await waitFor(() => document.querySelector('.schedule-save-btn'), '计划界面');
      element('.schedule-mode-btn[data-mode="advanced"]').click();
      fill('#scheduleCronInput', '0 0 1 1 *');
      element('#scheduleNotify').checked = false;
      element('.schedule-save-btn').click();
      const schedule = await waitFor(async () => successful(await api.getScheduleForCommand(testProject.id, 0), 'get-schedule-for-command'), '计划保存');
      cleanup.scheduleId = schedule.id;
      assert(schedule.enabled === true && schedule.cronExpression === '0 0 1 1 *', '计划内容不匹配');
      await waitFor(() => !document.querySelector('.schedule-save-btn'), '计划保存后关闭界面');
      successful(await api.toggleSchedule(schedule.id, false), 'toggle-schedule');
      const disabled = successful(await api.getScheduleForCommand(testProject.id, 0), 'get-schedule-for-command');
      assert(disabled.enabled === false, '计划没有禁用');
      successful(await api.updateSchedule(schedule.id, { cronExpression: '15 4 2 1 *' }), 'update-schedule');
      assert(successful(await api.getScheduleForCommand(testProject.id, 0), 'get-schedule-for-command').cronExpression === '15 4 2 1 *', '计划更新没有保存');
      successful(await api.deleteSchedule(schedule.id), 'delete-schedule');
      cleanup.scheduleId = null;
      assert(successful(await api.getScheduleForCommand(testProject.id, 0), 'get-schedule-for-command') === null, '计划删除后仍然存在');
      return { id: schedule.id };
    });

    eventDisposer = api.onSilentExecutionComplete(event => executionEvents.push(event));
    await eventDisposer.ready;

    await check('真实静默命令输出与完成事件', async () => {
      const output = await api.executeCommandSilent(projectPath, command, testProject.name, 'desktop-smoke-success');
      assert(output.success === true && output.code === 0 && output.exitCode === 0, `命令执行失败：${JSON.stringify(output)}`);
      assert(output.stdout === 'desktop-smoke-output\n' && output.stderr === '', '真实 printf 输出不匹配');
      await waitFor(() => executionEvents.find(event => event.commandName === 'desktop-smoke-success' && event.status === 'success'), '真实静默完成事件');
      report.performance.commandMs = output.durationMs;
      return { code: output.code, stdout: output.stdout, durationMs: output.durationMs };
    });

    await check('真实命令失败退出码与错误输出', async () => {
      const output = await api.executeCommandSilent(projectPath, "printf 'desktop-smoke-error\\n' >&2; exit 23", testProject.name, 'desktop-smoke-failure');
      assert(output.success === false && output.code === 23 && output.exitCode === 23 && output.status === 'failed', `失败命令退出码不匹配：${JSON.stringify(output)}`);
      assert(output.stderr === 'desktop-smoke-error\n', '失败命令错误输出不匹配');
      return { code: output.code, stderr: output.stderr };
    });

    await check('执行日志保存与真实日志界面', async () => {
      const result = successful(await api.getScheduleLogs({ limit: 100 }), 'get-schedule-logs');
      const success = result.logs.find(log => log.commandName === 'desktop-smoke-success');
      const failure = result.logs.find(log => log.commandName === 'desktop-smoke-failure');
      assert(success?.stdout === 'desktop-smoke-output\n' && success.code === 0 && success.trigger === 'manual', '成功执行日志不完整');
      assert(failure?.stderr === 'desktop-smoke-error\n' && failure.code === 23 && failure.mode === 'silent', '失败执行日志不完整');
      element('#scheduleLogsBtn').click();
      await waitFor(() => document.querySelectorAll('.log-entry').length >= 2, '日志界面');
      assert(document.querySelectorAll('.log-entry').length === result.logs.length, '日志界面数量不匹配');
      element('.log-close-btn').click();
      return { total: result.total, entries: result.logs.length };
    });

    await check('旧版数据格式导出与再导入', async () => {
      const exported = successful(await api.exportProjects(), 'export-projects');
      assert(exported.version === '1.1' && exported.projects.length === 36 && Array.isArray(exported.schedules), '导出格式不匹配');
      const serialized = JSON.stringify(exported);
      const imported = successful(await api.importProjects(JSON.parse(serialized)), 'import-projects');
      assert(imported.added === 0 && imported.updated === 36 && imported.deleted === 0, `导入统计不匹配：${JSON.stringify(imported)}`);
      const found = successful(await api.getProjects(), 'get-projects').find(project => project.id === testProject.id);
      assert(found.futureField.version === 42 && found.commands[0] === command, '导入后项目字段丢失');
      return { version: exported.version, bytes: new TextEncoder().encode(serialized).length, imported };
    });

    await check('四种语言真实界面与持久化', async () => {
      element('#settingsBtn').click();
      await waitFor(() => element('#settingsModal').classList.contains('show'), '设置界面');
      const labels = { en: 'Projects', zh: '项目', ja: 'プロジェクト', fr: 'Projets' };
      for (const locale of ['en', 'zh', 'ja', 'fr']) {
        const select = element('#langSelect');
        select.value = locale;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(async () => await api.getLocale() === locale && document.documentElement.lang === (locale === 'zh' ? 'zh-CN' : locale) && element('[data-i18n="sidebar.title"]').textContent === labels[locale], `语言持久化与界面更新 ${locale}`);
        assert(document.documentElement.lang === (locale === 'zh' ? 'zh-CN' : locale), `HTML 语言标记错误：${locale}`);
        assert(element('[data-i18n="sidebar.title"]').textContent === labels[locale], `语言文本错误：${locale}`);
      }
      element('#closeSettingsBtn').click();
      return { locales: Object.keys(labels) };
    });

    await check('独立全局快捷键注册与注销', async () => {
      const shortcut = 'CommandOrControl+Alt+Shift+F19';
      successful(await api.setGlobalShortcut(shortcut), 'set-global-shortcut');
      assert(await api.getGlobalShortcut() === shortcut, '快捷键注册后读取不匹配');
      successful(await api.setGlobalShortcut(''), 'clear-global-shortcut');
      assert(await api.getGlobalShortcut() === '', '快捷键没有注销');
      return { shortcut };
    });

    await check('ESC 关闭最上层弹窗并消费按键', async () => {
      element('#addProjectBtn').click();
      await waitFor(() => element('#projectModal').classList.contains('show'), '项目弹窗打开');
      const firstEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      assert(document.dispatchEvent(firstEscape) === false, 'ESC 没有被弹窗消费（会传导给系统，例如退出全屏）');
      await waitFor(() => !element('#projectModal').classList.contains('show'), 'ESC 没有关闭项目弹窗');

      // 叠加两层弹窗：ESC 从最上层开始关，下层保持
      element('#settingsBtn').click();
      await waitFor(() => element('#settingsModal').classList.contains('show'), '设置弹窗打开');
      element('#addProjectBtn').click();
      await waitFor(() => element('#projectModal').classList.contains('show'), '项目弹窗叠加打开');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await waitFor(() => !element('#projectModal').classList.contains('show'), 'ESC 没有关闭最上层的项目弹窗');
      assert(element('#settingsModal').classList.contains('show'), '下层的设置弹窗不应被一起关闭');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await waitFor(() => !element('#settingsModal').classList.contains('show'), 'ESC 没有关闭设置弹窗');
      const lastEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      assert(document.dispatchEvent(lastEscape) === true, '没有弹窗时 ESC 不应被消费');
    });

    await check('编辑窗口内拖动命令排序并保存', async () => {
      projectElement(testProject.id).click();
      element('#editProjectBtn').click();
      await waitFor(() => element('#projectModal').classList.contains('show'), '编辑界面');
      const list = element('#commandsList');
      const rows = [...list.querySelectorAll('.command-item')];
      assert(rows.length >= 2, '测试项目至少需要两条命令');
      const [first, second] = rows;
      const handle = first.querySelector('.drag-handle');
      assert(handle, '命令行缺少拖动把手');
      // 纯指针实现：按住把手移动到第二行中点，松手完成排序
      const handleRect = handle.getBoundingClientRect();
      const secondRect = second.getBoundingClientRect();
      const pointer = (type, target, clientY) => target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 7, clientY,
      }));
      pointer('pointerdown', handle, handleRect.top + handleRect.height / 2);
      assert(first.classList.contains('modal-row-dragging'), '按住把手后行没有进入拖动状态');
      pointer('pointermove', handle, secondRect.top + secondRect.height / 2);
      pointer('pointerup', handle, secondRect.top + secondRect.height / 2);
      const reordered = [...list.querySelectorAll('.command-item')].map(row => row.querySelector('input').value);
      assert(reordered[1] === command && reordered[0].startsWith('codex'), `排序后命令顺序不符合预期：${JSON.stringify(reordered)}`);
      assert(!first.classList.contains('modal-row-dragging'), '松手后拖动状态没有清理');
      element('#saveProjectBtn').click();
      const saved = await waitFor(async () => {
        const all = successful(await api.getProjects(), 'get-projects');
        return all.find(project => project.id === cleanup.projectId && project.commands[0]?.startsWith('codex')) || null;
      }, '拖动排序没有持久化');
      assert(saved.commands[1] === command, '排序后第二条命令丢失');
      await waitFor(() => !element('#projectModal').classList.contains('show'), '保存后编辑界面没有关闭');
      return { order: saved.commands };
    });

    await check('前端没有错误弹窗或未处理异常', async () => {
      assert(!document.querySelector('[role="alertdialog"]'), '前端显示致命错误弹窗');
      assert(report.errors.length === 0, `前端出现异常：${JSON.stringify(report.errors)}`);
    });
  } catch (error) {
    report.errors.push({ type: 'desktop-smoke', message: error.message, stack: error.stack });
  } finally {
    if (eventDisposer) eventDisposer();
    const cleanupActions = [
      ['清理测试计划', async () => { if (cleanup.scheduleId) successful(await api.deleteSchedule(cleanup.scheduleId), 'cleanup-schedule'); }],
      ['清理测试项目', async () => { if (cleanup.projectId) successful(await api.deleteProject(cleanup.projectId), 'cleanup-project'); }],
      ['恢复项目顺序', async () => { if (cleanup.originalIds) successful(await api.reorderProjects(cleanup.originalIds), 'cleanup-order'); }],
      ['恢复语言设置', async () => { if (typeof cleanup.locale === 'string' && cleanup.locale) successful(await api.setLocale(cleanup.locale), 'cleanup-locale'); }],
      ['恢复快捷键设置', async () => { if (typeof cleanup.shortcut === 'string') successful(await api.setGlobalShortcut(cleanup.shortcut), 'cleanup-shortcut'); }],
    ];
    for (const [name, action] of cleanupActions) {
      try { await check(name, action); } catch (error) { report.errors.push({ type: 'cleanup', message: error.message }); }
    }
    report.performance.totalMs = performance.now() - startedAt;
    report.performance.navigation = performance.getEntriesByType('navigation').map(entry => ({ domContentLoadedMs: entry.domContentLoadedEventEnd, loadMs: entry.loadEventEnd }));
    window.removeEventListener('error', recordError);
    window.removeEventListener('unhandledrejection', recordError);
    window.__desktopSmokeReport = report;
    await api.invoke('test-report', report);
  }
})();
