(async () => {
  const api = window.electronAPI;
  const report = { passed: 0, failed: 0, checks: [], errors: [], performance: {} };
  const directory = '/Users/nixy/.tools/start-everything-new-20261019/.work';
  let project;
  let schedule;
  function assert(condition, message) { if (!condition) throw new Error(message); }
  function data(result) { assert(result.success, JSON.stringify(result)); return result.data; }
  async function waitFor(predicate, message, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(message);
  }
  async function check(name, callback) {
    const start = performance.now();
    try {
      const details = await callback();
      report.checks.push({ name, passed: true, durationMs: performance.now() - start, details });
      report.passed++;
    } catch (error) {
      report.checks.push({ name, passed: false, error: error.message });
      report.failed++;
      throw error;
    }
  }
  try {
    await check('真实 Cron 触发并完成持续超过一秒的命令', async () => {
      const command = "sleep 1.2; printf 'scheduled-real-output'";
      project = data(await api.addProject({ name: `Schedule regression ${Date.now()}`, path: directory, commands: [command], command_modes: ['silent'] }));
      schedule = data(await api.addSchedule({ projectId: project.id, projectPath: directory, projectName: project.name, commandIndex: 0, command, commandName: 'Schedule regression', cronExpression: '* * * * * *', enabled: true, timeoutMinutes: 1, notifyOnComplete: false }));
      const log = await waitFor(async () => data(await api.getScheduleLogs({ scheduleId: schedule.id })).logs.find(log => log.status === 'success'), 'Cron 没有执行成功');
      data(await api.toggleSchedule(schedule.id, false));
      assert(log.stdout === 'scheduled-real-output', 'Cron 输出不匹配');
      assert(log.trigger === 'scheduled' && log.mode === 'silent', 'Cron 日志字段不兼容');
      const stored = data(await api.getScheduleForCommand(project.id, 0));
      assert(stored.lastRunAt && stored.lastExitCode === 0, 'Cron 状态没有保存');
      return { durationMs: log.durationMs, stdout: log.stdout };
    });
    await check('禁用真实运行计划后终止子进程', async () => {
      data(await api.updateProject(project.id, { commands: ["sleep 20; printf 'should-not-complete'"] }));
      data(await api.toggleSchedule(schedule.id, true));
      await new Promise(resolve => setTimeout(resolve, 1400));
      data(await api.toggleSchedule(schedule.id, false));
      const log = await waitFor(async () => data(await api.getScheduleLogs({ scheduleId: schedule.id })).logs.find(log => log.status === 'cancelled'), '禁用计划没有终止运行');
      assert(log.stdout === '', '取消后的命令继续产生输出');
      return { durationMs: log.durationMs, status: log.status };
    });
  } catch (error) {
    report.errors.push({ message: error.message, stack: error.stack });
  } finally {
    if (schedule) await api.deleteSchedule(schedule.id);
    if (project) await api.deleteProject(project.id);
    await api.invoke('test-report', report);
  }
})();
