(async () => {
  const api = window.electronAPI;
  const report = { passed: 0, failed: 0, checks: [], errors: [], performance: {} };
  let project;
  let originalAutostart;
  const directory = '/Users/nixy/.tools/start-everything-new-20261019/.work';
  const marker = `${directory}/terminal-smoke-output.txt`;
  function assert(condition, message) { if (!condition) throw new Error(message); }
  function success(result) { assert(result.success, JSON.stringify(result)); return result.data; }
  async function check(name, callback) {
    try { await callback(); report.passed++; report.checks.push({ name, passed: true }); }
    catch (error) { report.failed++; report.checks.push({ name, passed: false, error: error.message }); throw error; }
  }
  try {
    await check('原生自动启动设置与恢复', async () => {
      originalAutostart = await api.getAutoLaunch();
      assert(typeof originalAutostart === 'boolean', '自动启动状态类型错误');
      success(await api.setAutoLaunch(!originalAutostart));
      assert(await api.getAutoLaunch() === !originalAutostart, '自动启动设置没有生效');
      success(await api.setAutoLaunch(originalAutostart));
      assert(await api.getAutoLaunch() === originalAutostart, '自动启动没有恢复');
    });
    await check('真实 Terminal 启动并写入输出文件', async () => {
      const command = `printf 'terminal-real-output' > '${marker}'; exit`;
      project = success(await api.addProject({ name: `Native regression ${Date.now()}`, path: directory, commands: [command] }));
      success(await api.executeCommand(directory, command, project.name, 'terminal-regression'));
      const deadline = Date.now() + 15000;
      while (!(await api.checkPathType(marker)).exists) {
        if (Date.now() > deadline) throw new Error('Terminal 没有生成输出文件');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    });
    await check('原生窗口最小化调用', async () => { success(await api.minimizeWindow()); });
  } catch (error) {
    report.errors.push({ message: error.message, stack: error.stack });
  } finally {
    if (typeof originalAutostart === 'boolean') await api.setAutoLaunch(originalAutostart);
    if (project) await api.deleteProject(project.id);
    await api.invoke('test-report', report);
  }
})();
