const cron = require('node-cron');
const { spawn } = require('child_process');
const { Notification, app } = require('electron');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getLogger, withTrace } = require('./logger');

const MAX_STDOUT = 10 * 1024; // 10KB

class Scheduler {
  constructor(store, getMainWindow) {
    this.store = store;
    this.getMainWindow = getMainWindow;
    this.jobs = new Map();           // scheduleId → cron task
    this.runningProcesses = new Map(); // scheduleId → child process
  }

  init() {
    const schedules = this.store.getAllSchedules();
    for (const schedule of schedules) {
      if (schedule.enabled) {
        this._startJob(schedule);
      }
    }
    getLogger().info({
      event: 'system_started',
      status: 'success',
      active_schedules: this.jobs.size,
    }, 'Scheduler initialized');
  }

  shutdown() {
    for (const [id, job] of this.jobs) {
      job.stop();
    }
    this.jobs.clear();
    for (const [id, proc] of this.runningProcesses) {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
    this.runningProcesses.clear();
    getLogger().info({
      event: 'system_stopped',
      status: 'success',
    }, 'Scheduler shutdown complete');
  }

  addSchedule(data) {
    const schedule = this.store.addSchedule(data);
    if (schedule.enabled) {
      this._startJob(schedule);
    }
    return schedule;
  }

  updateSchedule(id, updates) {
    // Stop existing job first
    this._stopJob(id);
    const schedule = this.store.updateSchedule(id, updates);
    if (schedule.enabled) {
      this._startJob(schedule);
    }
    return schedule;
  }

  removeSchedule(id) {
    this._stopJob(id);
    // Kill running process if any
    const proc = this.runningProcesses.get(id);
    if (proc) {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      this.runningProcesses.delete(id);
    }
    return this.store.deleteSchedule(id);
  }

  toggleSchedule(id, enabled) {
    this._stopJob(id);
    const schedule = this.store.updateSchedule(id, { enabled });
    if (enabled) {
      this._startJob(schedule);
    }
    return schedule;
  }

  removeSchedulesByProject(projectId) {
    const schedules = this.store.getAllSchedules().filter(s => s.projectId === projectId);
    for (const s of schedules) {
      this._stopJob(s.id);
      const proc = this.runningProcesses.get(s.id);
      if (proc) {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        this.runningProcesses.delete(s.id);
      }
    }
    return this.store.deleteSchedulesByProject(projectId);
  }

  _startJob(schedule) {
    if (!cron.validate(schedule.cronExpression)) {
      getLogger().error({
        event: 'error_occurred',
        status: 'failed',
        decision_reason: 'invalid_cron_expression',
        schedule_id: schedule.id,
        cron_expression: schedule.cronExpression,
      }, 'Invalid cron expression, job not started');
      return;
    }
    const task = cron.schedule(schedule.cronExpression, () => {
      this._executeCommand(schedule);
    });
    this.jobs.set(schedule.id, task);
  }

  _stopJob(id) {
    const job = this.jobs.get(id);
    if (job) {
      job.stop();
      this.jobs.delete(id);
    }
  }

  _executeCommand(schedule) {
    // 防并发：同一 schedule 正在运行则跳过
    if (this.runningProcesses.has(schedule.id)) {
      getLogger().warn({
        event: 'job_started',
        status: 'skipped',
        decision_reason: 'job_already_running',
        schedule_id: schedule.id,
        project_name: schedule.projectName,
      }, 'Skipping job: already running');
      return;
    }

    // Reload schedule to get latest data
    const current = this.store.getAllSchedules().find(s => s.id === schedule.id);
    if (!current || !current.enabled) return;

    // 生成本次执行的 trace_id
    const traceId = uuidv4();
    const log = withTrace(traceId);
    const startTime = new Date().toISOString();
    let stdout = '';
    let stderr = '';

    // 空路径回退到桌面
    const workDir = (current.projectPath && fs.existsSync(current.projectPath))
      ? current.projectPath
      : app.getPath('desktop');

    // 使用用户默认 shell 并加载 RC 文件以获取完整 PATH（与静默执行一致）
    const userShell = process.env.SHELL || '/bin/zsh';
    const home = process.env.HOME || '';
    let rcFile = '';
    if (userShell.endsWith('/zsh')) rcFile = `${home}/.zshrc`;
    else if (userShell.endsWith('/bash')) rcFile = `${home}/.bashrc`;
    else if (userShell.endsWith('/fish')) rcFile = `${home}/.config/fish/config.fish`;

    const escapedWorkDir = workDir.replace(/'/g, "'\\''");
    const sourceCmd = rcFile ? `[ -f "${rcFile}" ] && . "${rcFile}" 2>/dev/null; ` : '';
    const fullCmd = `${sourceCmd}cd '${escapedWorkDir}' && ${current.command}`;

    log.info({
      event: 'job_started',
      status: 'running',
      schedule_id: current.id,
      project_name: current.projectName,
      command_name: current.commandName,
      cron_expression: current.cronExpression,
      work_dir: workDir,
      trigger: 'scheduled',
    }, 'Scheduled job started');

    const proc = spawn(userShell, ['-l', '-c', fullCmd], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    });

    this.runningProcesses.set(schedule.id, proc);

    proc.stdout.on('data', (data) => {
      if (stdout.length < MAX_STDOUT) {
        stdout += data.toString();
        if (stdout.length > MAX_STDOUT) stdout = stdout.slice(0, MAX_STDOUT);
      }
    });

    proc.stderr.on('data', (data) => {
      if (stderr.length < MAX_STDOUT) {
        stderr += data.toString();
        if (stderr.length > MAX_STDOUT) stderr = stderr.slice(0, MAX_STDOUT);
      }
    });

    // 超时机制
    const timeoutMs = (current.timeoutMinutes || 60) * 60 * 1000;
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }, 5000);
    }, timeoutMs);

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      this.runningProcesses.delete(schedule.id);

      const endTime = new Date().toISOString();
      const durationMs = new Date(endTime) - new Date(startTime);
      let status = 'success';
      if (signal === 'SIGTERM' || signal === 'SIGKILL') status = 'timeout';
      else if (code !== 0) status = 'failed';

      const eventName = status === 'success' ? 'job_succeeded' : 'job_failed';
      log[status === 'success' ? 'info' : 'error']({
        event: eventName,
        status,
        schedule_id: current.id,
        project_name: current.projectName,
        command_name: current.commandName,
        exit_code: code,
        signal,
        latency_ms: durationMs,
        trigger: 'scheduled',
        ...(status !== 'success' && {
          decision_reason: signal ? 'process_timeout' : 'non_zero_exit_code',
        }),
      }, `Scheduled job ${status}`);

      this._onComplete(current, {
        startTime, endTime, durationMs, exitCode: code, stdout, stderr, status,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      this.runningProcesses.delete(schedule.id);

      const endTime = new Date().toISOString();
      const durationMs = new Date(endTime) - new Date(startTime);

      log.error({
        event: 'job_failed',
        status: 'error',
        decision_reason: 'spawn_error',
        schedule_id: current.id,
        project_name: current.projectName,
        command_name: current.commandName,
        error: err.message,
        latency_ms: durationMs,
        trigger: 'scheduled',
      }, 'Scheduled job spawn error');

      this._onComplete(current, {
        startTime, endTime, durationMs, exitCode: -1,
        stdout, stderr: err.message, status: 'error',
      });
    });
  }

  _onComplete(schedule, result) {
    // 写日志
    this.store.addScheduleLog({
      scheduleId: schedule.id,
      projectName: schedule.projectName,
      commandName: schedule.commandName || '',
      command: schedule.command,
      startTime: result.startTime,
      endTime: result.endTime,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
      trigger: 'scheduled',
      mode: 'silent',
    });

    // 更新 schedule meta
    this.store.updateScheduleMeta(schedule.id, {
      lastRunAt: result.endTime,
      lastExitCode: result.exitCode,
    });

    // 系统通知
    if (schedule.notifyOnComplete) {
      const statusText = result.status === 'success' ? 'completed' : result.status;
      try {
        new Notification({
          title: `Schedule: ${schedule.projectName}`,
          body: `${schedule.commandName || schedule.command} — ${statusText} (${Math.round(result.durationMs / 1000)}s)`,
        }).show();
      } catch { /* ignore notification errors */ }
    }

    // 通知渲染进程刷新
    const win = this.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('schedule-executed', {
        scheduleId: schedule.id,
        status: result.status,
      });
    }
  }
}

module.exports = Scheduler;
